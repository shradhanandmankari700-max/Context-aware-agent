import { pathToFileURL } from "node:url";
import { buildSampleKpiReport, writeLatestReport } from "./report.js";

export function runEval() {
  const report = buildSampleKpiReport();
  const path = writeLatestReport(report);
  console.log(`[eval] wrote ${path}`);
  console.log(JSON.stringify({ runId: report.runId, mrr: report.kpis.retrieval.mrr, invalidActionsExecuted: report.kpis.safety.invalidActionsExecuted }, null, 2));
  return report;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runEval();
}
