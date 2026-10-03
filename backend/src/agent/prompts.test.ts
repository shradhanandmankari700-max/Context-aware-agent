import { describe, it, expect } from "vitest";
import { AgentTurn, NarratorOutput } from "@cab/contracts";
import { buildPlannerPrompt, buildNarratorPrompt } from "./prompts";

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
