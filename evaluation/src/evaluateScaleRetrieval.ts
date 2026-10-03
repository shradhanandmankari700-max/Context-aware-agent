import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { RetrievalCase, type RetrievalCase as RetrievalCaseType } from "@cab/contracts";
import { loadBackendEnvironment } from "../../backend/src/loadEnv";
import { createFakeLlmClient } from "../../backend/src/llm/fake";
import { createMetadataStore } from "../../backend/src/metadata";

loadBackendEnvironment();

function score(goldIds: string[], resultIds: string[]) {
  const gold = new Set(goldIds);
  const firstRelevant = resultIds.findIndex((id) => gold.has(id));
  const relevantAtFive = new Set(resultIds.slice(0, 5).filter((id) => gold.has(id)));
  return {
    recallAt5: relevantAtFive.size / gold.size,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set to evaluate scale retrieval.");

  const corpusFile = path.resolve(process.cwd(), "corpus", "scale-retrieval.jsonl");
  const lines = (await readFile(corpusFile, "utf8")).split(/\r?\n/u).filter((line) => line.trim());
  const cases = lines.map((line, index) => {
    try {
      return RetrievalCase.parse(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`Invalid scale retrieval corpus line ${index + 1}: ${String(error)}`);
    }
  });
  if (!cases.length) throw new Error(`Scale retrieval corpus is empty: ${corpusFile}`);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const metadata = createMetadataStore({ pool, llm: createFakeLlmClient() });
    const casesByApp = new Map<string, RetrievalCaseType[]>();
    for (const item of cases) casesByApp.set(item.appId, [...(casesByApp.get(item.appId) ?? []), item]);

    const byScale = [];
    for (const [appId, appCases] of casesByApp) {
      try {
        await metadata.getApp({
          tenantId: "tenant-a",
          appId,
          userId: "scale-evaluation",
          role: "admin",
          sessionId: "scale-evaluation",
          traceId: "scale-evaluation",
          now: "2026-10-07",
        });
      } catch (error) {
        throw new Error(`Cannot load ${appId}; import it first with npm run import:app -- metadata/${appId}.json --tenant tenant-a. ${String(error)}`);
      }

      const pageCount = Number(appId.replace("scale", ""));
      const scores = [];
      for (const item of appCases) {
        const hits = await metadata.search({
          tenantId: "tenant-a",
          appId,
          userId: "scale-evaluation",
          role: "admin",
          sessionId: "scale-evaluation",
          traceId: item.id,
          now: "2026-10-07",
        }, item.query, { k: 5 });
        scores.push(score(item.goldIds, hits.map((hit) => hit.id)));
      }
      byScale.push({
        pages: pageCount,
        cases: appCases.length,
        mrr: mean(scores.map((item) => item.reciprocalRank)),
        recallAt5: mean(scores.map((item) => item.recallAt5)),
      });
    }
    byScale.sort((left, right) => left.pages - right.pages);

    const report = {
      generatedAt: new Date().toISOString(),
      corpus: path.relative(process.cwd(), corpusFile),
      relevanceUnit: "intended page destination",
      byScale,
    };
    const outputFile = path.resolve(process.cwd(), "results", "scale-retrieval-latest.json");
    await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(byScale, null, 2));
    console.log(`Full report: ${outputFile}`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("[scale retrieval evaluation]", error);
  process.exitCode = 1;
});
