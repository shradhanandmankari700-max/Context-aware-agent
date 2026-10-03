import {
  RetrievalHit,
  type AppMetadata,
  type MetadataStore,
  type RequestContext,
  type RetrievalKind,
} from "@cab/contracts";
import type { Pool, QueryResultRow } from "pg";
import { buildMetadataDocuments, metadataNodeId, type MetadataDocument } from "../metadata/documents";
import { normalizeEmbedding, type TextEmbedder } from "./embed";

interface IndexedRow extends QueryResultRow {
  kind: RetrievalKind;
  id: string;
  page_id: string | null;
  widget_id: string | null;
  name: string;
  path: string;
  description: string;
}

interface GraphEdgeRow extends QueryResultRow {
  src_kind: string;
  src_id: string;
  rel: string;
  dst_kind: string;
  dst_id: string;
}

interface RankedDocument {
  row: IndexedRow;
  score: number;
}

type SearchOptions = NonNullable<Parameters<MetadataStore["search"]>[2]>;

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => (Object.is(value, -0) ? "0" : String(value))).join(",")}]`;
}

function documentKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

export function reciprocalRankFuse(rankings: IndexedRow[][], offset = 60): Map<string, RankedDocument> {
  const fused = new Map<string, RankedDocument>();
  for (const rows of rankings) {
    rows.forEach((row, index) => {
      const key = documentKey(row.kind, row.id);
      const previous = fused.get(key);
      const score = 1 / (offset + index + 1);
      fused.set(key, { row, score: (previous?.score ?? 0) + score });
    });
  }
  return fused;
}

function documentForRow(row: IndexedRow, documents: Map<string, MetadataDocument>): MetadataDocument | undefined {
  return documents.get(documentKey(row.kind, row.id));
}

function createAdjacency(edges: GraphEdgeRow[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    adjacency.set(from, (adjacency.get(from) ?? new Set()).add(to));
    adjacency.set(to, (adjacency.get(to) ?? new Set()).add(from));
  };
  for (const edge of edges) {
    if (
      (edge.rel === "contains" && edge.src_kind === "page" && ["widget", "filter"].includes(edge.dst_kind)) ||
      (edge.rel === "supports" && edge.src_kind === "field" && edge.dst_kind === "filter") ||
      (edge.rel === "filters" && edge.src_kind === "filter" && edge.dst_kind === "widget")
    ) {
      add(metadataNodeId(edge.src_kind as RetrievalKind, edge.src_id), metadataNodeId(edge.dst_kind as RetrievalKind, edge.dst_id));
    }
  }
  return adjacency;
}

function expandGraph(
  seeds: Map<string, RankedDocument>,
  adjacency: Map<string, Set<string>>,
  documents: Map<string, MetadataDocument>,
  allowedKinds: Set<RetrievalKind> | undefined,
): Map<string, RankedDocument> {
  const expanded = new Map(seeds);
  const queue = [...seeds.values()].map(({ row, score }) => ({
    node: metadataNodeId(row.kind, row.id),
    score,
    depth: 0,
  }));
  const seen = new Map(queue.map((item) => [item.node, item.score]));

  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= 3) continue;
    for (const neighbor of adjacency.get(current.node) ?? []) {
      const score = current.score * 0.72;
      if (score <= (seen.get(neighbor) ?? 0)) continue;
      seen.set(neighbor, score);
      const separator = neighbor.indexOf(":");
      const kind = neighbor.slice(0, separator) as RetrievalKind;
      if (allowedKinds && !allowedKinds.has(kind)) continue;

      const id = neighbor.slice(separator + 1);
      const document = documents.get(documentKey(kind, id));
      if (!document) continue;
      const row: IndexedRow = {
        kind,
        id: document.id,
        page_id: document.pageId ?? null,
        widget_id: document.widgetId ?? null,
        name: document.name,
        path: document.path,
        description: document.description,
      };
      const key = documentKey(kind, id);
      const previous = expanded.get(key);
      if (!previous || previous.score < score) expanded.set(key, { row, score });
      queue.push({ node: neighbor, score, depth: current.depth + 1 });
    }
  }
  return expanded;
}

export async function searchMetadata(
  pool: Pool,
  embedTexts: TextEmbedder,
  ctx: RequestContext,
  app: AppMetadata,
  query: string,
  options: SearchOptions = {},
): Promise<RetrievalHit[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const queryTerms = normalizedQuery.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!queryTerms.length) return [];
  const k = Math.max(1, Math.min(20, Math.trunc(options.k ?? 8)));
  const [queryVector] = await embedTexts([normalizedQuery]);
  if (!queryVector) throw new Error("Embedding provider returned no vector for the search query");
  const vector = vectorLiteral(normalizeEmbedding(queryVector, "Search query embedding"));
  const fullTextQuery = queryTerms
    .slice(0, 64)
    .map((term) => `${term}:*`)
    .join(" | ");
  const hasDateIntent = /\b(today|tomorrow|tonight|yesterday|date|dates|night|overnight|this week|this month|last month)\b/i.test(normalizedQuery);
  const hasNumericComparison = /\d/.test(normalizedQuery) &&
    /\b(under|below|above|over|less than|greater than|at most|at least|cheaper|expensive|between)\b/i.test(normalizedQuery);
  const queryWords = new Set(queryTerms.map((term) => term.toLowerCase()));
  const take = Math.min(100, Math.max(20, k * 4));
  const kinds = options.kinds?.length ? options.kinds : null;
  const [vectorRows, textRows, edgeRows] = await Promise.all([
    pool.query<IndexedRow>(
      `SELECT kind, id, page_id, widget_id, name, path, description
       FROM metadata_embeddings
       WHERE app_id = $1 AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [ctx.appId, vector, kinds, take],
    ),
    pool.query<IndexedRow>(
      `SELECT kind, id, page_id, widget_id, name, path, description
       FROM metadata_embeddings
       WHERE app_id = $1 AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
        AND tsv @@ to_tsquery('english', $2)
      ORDER BY ts_rank_cd(tsv, to_tsquery('english', $2)) DESC
       LIMIT $4`,
      [ctx.appId, fullTextQuery, kinds, take],
    ),
    pool.query<GraphEdgeRow>(
      "SELECT src_kind, src_id, rel, dst_kind, dst_id FROM graph_edges WHERE app_id = $1",
      [ctx.appId],
    ),
  ]);

  const docs = new Map(buildMetadataDocuments(app).map((document) => [
    documentKey(document.kind, document.id),
    document,
  ]));
  const allowedKinds = options.kinds?.length ? new Set(options.kinds) : undefined;
  const expanded = expandGraph(
    reciprocalRankFuse([vectorRows.rows, textRows.rows]),
    createAdjacency(edgeRows.rows),
    docs,
    allowedKinds,
  );
  const pageSupportScores = new Map<string, number>();
  for (const { row, score } of expanded.values()) {
    if (row.kind === "page" || !row.page_id) continue;
    pageSupportScores.set(row.page_id, Math.max(pageSupportScores.get(row.page_id) ?? 0, score));
  }

  return [...expanded.values()]
    .map(({ row, score }) => {
      const document = documentForRow(row, docs);
      if (!document) return undefined;
      const page = row.page_id ? app.pages.find((candidate) => candidate.id === row.page_id) : undefined;
      const filter = row.kind === "filter" && page
        ? page.filters.find((candidate) => candidate.id === row.id || `${page.id}.${candidate.id}` === row.id)
        : undefined;
      let rerankedScore = score;
      if (row.kind === "page") {
        rerankedScore = Math.max(rerankedScore, (pageSupportScores.get(row.id) ?? 0) * 1.05);
        const pageNameWords = row.name.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
        if (pageNameWords.some((word) => queryWords.has(word))) rerankedScore *= 2.1;
      }
      if (filter?.type === "date" || filter?.type === "dateRange") {
        if (hasDateIntent) rerankedScore *= 1.5;
      }
      if (filter?.type === "number" && hasNumericComparison) rerankedScore *= 2;
      const publicId = row.kind === "filter" && page
        ? page.filters.find((filter) => document.id === `${page.id}.${filter.id}` || document.id === filter.id)?.id ?? row.id
        : row.id;
      const boosted = row.page_id === options.currentPageId ? rerankedScore * 1.08 : rerankedScore;
      return RetrievalHit.parse({
        kind: row.kind,
        id: publicId,
        pageId: row.page_id ?? undefined,
        widgetId: row.widget_id ?? undefined,
        name: row.name,
        path: row.path,
        description: row.description,
        score: boosted,
      });
    })
    .filter((hit): hit is RetrievalHit => hit !== undefined)
    .sort((left, right) => right.score - left.score)
    .slice(0, k);
}
