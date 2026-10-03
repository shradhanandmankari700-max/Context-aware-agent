import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalEmbedder, DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSION, normalizeEmbedding } from "./embed";
import { reciprocalRankFuse, searchMetadata } from "./search";
import { buildMetadataDocuments } from "../metadata/documents";
import { AppMetadata, type RetrievalKind, type RequestContext } from "@cab/contracts";
import type { Pool } from "pg";
import hospitalFixture from "../../../metadata/hospital.json";
import hotelFixture from "../../../metadata/hotel.json";
import { createFakeRetriever } from "./fake";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local metadata embeddings", () => {
  it("loads MiniLM lazily once, batches input, and returns normalized 384-dimensional vectors", async () => {
    const loadPipeline = vi.fn(async (model: string, cacheDir: string) => {
      expect(model).toBe(DEFAULT_EMBEDDING_MODEL);
      expect(cacheDir).toContain(".model-cache");
      return async (texts: string[]) => texts.map((_, index) => {
        const vector = new Array(EMBEDDING_DIMENSION).fill(0);
        vector[index % EMBEDDING_DIMENSION] = 3;
        vector[(index + 1) % EMBEDDING_DIMENSION] = 4;
        return vector;
      });
    });
    const embed = createLocalEmbedder({ batchSize: 2, loadPipeline });

    const result = await embed(["page", "filter", "field"]);
    expect(loadPipeline).toHaveBeenCalledOnce();
    expect(loadPipeline.mock.calls[0]?.[0]).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(EMBEDDING_DIMENSION);
    expect(Math.sqrt(result[0]!.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1);
    expect(Math.sqrt(result[2]!.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1);
  });

  it("does not initialize the model for an empty batch", async () => {
    const loadPipeline = vi.fn();
    const embed = createLocalEmbedder({ loadPipeline });
    await expect(embed([])).resolves.toEqual([]);
    expect(loadPipeline).not.toHaveBeenCalled();
  });

  it("rejects zero vectors and malformed model output", async () => {
    expect(() => normalizeEmbedding(new Array(EMBEDDING_DIMENSION).fill(0))).toThrow("zero");
    const embed = createLocalEmbedder({
      loadPipeline: async () => async () => [[1, 2]],
    });
    await expect(embed(["invalid"])).rejects.toThrow("invalid batch");
  });
});

describe("reciprocal rank fusion", () => {
  it("combines ranks from independent retrievers, rewarding documents present in both", () => {
    const row = (id: string) => ({
      kind: "page" as RetrievalKind,
      id,
      page_id: id,
      widget_id: null,
      name: id,
      path: id,
      description: "",
    });
    const fused = reciprocalRankFuse([[row("shared"), row("vector-only")], [row("shared"), row("text-only")]]);

    expect(fused.get("page\u0000shared")?.score).toBeCloseTo(2 / 61);
    expect(fused.get("page\u0000vector-only")?.score).toBeCloseTo(1 / 62);
    expect(fused.get("page\u0000text-only")?.score).toBeCloseTo(1 / 62);
  });
});

describe("fake retriever", () => {
  it("uses imported metadata vocabulary without application-specific logic", async () => {
    const app = AppMetadata.parse(hospitalFixture);
    const retriever = createFakeRetriever(app, "tenant-a");
    const ctx: RequestContext = {
      tenantId: "tenant-a",
      appId: app.appId,
      userId: "user-1",
      role: "staff",
      sessionId: "session-123",
      traceId: "trace-123",
      now: "2026-10-07",
    };

    const hits = await retriever.search(ctx, "running low", { k: 5 });
    expect(hits.some((hit) => hit.kind === "filter" && hit.id === "stockLevel")).toBe(true);
    const context = await retriever.buildContext(ctx, hits, "medicines");
    expect(context.pages.some((page) => page.id === "medicines")).toBe(true);
  });
});

describe("hybrid metadata search", () => {
  it("returns the rooms page, price filter, and stay-date filter in the top three", async () => {
    const app = AppMetadata.parse(hotelFixture);
    const stayDateDocument = buildMetadataDocuments(app).find((document) =>
      document.kind === "filter" && document.id === "stayDate");
    expect(stayDateDocument?.doc).toContain("tomorrow");
    const priceDocument = buildMetadataDocuments(app).find((document) =>
      document.kind === "filter" && document.id === "price");
    expect(priceDocument?.doc).toContain("cheaper");

    const rooms = app.pages.find((page) => page.id === "rooms")!;
    const indexedRows = [
      {
        kind: "page",
        id: rooms.id,
        page_id: rooms.id,
        widget_id: null,
        name: rooms.name,
        path: rooms.name,
        description: rooms.description,
      },
      ...["price", "stayDate"].map((id) => {
        const filter = rooms.filters.find((item) => item.id === id)!;
        return {
          kind: "filter",
          id: filter.id,
          page_id: rooms.id,
          widget_id: null,
          name: filter.label,
          path: `${rooms.name} > ${filter.label}`,
          description: filter.description,
        };
      }),
    ];
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async query(sql: string, values: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("ORDER BY embedding")) return { rows: indexedRows, rowCount: indexedRows.length };
        if (sql.includes("FROM graph_edges")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const ctx: RequestContext = {
      tenantId: "tenant-b",
      appId: app.appId,
      userId: "user-1",
      role: "staff",
      sessionId: "session-123",
      traceId: "trace-123",
      now: "2026-10-07",
    };
    const hits = await searchMetadata(
      pool,
      async () => [new Array(EMBEDDING_DIMENSION).fill(1)],
      ctx,
      app,
      "rooms cheaper than 3000 tomorrow",
      { k: 3 },
    );

    expect(hits.map((hit) => hit.id)).toEqual(["rooms", "price", "stayDate"]);
    expect(calls.every(({ values }) => values[0] === "hotel")).toBe(true);
  });
});
