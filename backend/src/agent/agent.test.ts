import { describe, it, expect, beforeEach } from "vitest";
import type {
  AppMetadata,
  MetadataStore,
  RequestContext,
  ToolCall,
  ToolRegistry,
  ToolResult,
  Trace,
  TraceStore,
  UiAdapter,
  UiState,
} from "@cab/contracts";
import hospitalData from "../../../metadata/hospital.json";
import { createAgent } from "./agent";
import { createFakeLlmClient } from "../llm/fake";
import { MemoryStore } from "./memory";
import { checkFaithfulness } from "./faithfulness";

const hospitalMetadata = hospitalData as unknown as AppMetadata;

describe("Agent Loop", () => {
  let uiState: UiState;
  let tracesSaved: Trace[];
  let executedTools: ToolCall[];
  let memoryStore: MemoryStore;

  const mockContext: RequestContext = {
    tenantId: "tenant_test",
    appId: "hospital",
    userId: "user_test",
    role: "admin",
    sessionId: "session-12345678",
    traceId: "trace-init-123",
    now: "2026-10-07",
  };

  beforeEach(() => {
    uiState = {
      appId: "hospital",
      pageId: "dashboard",
      route: "/dashboard",
      filters: {},
      sort: null,
      selection: null,
      disabledFilters: [],
      version: 0,
    };
    tracesSaved = [];
    executedTools = [];
    memoryStore = new MemoryStore();
  });

  function createMockMetadataStore(): MetadataStore {
    return {
      async getApp() {
        return hospitalMetadata;
      },
      async listApps() {
        return [{ appId: "hospital", name: "Hospital", description: "Operations" }];
      },
      async search() {
        return [
          {
            kind: "page",
            id: "medicines",
            name: "Medicines",
            path: "Inventory > Medicines",
            description: "Medicine stock levels",
            score: 0.95,
          },
          {
            kind: "filter",
            id: "stockLevel",
            name: "Stock level",
            path: "Inventory > Medicines > Stock level",
            description: "Low stock filter",
            score: 0.9,
          },
        ];
      },
      async buildContext() {
        return {
          appId: "hospital",
          appName: "Hospital Operations",
          navTree: hospitalMetadata.pages.map((p) => ({
            id: p.id,
            name: p.name,
            route: p.route,
            parent: p.parent,
          })),
          pages: hospitalMetadata.pages.map((p) => ({
            id: p.id,
            name: p.name,
            route: p.route,
            path: p.name,
            description: p.description,
            widgets: p.widgets.map((w) => ({
              id: w.id,
              name: w.name,
              type: w.type,
              dataset: w.dataset,
              description: w.description,
              columns: (w.columns ?? []).map((c) => ({ field: c.field, label: c.label || c.field })),
              sortable: w.sortable ?? [],
            })),
            filters: p.filters.map((f) => ({
              id: f.id,
              label: f.label,
              type: f.type,
              field: f.field,
              description: f.description,
              operators: f.operators ?? (["eq"] as any),
              options: f.options,
            })),
          })),
          datasets: hospitalMetadata.datasets.map((d) => ({
            name: d.name,
            description: d.description,
            timeField: d.timeField,
            fields: d.fields.map((f) => ({
              name: f.name,
              label: f.label,
              type: f.type,
              description: f.description,
              derived: !!f.derived,
              roles: f.roles,
            })),
            relations: d.relations ?? [],
          })),
          actions: hospitalMetadata.actions.map((a) => ({
            id: a.id,
            label: a.label,
            destructive: a.destructive,
            description: a.description,
          })),
        };
      },
      async importApp() {
        return { appId: "hospital", pages: 4, widgets: 6, filters: 6, datasets: 6, embedded: 10, rowsLoaded: 20 };
      },
    };
  }

  function createMockUiAdapter(): UiAdapter {
    return {
      async getState() {
        return uiState;
      },
      async dispatch(_sessionId, action) {
        if (action.type === "navigate") {
          uiState.pageId = action.pageId;
          uiState.route = action.route;
        } else if (action.type === "set_filter") {
          uiState.filters[action.filterId] = action.value;
        }
        uiState.version++;
        return { actionId: "act-123" };
      },
      async awaitAck() {
        return { state: uiState };
      },
    };
  }

  function createMockToolRegistry(): ToolRegistry {
    return {
      async execute(_ctx, call): Promise<ToolResult> {
        executedTools.push(call);
        if (call.tool === "navigate") {
          const page = hospitalMetadata.pages.find((p) => p.id === call.args.target);
          if (page) {
            uiState.pageId = page.id;
            uiState.route = page.route;
          }
          return { ok: true, data: { navigated: true } };
        }
        if (call.tool === "set_filter") {
          uiState.filters[call.args.filterId] = {
            op: call.args.op ?? "eq",
            value: call.args.value as any,
          };
          return { ok: true, data: { filterApplied: true } };
        }
        if (call.tool === "get_widget_data") {
          return {
            ok: true,
            data: {
              dataset: "medicines",
              columns: [{ name: "medicine", label: "Medicine", type: "string" }],
              rows: [{ medicine: "Amoxicillin", stock: 12, days_remaining: 0.8 }],
              rowCount: 1,
            },
            meta: { resultId: "res-widget-1", queryId: "q-widget-1" },
          };
        }
        if (call.tool === "invoke_app_action") {
          return { ok: true, data: { actionExecuted: call.args.actionId } };
        }
        return { ok: true, data: { success: true } };
      },
    };
  }

  function createMockTraceStore(): TraceStore {
    return {
      async save(trace) {
        tracesSaved.push(trace);
      },
      async get(id) {
        return tracesSaved.find((t) => t.traceId === id) ?? null;
      },
      async list() {
        return tracesSaved;
      },
    };
  }

  it("orchestrates standard 'Show low-stock medicines' flow end-to-end", async () => {
    const fakeLlm = createFakeLlmClient();

    // Turn 1: Planner navigates and filters
    fakeLlm.enqueueJson({
      intent: "Show medicines running low on stock",
      reasoning: "Navigate to medicines and filter by low stock",
      steps: [
        { tool: "navigate", args: { target: "medicines" } },
        { tool: "set_filter", args: { filterId: "stockLevel", op: "eq", value: "low" } },
      ],
      done: false,
    });

    // Turn 2: Planner gets widget data and finishes
    fakeLlm.enqueueJson({
      intent: "Show medicines running low on stock",
      reasoning: "Fetch the low-stock items from the table widget",
      steps: [{ tool: "get_widget_data", args: { widgetId: "medicineStock" } }],
      done: true,
    });

    // Turn 3: Narrator formats final answer
    fakeLlm.enqueueJson({
      blocks: [
        {
          type: "text",
          markdown: "Found 1 low-stock medicine: Amoxicillin with 0.8 days remaining.",
          cites: ["res-widget-1"],
        },
        {
          type: "table",
          title: "Low Stock Medicines",
          resultId: "res-widget-1",
        },
      ],
    });

    const agent = createAgent({
      metadata: createMockMetadataStore(),
      ui: createMockUiAdapter(),
      tools: createMockToolRegistry(),
      traces: createMockTraceStore(),
      llm: fakeLlm,
      memoryStore,
    });

    const response = await agent.chat(mockContext, {
      sessionId: "session-12345678",
      appId: "hospital",
      message: "Show low-stock medicines",
    });

    expect(response.status).toBe("ok");
    expect(response.intent).toContain("low");
    expect(executedTools).toHaveLength(3);
    expect(executedTools[0]!.tool).toBe("navigate");
    expect(executedTools[1]!.tool).toBe("set_filter");
    expect(executedTools[2]!.tool).toBe("get_widget_data");

    // Verification ok
    expect(response.verification?.ok).toBe(true);

    // Deep link computed
    expect(response.deepLink).toContain("/inventory/medicines");
    expect(response.deepLink).toContain("f.stockLevel=eq%3Alow");

    // Answer blocks assembled with provenance
    expect(response.answer).toHaveLength(2);
    expect(response.answer[0]!.type).toBe("text");
    expect(response.answer[1]!.type).toBe("table");
    expect(response.answer[0]!.provenance[0]!.resultId).toBe("res-widget-1");

    // Trace saved
    expect(tracesSaved).toHaveLength(1);
    expect(tracesSaved[0]!.invalidActionsBlocked).toBe(0);
    expect(tracesSaved[0]!.invalidActionsExecuted).toBe(0);
  });

  it("returns a failed response instead of throwing when the LLM fails", async () => {
    const failingLlm = {
      json: async () => {
        throw new Error("Gemini API error (status 404): model unavailable");
      },
      text: async () => ({ data: "" }),
      embed: async () => [[]],
    } as any;

    const agent = createAgent({
      metadata: createMockMetadataStore(),
      ui: createMockUiAdapter(),
      tools: createMockToolRegistry(),
      traces: createMockTraceStore(),
      llm: failingLlm,
      memoryStore,
    });

    const response = await agent.chat(mockContext, {
      sessionId: "session-12345678",
      appId: "hospital",
      message: "Show low-stock medicines",
    });

    const firstAnswer = response.answer[0];

    expect(response.status).toBe("failed");
    expect(firstAnswer?.type).toBe("text");
    if (firstAnswer?.type !== "text") {
      throw new Error("Expected failed response answer to be a text block");
    }
    expect(firstAnswer.markdown).toContain("model unavailable");
    expect(response.verification?.ok).toBe(false);
  });

  it("saves a failed trace even when the LLM throws", async () => {
    const failingLlm = {
      json: async () => {
        throw new Error("Gemini API error (status 404): model unavailable");
      },
      text: async () => ({ data: "" }),
      embed: async () => [[]],
    } as any;

    const traces = createMockTraceStore();
    const agent = createAgent({
      metadata: createMockMetadataStore(),
      ui: createMockUiAdapter(),
      tools: createMockToolRegistry(),
      traces,
      llm: failingLlm,
      memoryStore,
    });

    const response = await agent.chat(mockContext, {
      sessionId: "session-12345678",
      appId: "hospital",
      message: "Show low-stock medicines",
    });

    expect(response.status).toBe("failed");
    expect(tracesSaved).toHaveLength(1);
    expect((await traces.get(response.traceId))?.traceId).toBe(response.traceId);
    expect((await traces.get(response.traceId))?.status).toBe("failed");
  });

  it("handles ambiguity by returning clarification", async () => {
    const fakeLlm = createFakeLlmClient();

    fakeLlm.enqueueJson({
      intent: "Ambiguous request",
      reasoning: "User asked ambiguous question",
      clarification: {
        question: "Would you like to see usage for today, this month, or a custom period?",
        options: ["Today", "This month", "Custom"],
      },
      steps: [],
      done: true,
    });

    const agent = createAgent({
      metadata: createMockMetadataStore(),
      ui: createMockUiAdapter(),
      tools: createMockToolRegistry(),
      traces: createMockTraceStore(),
      llm: fakeLlm,
      memoryStore,
    });

    const response = await agent.chat(mockContext, {
      sessionId: "session-12345678",
      appId: "hospital",
      message: "Show usage",
    });

    expect(response.status).toBe("needs_clarification");
    expect(response.clarification?.question).toContain("Would you like to see usage");
    expect(executedTools).toHaveLength(0);
  });

  it("stops at policy gate for destructive action and resumes on confirm", async () => {
    const fakeLlm = createFakeLlmClient();

    // Planner asks to invoke destructive action
    fakeLlm.enqueueJson({
      intent: "Discard expired medicines",
      reasoning: "Call discardExpiredStock action",
      steps: [
        {
          tool: "invoke_app_action",
          args: { actionId: "discardExpiredStock", params: { medicine: "Aspirin" } },
        },
      ],
      done: true,
    });

    const agent = createAgent({
      metadata: createMockMetadataStore(),
      ui: createMockUiAdapter(),
      tools: createMockToolRegistry(),
      traces: createMockTraceStore(),
      llm: fakeLlm,
      memoryStore,
    });

    // 1. Initial chat requires confirmation
    const response = await agent.chat(mockContext, {
      sessionId: "session-12345678",
      appId: "hospital",
      message: "Discard expired stock for Aspirin",
    });

    expect(response.status).toBe("needs_confirmation");
    expect(response.pendingConfirmation).toBeDefined();
    expect(executedTools).toHaveLength(0); // Not executed!

    const confirmationId = response.pendingConfirmation!.confirmationId;

    // 2. User confirms action
    const confirmResponse = await agent.confirm(mockContext, {
      sessionId: "session-12345678",
      confirmationId,
      approve: true,
    });

    expect(confirmResponse.status).toBe("ok");
    expect(executedTools).toHaveLength(1);
    expect(executedTools[0]!.tool).toBe("invoke_app_action");
  });

  it("verifies faithfulness checker functionality", () => {
    const evidence = [
      { medicine: "Amoxicillin", stock: 12, days_remaining: 0.8 },
      { pctChange: 0.6, evidence: [{ text: "Usage rose by 60% over 14 days" }] },
    ];

    const faithfulText = "Amoxicillin has 12 units in stock and usage rose by 60%.";
    const report1 = checkFaithfulness(faithfulText, evidence);
    expect(report1.ok).toBe(true);

    const fabricatedText = "Amoxicillin has 999 units in stock and 750 patients were affected.";
    const report2 = checkFaithfulness(fabricatedText, evidence);
    expect(report2.ok).toBe(false);
    expect(report2.unmatchedNumbers).toContain(999);
  });
});
