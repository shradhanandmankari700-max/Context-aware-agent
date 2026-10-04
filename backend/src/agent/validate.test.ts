import { describe, it, expect } from "vitest";
import { AgentTurn as AgentTurnSchema, type AgentTurn, type AppMetadata } from "@cab/contracts";
import hospitalData from "../../../metadata/hospital.json";
import { normalizeAgentTurnForSchema, validatePlan } from "./validate";

const hospitalMetadata = hospitalData as unknown as AppMetadata;

describe("validatePlan", () => {
  const baseUiState = {
    appId: "hospital",
    pageId: "medicines",
    route: "/inventory/medicines",
    filters: {},
    sort: null,
    selection: null,
    disabledFilters: [],
    version: 1,
  };

  it("passes a valid plan with navigation and filter", () => {
    const turn: AgentTurn = {
      intent: "Show low stock medicines",
      reasoning: "Navigate to medicines and filter by low stock",
      steps: [
        { tool: "navigate", args: { target: "medicines" } },
        { tool: "set_filter", args: { filterId: "stockLevel", op: "eq", value: "low" } },
      ],
      done: true,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", turn);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.normalizedTurn.steps[1]!.tool).toBe("set_filter");
  });

  it("normalizes enum filter synonyms to valid option values", () => {
    const turn: AgentTurn = {
      intent: "Show medicines that are running low",
      reasoning: "Use synonym running low",
      steps: [
        { tool: "set_filter", args: { filterId: "stockLevel", op: "eq", value: "running low", pageId: "medicines" } },
      ],
      done: true,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", turn);
    expect(result.ok).toBe(true);
    const setFilterStep = result.normalizedTurn.steps[0]!;
    expect(setFilterStep.tool).toBe("set_filter");
    if (setFilterStep.tool === "set_filter") {
      expect(setFilterStep.args.value).toBe("low");
    }
  });

  it("rejects nonexistent page with closest candidate suggestions", () => {
    const turn: AgentTurn = {
      intent: "Go to medicine inventory",
      reasoning: "Try navigate with misspelled name",
      steps: [{ tool: "navigate", args: { target: "Medicine Inventory" } }],
      done: false,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", turn);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("PAGE_NOT_FOUND");
    expect(result.errors[0]!.candidates).toContain("medicines");
  });

  it("rejects filter not present on the active page", () => {
    const turn: AgentTurn = {
      intent: "Filter by ward on medicines page",
      reasoning: "Ward belongs to patients, not medicines",
      steps: [{ tool: "set_filter", args: { filterId: "ward", op: "eq", value: "ICU" } }],
      done: false,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", turn);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("FILTER_NOT_FOUND");
    expect(result.errors[0]!.message).toContain("Filter \"ward\" does not exist on page \"medicines\"");
  });

  it("rejects filter when disabled in UI and provides alternative candidates", () => {
    const uiWithDisabledFilter = {
      ...baseUiState,
      disabledFilters: ["stockLevel"],
    };

    const turn: AgentTurn = {
      intent: "Show low stock medicines",
      reasoning: "Apply stockLevel filter",
      steps: [{ tool: "set_filter", args: { filterId: "stockLevel", op: "eq", value: "low" } }],
      done: false,
    };

    const result = validatePlan(hospitalMetadata, uiWithDisabledFilter, "staff", turn);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("FILTER_UNAVAILABLE");
    expect(result.errors[0]!.candidates).toContain("daysRemaining");
  });

  it("rejects operator not allowed for the filter type", () => {
    const turn: AgentTurn = {
      intent: "Filter with invalid operator",
      reasoning: "Contains operator is invalid for enum filter",
      steps: [
        { tool: "set_filter", args: { filterId: "stockLevel", op: "contains" as any, value: "low" } },
      ],
      done: false,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", turn);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("INVALID_OPERATOR");
  });

  it("rejects invalid enum values and lists valid candidates", () => {
    const turn: AgentTurn = {
      intent: "Filter with nonexistent enum value",
      reasoning: "urgent is not an enum option",
      steps: [{ tool: "set_filter", args: { filterId: "stockLevel", value: "urgent" } }],
      done: false,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", turn);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("INVALID_FILTER_VALUE");
    expect(result.errors[0]!.candidates).toEqual(["low", "medium", "high"]);
  });

  it("validates numeric values on number filters", () => {
    const validTurn: AgentTurn = {
      intent: "Run out in 2 days",
      reasoning: "Set daysRemaining <= 2",
      steps: [{ tool: "set_filter", args: { filterId: "daysRemaining", op: "lte", value: 2 } }],
      done: false,
    };
    expect(validatePlan(hospitalMetadata, baseUiState, "staff", validTurn).ok).toBe(true);

    const invalidTurn: AgentTurn = {
      intent: "Run out soon",
      reasoning: "Text value passed to numeric filter",
      steps: [{ tool: "set_filter", args: { filterId: "daysRemaining", op: "lte", value: "two days" } }],
      done: false,
    };
    const invalidRes = validatePlan(hospitalMetadata, baseUiState, "staff", invalidTurn);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors[0]!.code).toBe("INVALID_FILTER_VALUE");
  });

  it("validates DateTokens and ISO dates in set_date_range", () => {
    const validTokenTurn: AgentTurn = {
      intent: "Set date to this month",
      reasoning: "Use this_month token",
      steps: [{ tool: "set_date_range", args: { token: "this_month" } }],
      done: false,
    };
    expect(validatePlan(hospitalMetadata, baseUiState, "staff", validTokenTurn).ok).toBe(true);

    const invalidTokenTurn: AgentTurn = {
      intent: "Set date to invalid token",
      reasoning: "Invented token",
      steps: [{ tool: "set_date_range", args: { token: "next_decade" as any } }],
      done: false,
    };
    expect(validatePlan(hospitalMetadata, baseUiState, "staff", invalidTokenTurn).ok).toBe(false);
  });

  it("rejects sorting on non-sortable fields", () => {
    const turn: AgentTurn = {
      intent: "Sort by non-sortable field",
      reasoning: "category is not in sortable list for medicineStock",
      steps: [
        { tool: "sort", args: { widgetId: "medicineStock", field: "non_sortable_field", direction: "asc" } },
      ],
      done: false,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", turn);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("FIELD_NOT_ALLOWED");
  });

  it("repairs malformed query_business_data shapes from the planner before schema validation", () => {
    const rawTurn = {
      intent: "Show medicines that are running low",
      reasoning: "Use the medicines dataset and filter low stock",
      steps: [
        {
          tool: "query_business_data",
          args: {
            dataset: "medicines",
            select: ["name", "stock_level"],
            where: [{ field: "stock_level", op: "eq", value: "low" }],
            limit: 10,
          },
        },
      ],
      done: true,
    };

    const normalized = normalizeAgentTurnForSchema(rawTurn) as any;
    expect(() => AgentTurnSchema.parse(normalized)).not.toThrow();
    expect(normalized.steps[0]).toMatchObject({
      tool: "query_business_data",
      args: {
        spec: {
          dataset: "medicines",
          select: ["name", "stock_level"],
          where: [{ field: "stock_level", op: "eq", value: "low" }],
          limit: 10,
        },
      },
    });
  });

  it("rejects adversarial SQL injection in query_business_data", () => {
    const sqlInjectionTurn: AgentTurn = {
      intent: "Malicious query",
      reasoning: "Attempt SQL injection in field name",
      steps: [
        {
          tool: "query_business_data",
          args: {
            spec: {
              dataset: "medicines",
              select: ["stock; DROP TABLE users --"],
              where: [],
              groupBy: [],
              metrics: [],
              orderBy: [],
              limit: 10,
            },
          },
        },
      ],
      done: false,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", sqlInjectionTurn);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("FIELD_NOT_ALLOWED");
  });

  it("rejects datasets from other applications", () => {
    const otherAppTurn: AgentTurn = {
      intent: "Query hotel dataset on hospital app",
      reasoning: "hotel_rooms belongs to hotel app",
      steps: [
        {
          tool: "query_business_data",
          args: {
            spec: {
              dataset: "hotel_rooms",
              select: [],
              where: [],
              groupBy: [],
              metrics: [],
              orderBy: [],
              limit: 10,
            },
          },
        },
      ],
      done: false,
    };

    const result = validatePlan(hospitalMetadata, baseUiState, "staff", otherAppTurn);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("DATASET_NOT_FOUND");
  });

  it("enforces role permissions and flags destructive actions", () => {
    const destructiveTurn: AgentTurn = {
      intent: "Discard expired medicines",
      reasoning: "Call discardExpiredStock action",
      steps: [
        {
          tool: "invoke_app_action",
          args: { actionId: "discardExpiredStock", params: { medicine: "Aspirin" } },
        },
      ],
      done: false,
    };

    // Viewer role: forbidden
    const viewerRes = validatePlan(hospitalMetadata, baseUiState, "viewer", destructiveTurn);
    expect(viewerRes.ok).toBe(false);
    expect(viewerRes.errors[0]!.code).toBe("FORBIDDEN");

    // Admin role: allowed and flagged as destructive action
    const adminRes = validatePlan(hospitalMetadata, baseUiState, "admin", destructiveTurn);
    expect(adminRes.ok).toBe(true);
    expect(adminRes.destructiveActions).toHaveLength(1);
    expect(adminRes.destructiveActions[0]!.actionId).toBe("discardExpiredStock");
  });
});
