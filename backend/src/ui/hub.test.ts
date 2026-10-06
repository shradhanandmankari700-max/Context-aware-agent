import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Response } from "express";
import { UiStateHub } from "./hub";
import type { UiState, UiAction, UiStateReport, SseEvent } from "@cab/contracts";

describe("UiStateHub", () => {
  let hub: UiStateHub;

  const mockState = (version: number = 1, disabledFilters: string[] = []): UiState => ({
    appId: "hospital",
    pageId: "medicines",
    route: "/inventory/medicines",
    filters: {},
    sort: null,
    selection: null,
    disabledFilters,
    version,
  });

  const mockAction: UiAction = {
    type: "navigate",
    pageId: "medicines",
    route: "/inventory/medicines",
  };

  beforeEach(() => {
    hub = new UiStateHub();
  });

  it("returns null state initially for an unknown session", () => {
    expect(hub.getState("sess-1")).toBeNull();
  });

  it("stores and retrieves state via setState", () => {
    const state = mockState(1);
    hub.setState("sess-1", state);
    expect(hub.getState("sess-1")).toEqual(state);
  });

  it("stores state from reportState and returns accepted", () => {
    const state = mockState(1);
    const report: UiStateReport = {
      sessionId: "sess-1",
      state,
    };

    const res = hub.reportState(report);
    expect(res.accepted).toBe(true);
    expect(res.stale).toBe(false);
    expect(hub.getState("sess-1")).toEqual(state);
  });

  it("ignores stale report versions", () => {
    hub.reportState({
      sessionId: "sess-1",
      state: mockState(5),
    });

    const staleReport: UiStateReport = {
      sessionId: "sess-1",
      state: mockState(3),
    };

    const res = hub.reportState(staleReport);
    expect(res.accepted).toBe(false);
    expect(res.stale).toBe(true);

    // State should still have version 5
    expect(hub.getState("sess-1")?.version).toBe(5);
  });

  it("dispatches action, emits ui_action event, and returns actionId", () => {
    const publishedEvents: SseEvent[] = [];
    const mockRes = {
      write: vi.fn((chunk: string) => {
        const match = chunk.match(/data: (.*)\n\n/);
        if (match) publishedEvents.push(JSON.parse(match[1]));
        return true;
      }),
      on: vi.fn(),
      writableEnded: false,
      destroyed: false,
    } as unknown as Response;

    hub.addConnection("sess-1", mockRes);
    const { actionId } = hub.dispatch("sess-1", mockAction);

    expect(actionId).toBeDefined();
    expect(typeof actionId).toBe("string");
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      type: "ui_action",
      actionId,
      action: mockAction,
      baseVersion: 0,
    });
  });

  it("registers the matching ack before emitting ui_action so an immediate frontend report is not lost", async () => {
    const sessionId = "immediate-report-session";
    const initialState: UiState = {
      ...mockState(1),
      filters: {},
    };
    hub.setState(sessionId, initialState);

    const mockRes = {
      write: vi.fn((chunk: string) => {
        const match = chunk.match(/data: (.*)\n\n/);
        if (!match) return true;
        const event = JSON.parse(match[1]) as SseEvent;
        if (event.type === "ui_action") {
          const filteredState: UiState = {
            ...initialState,
            filters: { stockLevel: { op: "eq", value: "low" } },
            version: 2,
          };
          hub.reportState({
            sessionId,
            actionId: event.actionId,
            state: filteredState,
          });
        }
        return true;
      }),
      on: vi.fn(),
      writableEnded: false,
      destroyed: false,
    } as unknown as Response;

    hub.addConnection(sessionId, mockRes);
    const action: UiAction = {
      type: "set_filter",
      pageId: "medicines",
      filterId: "stockLevel",
      value: { op: "eq", value: "low" },
    };
    const { actionId } = hub.dispatch(sessionId, action);
    const ack = await hub.awaitAck(sessionId, actionId, 1000);

    expect("timeout" in ack).toBe(false);
    if (!("timeout" in ack)) {
      expect(ack.state.filters.stockLevel).toEqual({ op: "eq", value: "low" });
    }
    expect(hub.getState(sessionId)?.filters.stockLevel).toEqual({ op: "eq", value: "low" });
  });

  it("awaitAck resolves when matching actionId is reported", async () => {
    const { actionId } = hub.dispatch("sess-1", mockAction);
    const expectedState = mockState(2);

    const ackPromise = hub.awaitAck("sess-1", actionId, 1000);

    hub.reportState({
      sessionId: "sess-1",
      actionId,
      state: expectedState,
    });

    const result = await ackPromise;
    expect("timeout" in result).toBe(false);
    if (!("timeout" in result)) {
      expect(result.state).toEqual(expectedState);
      expect(result.rejected).toBeUndefined();
    }
  });

  it("awaitAck handles rejected reports with code and reason", async () => {
    const { actionId } = hub.dispatch("sess-1", mockAction);
    const expectedState = mockState(1);

    const ackPromise = hub.awaitAck("sess-1", actionId, 1000);

    hub.reportState({
      sessionId: "sess-1",
      actionId,
      state: expectedState,
      rejected: {
        code: "FILTER_UNAVAILABLE",
        reason: "Filter stockLevel is disabled",
      },
    });

    const result = await ackPromise;
    expect("timeout" in result).toBe(false);
    if (!("timeout" in result)) {
      expect(result.rejected).toEqual({
        code: "FILTER_UNAVAILABLE",
        reason: "Filter stockLevel is disabled",
      });
    }
  });

  it("preserves an immediate matching report until awaitAck is called", async () => {
    const sessionId = "early-report-session";
    const state = mockState(3);
    const { actionId } = hub.dispatch(sessionId, mockAction);

    hub.reportState({ sessionId, actionId, state });

    const result = await hub.awaitAck(sessionId, actionId, 500);
    expect("timeout" in result).toBe(false);
    if (!("timeout" in result)) {
      expect(result.state).toEqual(state);
    }
  });

  it("awaitAck returns timeout: true when timeoutMs expires", async () => {
    const result = await hub.awaitAck("sess-1", "non-existent-action", 50);
    expect(result).toEqual({ timeout: true });
  });

  it("reflects disabledFilters in session state", () => {
    hub.setDisabledFilters("sess-1", ["stockLevel"]);
    expect(hub.getDisabledFilters("sess-1")).toEqual(["stockLevel"]);

    // If state is reported without disabledFilters, session disabledFilters are merged in
    hub.reportState({
      sessionId: "sess-1",
      state: mockState(1, []),
    });

    expect(hub.getState("sess-1")?.disabledFilters).toContain("stockLevel");

    // Setting faults after state exists updates the state immediately
    hub.setDisabledFilters("sess-1", ["stockLevel", "daysRemaining"]);
    expect(hub.getState("sess-1")?.disabledFilters).toEqual(["stockLevel", "daysRemaining"]);
  });

  it("manages SSE connections and removes closed ones on error or close", () => {
    let closeListener: () => void = () => {};
    const mockRes = {
      write: vi.fn(),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "close") closeListener = cb;
      }),
      writableEnded: false,
      destroyed: false,
    } as unknown as Response;

    const cleanup = hub.addConnection("sess-1", mockRes);
    expect(hub.getConnectionCount("sess-1")).toBe(1);

    hub.publish("sess-1", { type: "hello", sessionId: "sess-1" });
    expect(mockRes.write).toHaveBeenCalledTimes(1);

    // Trigger close
    closeListener();
    expect(hub.getConnectionCount("sess-1")).toBe(0);

    // Publishing again does not throw or write to closed connection
    hub.publish("sess-1", { type: "hello", sessionId: "sess-1" });
    expect(mockRes.write).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("reset clears all state and connections", () => {
    hub.setState("sess-1", mockState(1));
    hub.setDisabledFilters("sess-1", ["f1"]);
    hub.reset();

    expect(hub.getState("sess-1")).toBeNull();
    expect(hub.getDisabledFilters("sess-1")).toEqual([]);
    expect(hub.getConnectionCount("sess-1")).toBe(0);
  });
});
