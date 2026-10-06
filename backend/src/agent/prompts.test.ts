import { describe, it, expect } from "vitest";
import { AgentTurn, NarratorOutput } from "@cab/contracts";
import { buildPlannerPrompt, buildNarratorPrompt, isDirectLowStockRequest } from "./prompts";

describe("Prompts", () => {
  const sampleRetrievalContext = {
    appId: "hospital",
    appName: "Hospital Operations",
    navTree: [
      { id: "dashboard", name: "Dashboard", route: "/dashboard", parent: null },
      { id: "medicines", name: "Medicines", route: "/inventory/medicines", parent: "inventory" },
    ],
    pages: [
      {
        id: "medicines",
        name: "Medicines",
        route: "/inventory/medicines",
        path: "Inventory > Medicines",
        description: "Medicine stock levels and usage",
        widgets: [
          {
            id: "medicineStock",
            name: "Medicine Stock",
            type: "table",
            dataset: "medicines",
            description: "Table of medicines",
            columns: [{ field: "medicine", label: "Medicine" }],
            sortable: ["medicine", "stock"],
          },
        ],
        filters: [
          {
            id: "stockLevel",
            label: "Stock level",
            type: "enum",
            field: "days_remaining",
            description: "Stock status",
            operators: ["eq" as const],
            options: [{ value: "low", label: "Low (< 5 days)" }],
          },
        ],
      },
    ],
    datasets: [
      {
        name: "medicines",
        description: "Current pharmacy stock",
        fields: [
          {
            name: "medicine",
            label: "Medicine",
            type: "string",
            description: "Name of medicine",
            derived: false,
            roles: ["key", "label"],
          },
        ],
        relations: [],
      },
    ],
    actions: [],
  };

  describe("buildPlannerPrompt", () => {
    it("builds prompt with reference clock, retrieval context, and instructions", () => {
      const { system, user } = buildPlannerPrompt({
        now: "2026-10-07",
        userMessage: "Show low-stock medicines",
        context: sampleRetrievalContext,
      });

      expect(system).toContain("Today's reference clock is fixed at 2026-10-07");
      expect(system).toContain("DateToken strings");
      expect(system).toContain("AgentTurn schema");
      expect(system).toContain('"metric" is always required');
      expect(system).toContain('"periodA"');
      expect(system).toContain('"periodB"');
      expect(system).toContain('"breakdownBy" is supported only by period_compare and trend');
      expect(system).toContain('"rank.by" is required');
      expect(system).toContain('For "Why are these medicines running low?"');
      expect(system).toContain('"kind": "trend"');
      expect(system).toContain('"kind": "rank"');
      expect(system).toContain("Include invoke_app_action only when the CURRENT user message explicitly requests that specific action");
      expect(system).toContain("Do not infer mutation intent from conversation history");

      expect(user).toContain("## REFERENCE CLOCK");
      expect(user).toContain("Today (ctx.now): 2026-10-07");
      expect(user).toContain("## CURRENT USER MESSAGE\nShow low-stock medicines");
      expect(user).toContain("## RETRIEVAL CONTEXT (APP METADATA SLICE)");
      expect(user).toContain("medicineStock");
    });

    it("includes memory, observations, and validator feedback when provided", () => {
      const { user } = buildPlannerPrompt({
        now: "2026-10-07",
        userMessage: "Filter those to under 2 days",
        uiState: {
          appId: "hospital",
          pageId: "medicines",
          route: "/inventory/medicines",
          filters: { stockLevel: { op: "eq", value: "low" } },
          sort: null,
          selection: null,
          disabledFilters: [],
          version: 1,
        },
        memory: {
          sessionId: "sess-12345678",
          appId: "hospital",
          history: [{ role: "user", text: "Show low stock" }],
          lastUiState: null,
          lastResult: {
            dataset: "medicines",
            keys: ["Amoxicillin", "Insulin"],
            description: "Low stock items",
          },
          pendingConfirmation: null,
        },
        context: sampleRetrievalContext,
        observations: [
          {
            step: 0,
            tool: "set_filter",
            result: { applied: true },
          },
        ],
        validatorErrors: [
          {
            stepIndex: 1,
            code: "FILTER_NOT_FOUND",
            message: "Filter 'stockStatus' does not exist on page 'medicines'",
            candidates: ["stockLevel"],
          },
        ],
      });

      expect(user).toContain("## CURRENT UI STATE");
      expect(user).toContain("/inventory/medicines");
      expect(user).toContain("## CONVERSATION MEMORY");
      expect(user).toContain("Amoxicillin");
      expect(user).toContain("## OBSERVATIONS FROM PREVIOUS ITERATIONS");
      expect(user).toContain("set_filter");
      expect(user).toContain("## PREVIOUS VALIDATOR ERRORS (CORRECT THESE)");
      expect(user).toContain("Candidates: stockLevel");
    });

    it("forbids sort steps on a low-stock request", () => {
      const { system } = buildPlannerPrompt({
        now: "2026-10-07",
        userMessage: "Show medicines that are running low.",
        context: sampleRetrievalContext,
      });

      expect(system).toContain("NEVER add sorting, filters, or date ranges the user did not ask for");
      expect(system).toContain("MUST NOT include \"clarification\"");
      expect(system).toContain('Do NOT also set daysRemaining or add any other threshold');
      expect(system).toContain('Use the daysRemaining filter only when the user explicitly asks for a days/time threshold');
      expect(system).not.toContain(
        '"clarification": { "question": "<non-empty string>", "options": ["..."] }, // Optional',
      );

      const badPlan = {
        intent: "Show medicines that are running low",
        reasoning: "Navigate to medicines and sort by stock descending",
        steps: [{ tool: "sort", args: { widgetId: "medicineStock", field: "stock", direction: "desc" } }],
        done: true,
      };

      expect(badPlan.steps.some((step) => step.tool === "sort")).toBe(true);
      expect(system).toContain("NEVER add sorting, filters, or date ranges the user did not ask for");
    });

    it("accepts a valid clarification with a non-empty question", () => {
      const parsed = AgentTurn.parse({
        intent: "Clarify usage period",
        reasoning: "The period is needed to answer.",
        clarification: { question: "Which date range should I use?" },
        steps: [],
        done: true,
      });

      expect(parsed.clarification?.question).toBe("Which date range should I use?");
    });

    it("rejects an empty clarification object because its question is required", () => {
      expect(() =>
        AgentTurn.parse({
          intent: "Clarify request",
          reasoning: "The request is ambiguous.",
          clarification: {},
          steps: [],
          done: true,
        }),
      ).toThrow(/clarification\.question|question/i);
    });

    it("keeps a directly actionable low-stock request on the normal plan path", () => {
      const { system } = buildPlannerPrompt({
        now: "2026-10-07",
        userMessage: "Show me the medicines that are running low.",
        context: sampleRetrievalContext,
      });
      const turn = AgentTurn.parse({
        intent: "Show medicines that are running low",
        reasoning: "Navigate to medicines and show its low-stock records.",
        steps: [{ tool: "navigate", args: { target: "medicines" } }],
        done: false,
      });

      expect(system).toContain("Directly actionable requests");
      expect(turn.clarification).toBeUndefined();
      expect(turn.steps).toHaveLength(1);
    });

    it.each([
      "Show medicines that are running low.",
      "Show me medicines that are running low.",
      "Which medicines are running low?",
    ])("classifies equivalent low-stock requests as actionable: %s", (message) => {
      expect(isDirectLowStockRequest(message)).toBe(true);
    });

    it("does not classify explicit thresholds or ambiguous revenue requests as low-stock requests", () => {
      expect(isDirectLowStockRequest("Show me the ones that may run out within two days.")).toBe(false);
      expect(isDirectLowStockRequest("Show revenue.")).toBe(false);
    });

    it("ensures expected planner output matches AgentTurn schema", () => {
      const sampleTurn = {
        intent: "Show medicines that are running low on stock",
        reasoning: "Navigate to medicines page and filter by stockLevel=low",
        steps: [
          { tool: "navigate", args: { target: "medicines" } },
          { tool: "set_filter", args: { filterId: "stockLevel", op: "eq", value: "low" } },
        ],
        done: false,
      };

      const parsed = AgentTurn.parse(sampleTurn);
      expect(parsed.intent).toBe("Show medicines that are running low on stock");
      expect(parsed.steps).toHaveLength(2);
      expect(parsed.done).toBe(false);
    });
  });

  describe("run_analysis AgentTurn schema boundary", () => {
    const parseAnalysisTurn = (spec: unknown) =>
      AgentTurn.safeParse({
        intent: "Analyze medicine data",
        reasoning: "Use a schema-valid analysis operation.",
        steps: [{ tool: "run_analysis", args: { spec } }],
        done: true,
      });

    const periodCompareSpec = {
      kind: "period_compare",
      dataset: "medicine_usage",
      metric: { field: "quantity", agg: "sum" },
      periodA: { start: "2026-09-23", end: "2026-10-06" },
      periodB: { start: "2026-09-09", end: "2026-09-22" },
    };

    it("rejects run_analysis without the required metric", () => {
      expect(parseAnalysisTurn({
        kind: "period_compare",
        dataset: "medicine_usage",
        periodA: { start: "2026-09-23", end: "2026-10-06" },
        periodB: { start: "2026-09-09", end: "2026-09-22" },
      }).success).toBe(false);
    });

    it("rejects breakdownBy entries that are objects instead of field-name strings", () => {
      expect(parseAnalysisTurn({
        ...periodCompareSpec,
        breakdownBy: [{ field: "medicine" }],
      }).success).toBe(false);
    });

    it("rejects rank without required by", () => {
      expect(parseAnalysisTurn({
        kind: "rank",
        dataset: "medicine_usage",
        metric: { field: "quantity", agg: "sum" },
      }).success).toBe(false);
    });

    it("accepts a valid period_compare operation", () => {
      expect(parseAnalysisTurn(periodCompareSpec).success).toBe(true);
    });

    it("accepts period_compare breakdownBy as plain field-name strings", () => {
      expect(parseAnalysisTurn({
        ...periodCompareSpec,
        breakdownBy: ["medicine"],
      }).success).toBe(true);
    });

    it("accepts a valid rank operation", () => {
      expect(parseAnalysisTurn({
        kind: "rank",
        dataset: "medicine_usage",
        metric: { field: "quantity", agg: "sum" },
        by: "medicine",
      }).success).toBe(true);
    });

    it("accepts a valid trend operation", () => {
      expect(parseAnalysisTurn({
        kind: "trend",
        dataset: "medicine_usage",
        metric: { field: "quantity", agg: "sum" },
        grain: "day",
        period: { token: "last_30_days" },
      }).success).toBe(true);
    });
  });

  describe("buildNarratorPrompt", () => {
    it("builds prompt with user message, intent, and observations", () => {
      const { system, user } = buildNarratorPrompt({
        userMessage: "Why are these medicines running low?",
        intent: "Investigate root cause of low stock for Amoxicillin and Insulin",
        observations: [
          {
            tool: "run_analysis",
            resultId: "res-amox-analysis",
            data: {
              kind: "period_compare",
              metric: { field: "quantity", agg: "sum" },
              periods: {
                a: { start: "2026-09-23", end: "2026-10-07", days: 14, value: 210 },
                b: { start: "2026-09-09", end: "2026-09-22", days: 14, value: 126 },
              },
              pctChange: 0.66,
              evidence: [{ id: "e1", text: "Daily consumption increased by +66% in last 14 days" }],
              insufficientEvidence: false,
            },
          },
        ],
      });

      expect(system).toContain("NarratorOutput schema");
      expect(system).toContain("PROVENANCE & FAITHFULNESS");
      expect(system).toContain("periods.note");
      expect(system).toContain("insufficientEvidence");

      expect(user).toContain("## USER REQUEST\nWhy are these medicines running low?");
      expect(user).toContain("## PLANNER INTENT");
      expect(user).toContain("## TOOL OBSERVATIONS (EVIDENCE)");
      expect(user).toContain("res-amox-analysis");
    });

    it("ensures expected narrator output matches NarratorOutput schema", () => {
      const sampleNarratorOutput = {
        blocks: [
          {
            type: "text" as const,
            markdown: "Amoxicillin daily usage surged by 66% due to respiratory diagnoses.",
            cites: ["res-amox-analysis"],
          },
          {
            type: "comparison" as const,
            title: "Amoxicillin Usage: Last 14 Days vs Prior 14 Days",
            resultId: "res-amox-analysis",
          },
        ],
      };

      const parsed = NarratorOutput.parse(sampleNarratorOutput);
      expect(parsed.blocks).toHaveLength(2);
      expect(parsed.blocks[0]!.type).toBe("text");
    });
  });
});
