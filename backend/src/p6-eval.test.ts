import { describe, expect, it } from "vitest";
import { buildSampleKpiReport } from "../../evaluation/src/report.js";

describe("P6 eval report", () => {
  it("builds a valid KpiReport with positive safety and retrieval metrics", () => {
    const report = buildSampleKpiReport();

    expect(report.runId).toMatch(/^eval-/);
    expect(report.kpis.safety.invalidActionsExecuted).toBe(0);
    expect(report.kpis.retrieval.byScale.length).toBeGreaterThanOrEqual(3);
    expect(report.kpis.retrieval.mrr).toBeGreaterThan(0.8);
    expect(report.kpis.retrieval.precisionAt1).toBeGreaterThan(0.8);
  });

  it("generates a corpus with valid eval cases for hospital and hotel apps", async () => {
    const { generateCorpus } = await import("../../evaluation/src/generateCorpus.js");
    const cases = generateCorpus();

    expect(cases.length).toBeGreaterThanOrEqual(4);
    expect(cases.some((c) => c.appId === "hospital")).toBe(true);
    expect(cases.some((c) => c.appId === "hotel")).toBe(true);
    expect(cases.every((c) => !!c.utterance)).toBe(true);
  });
});
