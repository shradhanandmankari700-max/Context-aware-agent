import { beforeEach, describe, expect, it } from "vitest";
import { RequestContext, ToolCall, ToolRegistry, UiAdapter } from "@cab/contracts";
import { createFakeUiAdapter } from "../ui/fake";
import { createFakeToolRegistry, FakeAnalyticsService, FakeDataService, FakeMetadataStore } from "./fake";
import { createToolRegistry } from "./registry";

describe("DefaultToolRegistry", () => {
  let registry: ToolRegistry;
  let ui: ReturnType<typeof createFakeUiAdapter>;
  const ctx: RequestContext = {
    tenantId: "tenant-test",
    appId: "hospital",
    userId: "user-test",
    role: "admin",
    sessionId: "fake-session",
    traceId: "trace-test",
    now: "2026-10-07",
  };

  beforeEach(() => {
    ui = createFakeUiAdapter("fake-session", "medicines");
    registry = createToolRegistry({
      metadata: new FakeMetadataStore(),
      data: new FakeDataService(),
      analytics: new FakeAnalyticsService(),
      ui,
    });
  });

  async function execute(call: ToolCall) {
    return registry.execute(ctx, call);
  }

  async function seedMedicinesPage() {
    const result = await execute({ tool: "navigate", args: { target: "medicines" } });
    expect(result.ok).toBe(true);
  }

  function expectVerifiedAction(result: Awaited<ReturnType<typeof execute>>) {
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ verified: true, mismatches: [] });
    }
  }

  it("searches metadata", async () => {
    const result = await execute({ tool: "search_metadata", args: { query: "medicines", kinds: ["page"] } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: "medicines", pageId: "medicines" })]));
  });

  it("returns app metadata and page details", async () => {
    const app = await execute({ tool: "get_app_metadata", args: {} });
    expect(app.ok).toBe(true);
    if (app.ok) expect(app.data).toMatchObject({ appId: "hospital", name: "Hospital Management" });

    const page = await execute({ tool: "get_page_details", args: { pageId: "medicines" } });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.data).toMatchObject({ id: "medicines", name: "Medicines" });
  });

  it("returns available filters and current UI state", async () => {
    await seedMedicinesPage();
    const filters = await execute({ tool: "get_available_filters", args: { pageId: "medicines" } });
    expect(filters.ok).toBe(true);
    if (filters.ok) expect(filters.data).toMatchObject({ pageId: "medicines" });

    const page = await execute({ tool: "get_current_page", args: {} });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.data).toMatchObject({ pageId: "medicines", route: "/inventory/medicines" });

    const state = await execute({ tool: "get_current_ui_state", args: {} });
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.data).toMatchObject({ pageId: "medicines", filters: {} });
  });

  it("navigates by page name, synonym-like partial match, and route with verified state", async () => {
    expectVerifiedAction(await execute({ tool: "navigate", args: { target: "Purchase orders" } }));
    expectVerifiedAction(await execute({ tool: "navigate", args: { target: "pharmacy" } }));
    expectVerifiedAction(await execute({ tool: "navigate", args: { target: "/inventory/medicines" } }));
  });

  it("sets and clears enum filters with verified state", async () => {
    await seedMedicinesPage();
    const set = await execute({ tool: "set_filter", args: { filterId: "Category", value: "painkiller" } });
    expectVerifiedAction(set);
    if (set.ok) expect(set.data).toMatchObject({ expected: { filters: { category: { op: "eq", value: "Painkiller" } } } });

    expectVerifiedAction(await execute({ tool: "clear_filter", args: { filterId: "category" } }));
  });

  it("expands a date token and sorts an allowed field with verified state", async () => {
    await seedMedicinesPage();
    const date = await execute({ tool: "set_date_range", args: { filterId: "expiryDate", token: "this_month" } });
    expectVerifiedAction(date);
    if (date.ok) expect(date.data).toMatchObject({ expected: { filters: { expiryDate: { op: "between", value: ["2026-10-01", "2026-10-07"] } } } });

    expectVerifiedAction(await execute({ tool: "sort", args: { field: "stock", direction: "asc" } }));
  });

  it("returns widget data, business query results, and analysis", async () => {
    const widget = await execute({ tool: "get_widget_data", args: { widgetId: "medicineStock", limit: 10 } });
    expect(widget.ok).toBe(true);
    if (widget.ok) expect(widget.data).toMatchObject({ rowCount: 1 });

    const query = await execute({ tool: "query_business_data", args: { spec: { dataset: "medicines", select: ["medicine"], limit: 10, where: [], groupBy: [], metrics: [], orderBy: [] } } });
    expect(query.ok).toBe(true);
    if (query.ok) expect(query.data).toMatchObject({ rowCount: 1 });

    const analysis = await execute({ tool: "run_analysis", args: { spec: {
      kind: "rank", dataset: "medicines", metric: { field: "stock", agg: "sum" }, by: "medicine",
      direction: "desc", limit: 10, where: [],
    } } });
    expect(analysis.ok).toBe(true);
  });

  it("blocks destructive actions until confirmed and enforces role requirements", async () => {
    const blocked = await execute({ tool: "invoke_app_action", args: { actionId: "discardExpiredStock", params: {} } });
    expect(blocked).toMatchObject({ ok: false, error: { code: "NEEDS_CONFIRMATION" } });

    const forbidden = await registry.execute({ ...ctx, role: "staff" }, {
      tool: "invoke_app_action", args: { actionId: "discardExpiredStock", params: {} },
    });
    expect(forbidden).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const confirmed = await registry.execute({ ...ctx, confirmed: true } as RequestContext, {
      tool: "invoke_app_action", args: { actionId: "discardExpiredStock", params: {} },
    });
    expect(confirmed).toMatchObject({ ok: true, data: { actionId: "discardExpiredStock", executed: true } });
  });

  it("returns PAGE_NOT_FOUND with up to three candidates for unknown navigation", async () => {
    const result = await execute({ tool: "navigate", args: { target: "not-a-page" } });
    expect(result).toMatchObject({ ok: false, error: { code: "PAGE_NOT_FOUND", candidates: expect.any(Array) } });
    if (!result.ok) expect(result.error.candidates).toHaveLength(3);
  });

  it("returns page and filter errors with useful candidates", async () => {
    const badPage = await execute({ tool: "set_filter", args: { pageId: "missing", filterId: "category", value: "Painkiller" } });
    expect(badPage).toMatchObject({ ok: false, error: { code: "PAGE_NOT_FOUND", candidates: expect.any(Array) } });

    const badFilter = await execute({ tool: "set_filter", args: { filterId: "unknownFilter", value: "x" } });
    expect(badFilter).toMatchObject({ ok: false, error: { code: "FILTER_NOT_FOUND", candidates: expect.arrayContaining(["category"]) } });
  });

  it("reports timeouts and catches a deliberately incorrect UI state", async () => {
    const timeoutUi: UiAdapter = {
      getState: async () => null,
      dispatch: async () => ({ actionId: "timeout-action" }),
      awaitAck: async () => ({ timeout: true }),
    };
    const timeoutRegistry = createToolRegistry({ metadata: new FakeMetadataStore(), ui: timeoutUi });
    expect(await timeoutRegistry.execute(ctx, { tool: "navigate", args: { target: "medicines" } }))
      .toMatchObject({ ok: false, error: { code: "UI_TIMEOUT" } });

    const incorrectUi: UiAdapter = {
      getState: async () => null,
      dispatch: async () => ({ actionId: "wrong-state" }),
      awaitAck: async () => ({
        state: {
          appId: "hospital", pageId: "dashboard", route: "/dashboard", filters: {}, sort: null,
          selection: null, disabledFilters: [], version: 1,
        },
      }),
    };
    const incorrectRegistry = createToolRegistry({ metadata: new FakeMetadataStore(), ui: incorrectUi });
    const verification = await incorrectRegistry.execute(ctx, { tool: "navigate", args: { target: "medicines" } });
    expect(verification).toMatchObject({
      ok: true,
      data: { verified: false, mismatches: expect.arrayContaining([expect.objectContaining({ field: "pageId" })]) },
    });
  });

  it("reports disabled filters, invalid enum values, and disallowed numeric operators", async () => {
    await seedMedicinesPage();
    // Disable the filter through the simulated adapter before exercising the unavailable path.
    ui.setDisabledFilters(ctx.sessionId, ["category"]);
    const disabled = await execute({ tool: "set_filter", args: { filterId: "category", value: "Painkiller" } });
    expect(disabled).toMatchObject({ ok: false, error: { code: "FILTER_UNAVAILABLE", candidates: expect.any(Array) } });
    ui.setDisabledFilters(ctx.sessionId, []);

    const invalid = await execute({ tool: "set_filter", args: { filterId: "category", value: "Unknown" } });
    expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_FILTER_VALUE", candidates: expect.arrayContaining(["Painkiller"]) } });

    const operator = await execute({ tool: "set_filter", args: { filterId: "daysRemaining", op: "eq", value: 3 } });
    expect(operator).toMatchObject({ ok: false, error: { code: "INVALID_OPERATOR", candidates: expect.arrayContaining(["lt", "lte"]) } });
  });

  it("scripts the P4 failure demo for stockLevel", async () => {
    const demoSession = "stock-level-failure-demo";
    const scripted = createFakeToolRegistry({
      sessionId: demoSession,
      initialPageId: "medicines",
      disabledFilters: ["stockLevel"],
    });
    const demoCtx = { ...ctx, sessionId: demoSession };

    const rejected = await scripted.execute(demoCtx, {
      tool: "set_filter",
      args: { filterId: "stockLevel", value: "low" },
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "FILTER_UNAVAILABLE", candidates: expect.arrayContaining(["daysRemaining"]) },
    });

    const available = await scripted.execute(demoCtx, {
      tool: "get_available_filters",
      args: { pageId: "medicines" },
    });
    expect(available.ok).toBe(true);
    if (available.ok) {
      const data = available.data as { filters: { id: string }[]; disabledFilters: string[] };
      expect(data.filters.map((filter) => filter.id)).not.toContain("stockLevel");
      expect(data.disabledFilters).toContain("stockLevel");
    }
  });

  it("rejects a non-sortable field", async () => {
    await seedMedicinesPage();
    const result = await execute({ tool: "sort", args: { field: "category", direction: "asc" } });
    expect(result).toMatchObject({ ok: false, error: { code: "FIELD_NOT_ALLOWED", candidates: expect.arrayContaining(["stock"]) } });
  });

  it("returns INVALID_QUERY for malformed tool payloads", async () => {
    const result = await registry.execute(ctx, { tool: "navigate", args: { target: "" } } as ToolCall);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_QUERY" } });
  });
});
