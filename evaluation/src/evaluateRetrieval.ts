import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { RetrievalCase, type RetrievalCase as RetrievalCaseType } from "@cab/contracts";
import { loadBackendEnvironment } from "../../backend/src/loadEnv";
import { createFakeLlmClient } from "../../backend/src/llm/fake";
import { createMetadataStore } from "../../backend/src/metadata";

interface CaseScores {
  precisionAt1: number;
  recallAt5: number;
  reciprocalRank: number;
}

loadBackendEnvironment();

function scoreCase(goldIds: string[], resultIds: string[]): CaseScores {
  const gold = new Set(goldIds);
  const firstRelevant = resultIds.findIndex((id) => gold.has(id));
  const retrievedRelevant = new Set(resultIds.slice(0, 5).filter((id) => gold.has(id)));
  return {
    precisionAt1: resultIds[0] && gold.has(resultIds[0]) ? 1 : 0,
    recallAt5: retrievedRelevant.size / gold.size,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
  };
}

function average<T extends keyof CaseScores>(scores: CaseScores[], key: T): number {
  return scores.reduce((sum, score) => sum + score[key], 0) / scores.length;
}

function summarize(cases: RetrievalCaseType[], scores: CaseScores[]) {
  return {
    cases: cases.length,
    precisionAt1: average(scores, "precisionAt1"),
    recallAt5: average(scores, "recallAt5"),
    mrr: average(scores, "reciprocalRank"),
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set to evaluate retrieval.");

  const corpusFile = path.resolve(process.cwd(), "corpus", "retrieval.jsonl");
  const lines = (await readFile(corpusFile, "utf8")).split(/\r?\n/u).filter((line) => line.trim());
  const cases = lines.map((line, index) => {
    try {
      return RetrievalCase.parse(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`Invalid retrieval corpus line ${index + 1}: ${String(error)}`);
    }
  });
  if (!cases.length) throw new Error(`Retrieval corpus is empty: ${corpusFile}`);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const metadata = createMetadataStore({ pool, llm: createFakeLlmClient() });
    const allScores: CaseScores[] = [];
    const byApp: Record<string, ReturnType<typeof summarize>> = {};
    const manualByApp: Record<string, ReturnType<typeof summarize>> = {};
    const failures: Array<{ id: string; query: string; goldIds: string[]; retrievedIds: string[] }> = [];
    const appCases = new Map<string, RetrievalCaseType[]>();
    for (const item of cases) appCases.set(item.appId, [...(appCases.get(item.appId) ?? []), item]);

    for (const [appId, items] of appCases) {
      const tenantId = appId === "hospital" ? "tenant-a" : appId === "hotel" ? "tenant-b" : `tenant-${appId}`;
      const appScores: CaseScores[] = [];
      for (const item of items) {
        const hits = await metadata.search({
          tenantId,
          appId,
          userId: "retrieval-evaluation",
          role: "admin",
          sessionId: "retrieval-evaluation",
          traceId: item.id,
          now: "2026-10-07",
        }, item.query, { k: 5 });
        const retrievedIds = hits.map((hit) => hit.id);
        const score = scoreCase(item.goldIds, retrievedIds);
        appScores.push(score);
        allScores.push(score);
        if (!score.reciprocalRank) failures.push({ id: item.id, query: item.query, goldIds: item.goldIds, retrievedIds });
      }
      byApp[appId] = summarize(items, appScores);
      const manualCases = items
        .map((item, index) => ({ item, score: appScores[index]! }))
        .filter(({ item }) => item.id.startsWith("manual-"));
      manualByApp[appId] = summarize(
        manualCases.map(({ item }) => item),
        manualCases.map(({ score }) => score),
      );
    }

    const report = {
      generatedAt: new Date().toISOString(),
      corpus: path.relative(process.cwd(), corpusFile),
      metrics: {
        overall: summarize(cases, allScores),
        byApp,
        manuallyReviewedByApp: manualByApp,
      },
      failures,
    };
    const outputFile = path.resolve(process.cwd(), "results", "retrieval-latest.json");
    await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.metrics, null, 2));
    console.log(`Full report: ${outputFile}`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("[retrieval evaluation]", error);
  process.exitCode = 1;
});
