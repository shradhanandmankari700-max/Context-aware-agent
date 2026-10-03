import { KpiReport } from "@cab/contracts";
import type { KpiReport as KpiReportType } from "@cab/contracts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildSampleKpiReport(overrides: Partial<KpiReportType> = {}) {
  const now = new Date().toISOString();
  const defaultReport = {
    runId: `eval-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    commit: "local-dev",
    llm: {
      provider: "gemini",
      model: "gemini-2.0-flash",
      cache: false,
    },
    counts: {
      cases: 5,
      byKind: {
        navigate: 1,
        operate: 1,
        analyze: 1,
        multistep: 1,
        followup: 1,
      },
    },
    kpis: {
      intentToDestination: 0.95,
      uiState: {
        fieldLevel: 0.92,
        exactMatch: 0.9,
      },
      taskSuccess: {
        rate: 0.88,
        avgSteps: 2.5,
      },
      analytical: {
        numericMatch: 0.93,
        cases: 3,
      },
      faithfulness: {
        traceableClaims: 12,
        totalClaims: 12,
      },
      retrieval: {
        precisionAt1: 0.9,
        recallAt5: 0.88,
        mrr: 0.91,
        byScale: [
          { pages: 100, mrr: 0.91, recallAt5: 0.88 },
          { pages: 300, mrr: 0.88, recallAt5: 0.85 },
          { pages: 1000, mrr: 0.83, recallAt5: 0.8 },
        ],
      },
      safety: {
        invalidActionsBlocked: 5,
        invalidActionsExecuted: 0,
        adversarialPassRate: 1,
      },
      recovery: {
        attempted: 4,
        recovered: 3,
        rate: 0.75,
      },
      latencyMs: {
        p50: 2300,
        p95: 4600,
        firstActionP50: 900,
      },
      ux: {
        avgManualClicksSaved: 3.2,
      },
    },
    failures: [],
  } as const;

  return KpiReport.parse({ ...defaultReport, ...overrides });
}

export function writeLatestReport(report = buildSampleKpiReport(), destination = resolve(__dirname, "../results/latest.json")) {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return destination;
}
