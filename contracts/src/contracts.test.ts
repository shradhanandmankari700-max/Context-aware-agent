import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { AppMetadata, validateAppMetadata, toDeepLink, fromDeepLink, diffUiState, emptyUiState, resolveDateToken, normalizeDateValue, ToolCall, AgentTurn, EvalCase } from "./index";

const load = (n: string) => JSON.parse(readFileSync(new URL(`../../metadata/${n}.json`, import.meta.url), "utf8"));

describe("metadata fixtures", () => {
  for (const n of ["hospital", "hotel"]) {
    it(`${n}.json is valid`, () => {
      const p = AppMetadata.parse(load(n));
      expect(validateAppMetadata(p)).toEqual([]);
    });
  }
  it("catches a bad reference", () => {
    const p = AppMetadata.parse(load("hospital"));
    p.pages[4].filters[0].field = "nope";
    expect(validateAppMetadata(p).length).toBeGreaterThan(0);
  });
});

describe("deep links", () => {
  it("round-trips filters + sort", () => {
    const s = { filters: { stockLevel: { op: "eq", value: "low" }, daysRemaining: { op: "lte", value: 2 }, admittedOn: { op: "between", value: ["2026-10-01", "2026-10-07"] }, ward: { op: "in", value: ["ICU", "General|X"] } }, sort: { widgetId: "medicineStock", field: "stock", direction: "asc" } } as const;
    const url = toDeepLink("/inventory/medicines", s as any);
    const back = fromDeepLink(url);
    expect(back.route).toBe("/inventory/medicines");
    expect(back.filters).toEqual(s.filters);
    expect(back.sort).toEqual(s.sort);
  });
});

describe("dates (now = 2026-10-07, a Wednesday)", () => {
  const now = "2026-10-07";
  it("tokens", () => {
    expect(resolveDateToken("tomorrow", now)).toEqual({ start: "2026-10-08", end: "2026-10-08" });
    expect(resolveDateToken("this_week", now)).toEqual({ start: "2026-10-05", end: "2026-10-11" });
    expect(resolveDateToken("this_month", now)).toEqual({ start: "2026-10-01", end: "2026-10-07" });
    expect(resolveDateToken("last_month", now)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(resolveDateToken("last_month_to_date", now)).toEqual({ start: "2026-09-01", end: "2026-09-07" });
    expect(resolveDateToken("last_quarter", now)).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(resolveDateToken("last_7_days", now)).toEqual({ start: "2026-10-01", end: "2026-10-07" });
  });
  it("normalizes", () => {
    expect(normalizeDateValue("eq", "tomorrow", now)).toEqual({ op: "eq", value: "2026-10-08" });
    expect(normalizeDateValue("eq", "last_month", now)).toEqual({ op: "between", value: ["2026-09-01", "2026-09-30"] });
    expect(normalizeDateValue("lt", 3000, now)).toEqual({ op: "lt", value: 3000 });
  });
});

describe("ui state diff", () => {
  it("detects mismatch and match", () => {
    const st = { ...emptyUiState("hospital", "medicines", "/inventory/medicines"), filters: { stockLevel: { op: "eq", value: "low" } } } as any;
    expect(diffUiState({ pageId: "medicines", filters: { stockLevel: { op: "eq", value: "low" } } }, st)).toEqual([]);
    expect(diffUiState({ filters: { stockLevel: { op: "eq", value: "high" } } }, st)).toHaveLength(1);
  });
});

describe("tool calls", () => {
  it("accepts valid, rejects invented tools", () => {
    expect(ToolCall.safeParse({ tool: "set_filter", args: { filterId: "stockLevel", value: "low" } }).success).toBe(true);
    expect(ToolCall.safeParse({ tool: "run_sql", args: { sql: "DROP TABLE x" } }).success).toBe(false);
    expect(AgentTurn.safeParse({ intent: "x", reasoning: "y", steps: [{ tool: "navigate", args: { target: "medicines" } }], done: false }).success).toBe(true);
  });
  it("eval case", () => {
    expect(EvalCase.safeParse({ id: "t1", appId: "hospital", kind: "operate", utterance: "show low stock", gold: { pageId: "medicines", filters: { stockLevel: { op: "eq", value: "low" } } } }).success).toBe(true);
  });
});
