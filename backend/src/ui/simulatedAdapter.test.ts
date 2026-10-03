import { describe, it, expect, beforeEach } from "vitest";
import { AppMetadata, UiAction, UiState } from "@cab/contracts";
import hospitalJson from "../../../metadata/hospital.json";
import { SimulatedUiAdapter } from "./simulatedAdapter";

describe("SimulatedUiAdapter", () => {
  let metadata: AppMetadata;
  let adapter: SimulatedUiAdapter;
  const sessionId = "test-session-1";

  beforeEach(() => {
    metadata = AppMetadata.parse(hospitalJson);
    adapter = new SimulatedUiAdapter({
      metadata,
      defaultAppId: "hospital",
    });
  });

  it("returns null state when session has not been initialized or navigated", async () => {
    const state = await adapter.getState("fresh-session");
    expect(state).toBeNull();
  });

  it("navigates to a page, creating initial UiState with empty filters and canonical route", async () => {
    const action: UiAction = {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    };

    const { actionId } = await adapter.dispatch(sessionId, action);
    expect(actionId).toBeDefined();

    const ack = await adapter.awaitAck(sessionId, actionId);
    expect("timeout" in ack).toBe(false);
    if ("state" in ack) {
      expect(ack.state.pageId).toBe("medicines");
      expect(ack.state.route).toBe("/inventory/medicines");
      expect(ack.state.filters).toEqual({});
      expect(ack.state.sort).toBeNull();
      expect(ack.state.selection).toBeNull();
      expect(ack.state.version).toBe(1);
    }

    const state = await adapter.getState(sessionId);
    expect(state?.pageId).toBe("medicines");
    expect(state?.version).toBe(1);
  });

  it("writes FilterValue on set_filter and increments version", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    const filterAction: UiAction = {
      type: "set_filter",
      pageId: "medicines",
      filterId: "category",
      value: { op: "eq", value: "Painkiller" },
    };

    const { actionId } = await adapter.dispatch(sessionId, filterAction);
    const ack = await adapter.awaitAck(sessionId, actionId);

    if ("state" in ack) {
      expect(ack.rejected).toBeUndefined();
      expect(ack.state.filters.category).toEqual({ op: "eq", value: "Painkiller" });
      expect(ack.state.version).toBe(2);
    }
  });

  it("updates existing filter and handles multiple filters", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    await adapter.dispatch(sessionId, {
      type: "set_filter",
      pageId: "medicines",
      filterId: "category",
      value: { op: "eq", value: "Painkiller" },
    });

    await adapter.dispatch(sessionId, {
      type: "set_filter",
      pageId: "medicines",
      filterId: "stockLevel",
      value: { op: "eq", value: "low" },
    });

    const state = await adapter.getState(sessionId);
    expect(state?.filters.category).toEqual({ op: "eq", value: "Painkiller" });
    expect(state?.filters.stockLevel).toEqual({ op: "eq", value: "low" });
    expect(state?.version).toBe(3);
  });

  it("clears a single filter on clear_filter", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    await adapter.dispatch(sessionId, {
      type: "set_filter",
      pageId: "medicines",
      filterId: "category",
      value: { op: "eq", value: "Painkiller" },
    });

    await adapter.dispatch(sessionId, {
      type: "set_filter",
      pageId: "medicines",
      filterId: "stockLevel",
      value: { op: "eq", value: "low" },
    });

    const clearAction: UiAction = {
      type: "clear_filter",
      pageId: "medicines",
      filterId: "category",
    };

    const { actionId } = await adapter.dispatch(sessionId, clearAction);
    const ack = await adapter.awaitAck(sessionId, actionId);

    if ("state" in ack) {
      expect(ack.state.filters.category).toBeUndefined();
      expect(ack.state.filters.stockLevel).toEqual({ op: "eq", value: "low" });
      expect(ack.state.version).toBe(4);
    }
  });

  it("clears all filters on clear_all_filters", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    await adapter.dispatch(sessionId, {
      type: "set_filter",
      pageId: "medicines",
      filterId: "category",
      value: { op: "eq", value: "Painkiller" },
    });

    const { actionId } = await adapter.dispatch(sessionId, {
      type: "clear_all_filters",
      pageId: "medicines",
    });

    const ack = await adapter.awaitAck(sessionId, actionId);
    if ("state" in ack) {
      expect(ack.state.filters).toEqual({});
      expect(ack.state.version).toBe(3);
    }
  });

  it("applies set_date_range as op: 'between'", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    const dateAction: UiAction = {
      type: "set_date_range",
      pageId: "medicines",
      filterId: "expiryDate",
      start: "2026-10-01",
      end: "2026-10-31",
    };

    const { actionId } = await adapter.dispatch(sessionId, dateAction);
    const ack = await adapter.awaitAck(sessionId, actionId);

    if ("state" in ack) {
      expect(ack.state.filters.expiryDate).toEqual({
        op: "between",
        value: ["2026-10-01", "2026-10-31"],
      });
      expect(ack.state.version).toBe(2);
    }
  });

  it("updates sort state on sort action", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    const sortAction: UiAction = {
      type: "sort",
      pageId: "medicines",
      widgetId: "medicineStock",
      field: "days_remaining",
      direction: "asc",
    };

    const { actionId } = await adapter.dispatch(sessionId, sortAction);
    const ack = await adapter.awaitAck(sessionId, actionId);

    if ("state" in ack) {
      expect(ack.state.sort).toEqual({
        widgetId: "medicineStock",
        field: "days_remaining",
        direction: "asc",
      });
      expect(ack.state.version).toBe(2);
    }
  });

  it("updates selection on open_details", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    const detailsAction: UiAction = {
      type: "open_details",
      pageId: "medicines",
      widgetId: "medicineStock",
      rowKey: "med-123",
    };

    const { actionId } = await adapter.dispatch(sessionId, detailsAction);
    const ack = await adapter.awaitAck(sessionId, actionId);

    if ("state" in ack) {
      expect(ack.state.selection).toEqual({
        widgetId: "medicineStock",
        rowKey: "med-123",
      });
      expect(ack.state.version).toBe(2);
    }
  });

  it("preserves filters when navigating to the SAME page", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    await adapter.dispatch(sessionId, {
      type: "set_filter",
      pageId: "medicines",
      filterId: "category",
      value: { op: "eq", value: "Painkiller" },
    });

    const { actionId } = await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    const ack = await adapter.awaitAck(sessionId, actionId);
    if ("state" in ack) {
      expect(ack.state.pageId).toBe("medicines");
      expect(ack.state.filters.category).toEqual({ op: "eq", value: "Painkiller" });
      expect(ack.state.version).toBe(3);
    }
  });

  it("resets filters and sort when navigating to a DIFFERENT page", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    await adapter.dispatch(sessionId, {
      type: "set_filter",
      pageId: "medicines",
      filterId: "category",
      value: { op: "eq", value: "Painkiller" },
    });

    await adapter.dispatch(sessionId, {
      type: "sort",
      pageId: "medicines",
      widgetId: "medicineStock",
      field: "stock",
      direction: "desc",
    });

    // Navigate to purchases
    const { actionId } = await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "purchases",
      route: "/inventory/purchases",
    });

    const ack = await adapter.awaitAck(sessionId, actionId);
    if ("state" in ack) {
      expect(ack.state.pageId).toBe("purchases");
      expect(ack.state.route).toBe("/inventory/purchases");
      expect(ack.state.filters).toEqual({});
      expect(ack.state.sort).toBeNull();
      expect(ack.state.selection).toBeNull();
      expect(ack.state.version).toBe(4);
    }
  });

  it("honors disabledFilters by returning rejected FILTER_UNAVAILABLE on set_filter", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    // Disable stockLevel filter (Failure demo scenario)
    adapter.setDisabledFilters(sessionId, ["stockLevel"]);

    const disabledAction: UiAction = {
      type: "set_filter",
      pageId: "medicines",
      filterId: "stockLevel",
      value: { op: "eq", value: "low" },
    };

    const { actionId } = await adapter.dispatch(sessionId, disabledAction);
    const ack = await adapter.awaitAck(sessionId, actionId);

    if ("state" in ack) {
      expect(ack.rejected).toBeDefined();
      expect(ack.rejected?.code).toBe("FILTER_UNAVAILABLE");
      expect(ack.state.filters.stockLevel).toBeUndefined();
    }

    const state = await adapter.getState(sessionId);
    expect(state?.filters.stockLevel).toBeUndefined();
    expect(state?.disabledFilters).toContain("stockLevel");
  });

  it("honors disabledFilters on set_date_range", async () => {
    await adapter.dispatch(sessionId, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    adapter.setDisabledFilters(sessionId, ["expiryDate"]);

    const dateAction: UiAction = {
      type: "set_date_range",
      pageId: "medicines",
      filterId: "expiryDate",
      start: "2026-10-01",
      end: "2026-10-31",
    };

    const { actionId } = await adapter.dispatch(sessionId, dateAction);
    const ack = await adapter.awaitAck(sessionId, actionId);

    if ("state" in ack) {
      expect(ack.rejected?.code).toBe("FILTER_UNAVAILABLE");
      expect(ack.state.filters.expiryDate).toBeUndefined();
    }
  });

  it("isolates sessions completely", async () => {
    const sessionA = "session-a";
    const sessionB = "session-b";

    await adapter.dispatch(sessionA, {
      type: "navigate",
      pageId: "medicines",
      route: "/inventory/medicines",
    });

    await adapter.dispatch(sessionA, {
      type: "set_filter",
      pageId: "medicines",
      filterId: "category",
      value: { op: "eq", value: "Antibiotic" },
    });

    await adapter.dispatch(sessionB, {
      type: "navigate",
      pageId: "purchases",
      route: "/inventory/purchases",
    });

    const stateA = await adapter.getState(sessionA);
    const stateB = await adapter.getState(sessionB);

    expect(stateA?.pageId).toBe("medicines");
    expect(stateA?.filters.category).toEqual({ op: "eq", value: "Antibiotic" });

    expect(stateB?.pageId).toBe("purchases");
    expect(stateB?.filters).toEqual({});
  });

  it("returns timeout: true when awaiting unknown actionId", async () => {
    const ack = await adapter.awaitAck(sessionId, "non-existent-action-id", 50);
    expect("timeout" in ack).toBe(true);
    if ("timeout" in ack) {
      expect(ack.timeout).toBe(true);
    }
  });

  it("allows setting arbitrary UiState directly via setState", async () => {
    const customState: UiState = {
      appId: "hospital",
      pageId: "reports",
      route: "/reports",
      filters: {
        reportPeriod: { op: "between", value: ["2026-01-01", "2026-06-30"] },
      },
      sort: null,
      selection: null,
      disabledFilters: [],
      version: 10,
    };

    adapter.setState(sessionId, customState);

    const state = await adapter.getState(sessionId);
    expect(state?.pageId).toBe("reports");
    expect(state?.version).toBe(10);
    expect(state?.filters.reportPeriod).toBeDefined();
  });
});
