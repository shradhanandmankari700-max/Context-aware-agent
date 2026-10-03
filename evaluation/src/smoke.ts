import { buildSampleKpiReport } from "./report.js";

const report = buildSampleKpiReport();
const checks = [
  { name: "intent-to-destination", ok: report.kpis.intentToDestination >= 0.9 },
  { name: "ui-state fidelity", ok: report.kpis.uiState.fieldLevel >= 0.9 },
  { name: "task success", ok: report.kpis.taskSuccess.rate >= 0.8 },
  { name: "retrieval quality", ok: report.kpis.retrieval.mrr >= 0.8 },
  { name: "safety", ok: report.kpis.safety.invalidActionsExecuted === 0 },
];

let passed = 0;
for (const check of checks) {
  const label = check.ok ? "PASS" : "FAIL";
  console.log(`${label} ${check.name}`);
  if (check.ok) passed += 1;
}

if (passed !== checks.length) {
  console.error(`Smoke failed: ${passed}/${checks.length} checks passed`);
  process.exit(1);
}

console.log(`All ${checks.length} smoke checks passed`);
