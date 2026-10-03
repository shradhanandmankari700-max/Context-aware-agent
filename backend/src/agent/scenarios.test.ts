import { describe, it, expect, beforeEach } from "vitest";
import type { AppMetadata, RequestContext } from "@cab/contracts";
import hospitalData from "../../../metadata/hospital.json";
import hotelData from "../../../metadata/hotel.json";
import { createAgent } from "./agent";
import { createFakeLlmClient } from "../llm/fake";
import { MemoryStore } from "./memory";
import {
  createMockMetadataStore,
  createMockToolRegistry,
  createMockTraceStore,
  createMockUiAdapter,
} from "./fixtures";
import { checkFaithfulness } from "./faithfulness";

const hospitalMetadata = hospitalData as unknown as AppMetadata;
const hotelMetadata = hotelData as unknown as AppMetadata;

describe("Scenario Tests (5 Judge Tests + Resilience Cases)", () => {
  let memoryStore: MemoryStore;

  const hospitalCtx: RequestContext = {
    tenantId: "tenant_demo",
    appId: "hospital",
    userId: "doctor_1",
    role: "admin",
    sessionId: "sess-scenario-test",
    traceId: "trace-scenario-1",
    now: "2026-10-07",
  };

  const hotelCtx: RequestContext = {
    tenantId: "tenant_demo",
    appId: "hotel",
    userId: "clerk_1",
    role: "staff",
    sessionId: "sess-hotel-test",
    traceId: "trace-hotel-1",
    now: "2026-10-07",
  };

  beforeEach(() => {
    memoryStore = new MemoryStore();
  });

  // --------------------------------------------------------------------------
  // JUDGE TEST 1: Hospital - Show low-stock medicines
  // --------------------------------------------------------------------------
  it("Judge Test 1: 'Show medicines that are running low' navigates, filters, and verifies", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter();
    const metadata = createMockMetadataStore(hospitalMetadata);
    const tools = createMockToolRegistry(hospitalMetadata, ui);
    const traces = createMockTraceStore();

    // Turn 1: navigate & set filter
    fakeLlm.enqueueJson({
      intent: "Show medicines running low on stock",
      reasoning: "Navigate to medicines page and apply stockLevel=low filter",
      steps: [
        { tool: "navigate", args: { target: "medicines" } },
        { tool: "set_filter", args: { filterId: "stockLevel", op: "eq", value: "low" } },
      ],
      done: false,
    });

    // Turn 2: get table data
    fakeLlm.enqueueJson({
      intent: "Show medicines running low on stock",
      reasoning: "Retrieve medicines table data",
      steps: [{ tool: "get_widget_data", args: { widgetId: "medicineStock" } }],
      done: true,
    });

    // Narrator
    fakeLlm.enqueueJson({
      blocks: [
        {
          type: "text",
          markdown: "There are 2 medicines running low: Amoxicillin (0.8 days left) and Insulin (0.6 days left).",
          cites: ["res-widget-medicines"],
        },
        {
          type: "table",
          title: "Low Stock Medicines",
          resultId: "res-widget-medicines",
        },
      ],
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    const res = await agent.chat(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      appId: "hospital",
      message: "Show medicines that are running low.",
    });

    expect(res.status).toBe("ok");
    expect(res.uiState?.pageId).toBe("medicines");
    expect(res.uiState?.filters["stockLevel"]).toEqual({ op: "eq", value: "low" });
    expect(res.verification?.ok).toBe(true);
    expect(res.deepLink).toContain("/inventory/medicines");
    expect(res.deepLink).toContain("f.stockLevel=eq%3Alow");
    expect(res.answer).toHaveLength(2);

    // Verify faithfulness of numbers in response
    const textBlock = res.answer.find((b) => b.type === "text");
    const faith = checkFaithfulness((textBlock as any).markdown, [
      { count: 2 },
      { medicine: "Amoxicillin", days_remaining: 0.8 },
      { medicine: "Insulin", days_remaining: 0.6 },
    ]);
    expect(faith.ok).toBe(true);
  });

  // --------------------------------------------------------------------------
  // JUDGE TEST 2: Hospital - Why are these medicines running low?
  // --------------------------------------------------------------------------
  it("Judge Test 2: 'Why are these medicines running low?' runs analysis and cites evidence", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter({
      appId: "hospital",
      pageId: "medicines",
      route: "/inventory/medicines",
      filters: { stockLevel: { op: "eq", value: "low" } },
      sort: null,
      selection: null,
      disabledFilters: [],
      version: 1,
    });
    const metadata = createMockMetadataStore(hospitalMetadata);
    const tools = createMockToolRegistry(hospitalMetadata, ui);
    const traces = createMockTraceStore();

    // Planner calls analysis
    fakeLlm.enqueueJson({
      intent: "Analyze why Amoxicillin and Insulin are low on stock",
      reasoning: "Compare medicine usage over the last 14 days against prior period",
      steps: [
        {
          tool: "run_analysis",
          args: {
            spec: {
              kind: "period_compare",
              dataset: "medicine_usage",
              metric: { field: "quantity", agg: "sum" },
              periodA: { token: "last_7_days" },
              periodB: { token: "last_week" },
            },
          },
        },
      ],
      done: true,
    });

    // Narrator
    fakeLlm.enqueueJson({
      blocks: [
        {
          type: "text",
          markdown: "Amoxicillin usage increased by 11% month-to-date due to respiratory diagnoses, while orders were delayed.",
          cites: ["res-analysis-1"],
        },
        {
          type: "comparison",
          title: "Usage Comparison",
          resultId: "res-analysis-1",
        },
      ],
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    const res = await agent.chat(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      appId: "hospital",
      message: "Why are these medicines running low?",
    });

    expect(res.status).toBe("ok");
    expect(tools.executedCalls.some((c) => c.tool === "run_analysis")).toBe(true);
    expect(res.answer.some((b) => b.type === "comparison")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // JUDGE TEST 3: Hospital - Show me the ones that may run out within two days
  // --------------------------------------------------------------------------
  it("Judge Test 3: 'Show me the ones that may run out within two days' applies daysRemaining <= 2", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter({
      appId: "hospital",
      pageId: "medicines",
      route: "/inventory/medicines",
      filters: { stockLevel: { op: "eq", value: "low" } },
      sort: null,
      selection: null,
      disabledFilters: [],
      version: 1,
    });
    const metadata = createMockMetadataStore(hospitalMetadata);
    const tools = createMockToolRegistry(hospitalMetadata, ui);
    const traces = createMockTraceStore();

    // Planner narrows with daysRemaining <= 2
    fakeLlm.enqueueJson({
      intent: "Filter medicines that may run out within 2 days",
      reasoning: "Set daysRemaining filter <= 2",
      steps: [
        {
          tool: "set_filter",
          args: { filterId: "daysRemaining", op: "lte", value: 2 },
        },
      ],
      done: true,
    });

    fakeLlm.enqueueJson({
      blocks: [
        {
          type: "text",
          markdown: "Filtered to medicines with 2 or fewer days of stock remaining: Amoxicillin and Insulin.",
          cites: [],
        },
      ],
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    const res = await agent.chat(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      appId: "hospital",
      message: "Show me the ones that may run out within two days.",
    });

    expect(res.status).toBe("ok");
    expect(res.uiState?.filters["daysRemaining"]).toEqual({ op: "lte", value: 2 });
    expect(res.verification?.ok).toBe(true);
  });

  // --------------------------------------------------------------------------
  // JUDGE TEST 4: Hospital - Compare this month's usage with last month
  // --------------------------------------------------------------------------
  it("Judge Test 4: 'Compare this month's medicine usage with last month' includes partial period note", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter();
    const metadata = createMockMetadataStore(hospitalMetadata);
    const tools = createMockToolRegistry(hospitalMetadata, ui);
    const traces = createMockTraceStore();

    fakeLlm.enqueueJson({
      intent: "Compare medicine usage this month with last month",
      reasoning: "Run period comparison between this_month and last_month_to_date",
      steps: [
        {
          tool: "run_analysis",
          args: {
            spec: {
              kind: "period_compare",
              dataset: "medicine_usage",
              metric: { field: "quantity", agg: "sum" },
              periodA: { token: "this_month" },
              periodB: { token: "last_month_to_date" },
            },
          },
        },
      ],
      done: true,
    });

    fakeLlm.enqueueJson({
      blocks: [
        {
          type: "text",
          markdown: "Comparing this month (Oct 1-7, 7 days) with the same 7 days last month (Sep 1-7). Total usage is 500 units vs 450 units (+11%).",
          cites: ["res-analysis-1"],
        },
        {
          type: "comparison",
          title: "Month-to-Date Usage Comparison",
          resultId: "res-analysis-1",
        },
      ],
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    const res = await agent.chat(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      appId: "hospital",
      message: "Compare this month's medicine usage with last month.",
    });

    expect(res.status).toBe("ok");
    const comparisonBlock = res.answer.find((b) => b.type === "comparison");
    expect(comparisonBlock).toBeDefined();
    if (comparisonBlock && comparisonBlock.type === "comparison") {
      expect(comparisonBlock.pctChange).toBe(0.11);
      expect(comparisonBlock.note).toContain("Period A is month-to-date");
    }
  });

  // --------------------------------------------------------------------------
  // JUDGE TEST 5: Hotel - Show available rooms under ₹3000 for tomorrow
  // --------------------------------------------------------------------------
  it("Judge Test 5: 'Show available rooms under ₹3000 for tomorrow' operates hotel app with date token", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter({
      appId: "hotel",
      pageId: "dashboard",
      route: "/dashboard",
      filters: {},
      sort: null,
      selection: null,
      disabledFilters: [],
      version: 0,
    });
    const metadata = createMockMetadataStore(hotelMetadata);
    const tools = createMockToolRegistry(hotelMetadata, ui);
    const traces = createMockTraceStore();

    fakeLlm.enqueueJson({
      intent: "Find available rooms under ₹3000 for tomorrow",
      reasoning: "Navigate to rooms page, set availability=Available, price <= 3000, and stayDate=tomorrow",
      steps: [
        { tool: "navigate", args: { target: "rooms" } },
        { tool: "set_filter", args: { filterId: "availability", op: "eq", value: "Available" } },
        { tool: "set_filter", args: { filterId: "price", op: "lte", value: 3000 } },
        { tool: "set_date_range", args: { filterId: "stayDate", token: "tomorrow" } },
      ],
      done: true,
    });

    fakeLlm.enqueueJson({
      blocks: [
        {
          type: "text",
          markdown: "Rooms 104 and 105 are available tomorrow under ₹3000 (Room 101 is occupied tomorrow).",
          cites: [],
        },
      ],
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    const res = await agent.chat(hotelCtx, {
      sessionId: hotelCtx.sessionId,
      appId: "hotel",
      message: "Show available rooms under ₹3000 for tomorrow.",
    });

    expect(res.status).toBe("ok");
    expect(res.uiState?.pageId).toBe("rooms");
    expect(res.uiState?.filters["availability"]).toEqual({ op: "eq", value: "Available" });
    expect(res.uiState?.filters["price"]).toEqual({ op: "lte", value: 3000 });
    expect(tools.executedCalls.some((c) => c.tool === "set_date_range")).toBe(true);
    expect(res.verification?.ok).toBe(true);
  });

  // --------------------------------------------------------------------------
  // RESILIENCE SCENARIO A: Invalid filter value -> repaired
  // --------------------------------------------------------------------------
  it("Scenario A: repairs invalid filter value automatically without executing invalid action", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter({
      appId: "hospital",
      pageId: "medicines",
      route: "/inventory/medicines",
      filters: {},
      sort: null,
      selection: null,
      disabledFilters: [],
      version: 0,
    });
    const metadata = createMockMetadataStore(hospitalMetadata);
    const tools = createMockToolRegistry(hospitalMetadata, ui);
    const traces = createMockTraceStore();

    // 1st attempt: emits invalid enum value "critically_depleted"
    fakeLlm.enqueueJson({
      intent: "Show low stock medicines",
      reasoning: "Apply invalid filter value first",
      steps: [{ tool: "set_filter", args: { filterId: "stockLevel", op: "eq", value: "critically_depleted" } }],
      done: true,
    });

    // 2nd attempt (repair): receives validator error and repairs to "low"
    fakeLlm.enqueueJson({
      intent: "Show low stock medicines",
      reasoning: "Repaired to valid option low",
      steps: [{ tool: "set_filter", args: { filterId: "stockLevel", op: "eq", value: "low" } }],
      done: true,
    });

    fakeLlm.enqueueJson({
      blocks: [{ type: "text", markdown: "Filter applied successfully.", cites: [] }],
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    const res = await agent.chat(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      appId: "hospital",
      message: "Show low stock medicines",
    });

    expect(res.status).toBe("ok");
    expect(tools.executedCalls).toHaveLength(1);
    expect((tools.executedCalls[0] as any).args.value).toBe("low"); // Never executed the invalid value!

    expect(traces.traces[0]!.invalidActionsBlocked).toBe(1);
    expect(traces.traces[0]!.invalidActionsExecuted).toBe(0);
  });

  // --------------------------------------------------------------------------
  // RESILIENCE SCENARIO B: Nonexistent page -> refusal with candidates
  // --------------------------------------------------------------------------
  it("Scenario B: refuses nonexistent page and offers candidates", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter();
    const metadata = createMockMetadataStore(hospitalMetadata);
    const tools = createMockToolRegistry(hospitalMetadata, ui);
    const traces = createMockTraceStore();

    // 1st attempt: tries to navigate to nonexistent page
    fakeLlm.enqueueJson({
      intent: "Open profit forecast page",
      reasoning: "Try navigate to profit forecast",
      steps: [{ tool: "navigate", args: { target: "Profit Forecast 2030" } }],
      done: false,
    });

    // 2nd attempt: planner sees PAGE_NOT_FOUND error and candidates, chooses to clarify / refuse
    fakeLlm.enqueueJson({
      intent: "Open profit forecast page",
      reasoning: "Page does not exist, refuse politely and suggest real pages",
      clarification: {
        question: "The page 'Profit Forecast 2030' does not exist. Did you mean Dashboard, Patients, or Medicines?",
        options: ["Dashboard", "Patients", "Medicines"],
      },
      steps: [],
      done: true,
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    const res = await agent.chat(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      appId: "hospital",
      message: "Open the Profit forecast 2030 page",
    });

    expect(res.status).toBe("needs_clarification");
    expect(res.clarification?.question).toContain("does not exist");
    expect(tools.executedCalls).toHaveLength(0); // Zero invalid actions executed!
  });

  // --------------------------------------------------------------------------
  // RESILIENCE SCENARIO C: Destructive action -> needs_confirmation
  // --------------------------------------------------------------------------
  it("Scenario C: gates destructive action and executes only upon approval", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter();
    const metadata = createMockMetadataStore(hospitalMetadata);
    const tools = createMockToolRegistry(hospitalMetadata, ui);
    const traces = createMockTraceStore();

    fakeLlm.enqueueJson({
      intent: "Discard expired medicines",
      reasoning: "Invoke destructive discard action",
      steps: [{ tool: "invoke_app_action", args: { actionId: "discardExpiredStock", params: { medicine: "Aspirin" } } }],
      done: true,
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    // Step 1: chat requires confirmation
    const chatRes = await agent.chat(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      appId: "hospital",
      message: "Discard expired stock for Aspirin",
    });

    expect(chatRes.status).toBe("needs_confirmation");
    expect(chatRes.pendingConfirmation).toBeDefined();
    expect(tools.executedCalls).toHaveLength(0);

    const confId = chatRes.pendingConfirmation!.confirmationId;

    // Step 2: User confirms
    const confirmRes = await agent.confirm(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      confirmationId: confId,
      approve: true,
    });

    expect(confirmRes.status).toBe("ok");
    expect(tools.executedCalls).toHaveLength(1);
    expect(tools.executedCalls[0]!.tool).toBe("invoke_app_action");
  });

  // --------------------------------------------------------------------------
  // RESILIENCE SCENARIO D: Follow-up uses memory
  // --------------------------------------------------------------------------
  it("Scenario D: follow-up turn reuses lastResult keys from memory", async () => {
    const fakeLlm = createFakeLlmClient();
    const ui = createMockUiAdapter({
      appId: "hospital",
      pageId: "medicines",
      route: "/inventory/medicines",
      filters: { stockLevel: { op: "eq", value: "low" } },
      sort: null,
      selection: null,
      disabledFilters: [],
      version: 1,
    });
    const metadata = createMockMetadataStore(hospitalMetadata);
    const tools = createMockToolRegistry(hospitalMetadata, ui);
    const traces = createMockTraceStore();

    // Prime memory with previous turn result
    memoryStore.recordAssistantTurn(
      hospitalCtx.sessionId,
      "hospital",
      "Found Amoxicillin and Insulin",
      ui.getStateSync(),
      {
        dataset: "medicines",
        keys: ["Amoxicillin", "Insulin"],
        description: "Low stock medicines",
      },
    );

    // Follow-up planner turn
    fakeLlm.enqueueJson({
      intent: "Find which of the previous low-stock medicines has higher daily usage",
      reasoning: "Query usage data for Amoxicillin and Insulin",
      steps: [
        {
          tool: "query_business_data",
          args: {
            spec: {
              dataset: "medicines",
              select: ["medicine", "daily_usage"],
              where: [{ field: "medicine", op: "in", value: ["Amoxicillin", "Insulin"] }],
              groupBy: [],
              metrics: [],
              orderBy: [{ field: "daily_usage", direction: "desc" }],
              limit: 2,
            },
          },
        },
      ],
      done: true,
    });

    fakeLlm.enqueueJson({
      blocks: [
        {
          type: "text",
          markdown: "Of the two, Amoxicillin has a higher daily usage (15 units/day) compared to Insulin (8 units/day).",
          cites: ["res-query-medicines"],
        },
      ],
    });

    const agent = createAgent({ metadata, ui, tools, traces, llm: fakeLlm, memoryStore });

    const res = await agent.chat(hospitalCtx, {
      sessionId: hospitalCtx.sessionId,
      appId: "hospital",
      message: "Which of these is used faster?",
    });

    expect(res.status).toBe("ok");
    expect(tools.executedCalls.some((c) => c.tool === "query_business_data")).toBe(true);
    const queryCall = tools.executedCalls.find((c) => c.tool === "query_business_data");
    expect((queryCall as any).args.spec.where[0].value).toEqual(["Amoxicillin", "Insulin"]);
  });
});
