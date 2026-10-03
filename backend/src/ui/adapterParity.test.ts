import { describe, it, expect, beforeEach } from "vitest";
import { AppMetadata, UiAction, UiState, UiAdapter } from "@cab/contracts";
import hospitalJson from "../../../metadata/hospital.json";
import { SimulatedUiAdapter } from "./simulatedAdapter";
import { ApiUiAdapter } from "./apiAdapter";
import { UiStateHub } from "./hub";
import { createUiAdapter } from "./adapterFactory";
import { createFakeUiAdapter, fakeHospitalMetadata } from "./fake";
import { PlaywrightPage, PlaywrightUiAdapter } from "./playwrightAdapter";

describe("UiAdapter Implementations Parity & Factory", () => {
  const metadata = AppMetadata.parse(hospitalJson);

  describe("Factory: createUiAdapter", () => {
    it("creates an ApiUiAdapter instance when kind is 'api'", () => {
      const adapter = createUiAdapter("api");
      expect(adapter).toBeInstanceOf(ApiUiAdapter);
    });

    it("creates a SimulatedUiAdapter instance when kind is 'simulated'", () => {
      const adapter = createUiAdapter("simulated", { metadata });
      expect(adapter).toBeInstanceOf(SimulatedUiAdapter);
    });

    it("creates a PlaywrightUiAdapter when supplied a page and metadata", () => {
      const adapter = createUiAdapter("playwright", { page: browserHarness(metadata), metadata });
      expect(adapter).toBeInstanceOf(PlaywrightUiAdapter);
    });

    it("creates a ready-to-use fake adapter via createFakeUiAdapter", async () => {
      const fake = createFakeUiAdapter("sess-demo", "medicines");
      const state = await fake.getState("sess-demo");
      expect(state).not.toBeNull();
      expect(state?.pageId).toBe("medicines");
      expect(state?.route).toBe("/inventory/medicines");
    });
  });

  describe("ApiUiAdapter unit tests", () => {
    let hub: UiStateHub;
    let apiAdapter: ApiUiAdapter;
    const sessionId = "api-session-test";

    beforeEach(() => {
      hub = new UiStateHub();
      apiAdapter = new ApiUiAdapter(hub);
    });

    it("implements getState, dispatch, and awaitAck via hub", async () => {
      const initialState = await apiAdapter.getState(sessionId);
      expect(initialState).toBeNull();

      const action: UiAction = {
        type: "navigate",
        pageId: "medicines",
        route: "/inventory/medicines",
      };

      const { actionId } = await apiAdapter.dispatch(sessionId, action);
      expect(actionId).toBeDefined();

      // Simulate the frontend reporting the updated state with actionId
      const reportedState: UiState = {
        appId: "hospital",
        pageId: "medicines",
        route: "/inventory/medicines",
        filters: {},
        sort: null,
        selection: null,
        disabledFilters: [],
        version: 1,
      };

      // Frontend sends report back to hub
      hub.reportState({
        sessionId,
        actionId,
        state: reportedState,
      });

      const ack = await apiAdapter.awaitAck(sessionId, actionId, 1000);
      expect("timeout" in ack).toBe(false);
      if ("state" in ack) {
        expect(ack.state.pageId).toBe("medicines");
        expect(ack.state.version).toBe(1);
      }

      const finalState = await apiAdapter.getState(sessionId);
      expect(finalState?.pageId).toBe("medicines");
    });

    it("times out if no report is received", async () => {
      const action: UiAction = {
        type: "navigate",
        pageId: "medicines",
        route: "/inventory/medicines",
      };

      const { actionId } = await apiAdapter.dispatch(sessionId, action);
      const ack = await apiAdapter.awaitAck(sessionId, actionId, 50);
      expect("timeout" in ack).toBe(true);
    });
  });

  describe("Contract parity between SimulatedUiAdapter and ApiUiAdapter", () => {
    const testCases: { name: string; create: () => Promise<{ adapter: UiAdapter; onDispatch?: (sessionId: string, actionId: string, action: UiAction) => void }> }[] = [
      {
        name: "SimulatedUiAdapter",
        create: async () => ({
          adapter: new SimulatedUiAdapter({ metadata }),
        }),
      },
      {
        name: "ApiUiAdapter with simulated client loop",
        create: async () => {
          const hub = new UiStateHub();
          const adapter = new ApiUiAdapter(hub);
          return {
            adapter,
            onDispatch: (sessionId, actionId, action) => {
              if (action.type === "navigate") {
                hub.reportState({
                  sessionId,
                  actionId,
                  state: {
                    appId: "hospital",
                    pageId: action.pageId,
                    route: action.route,
                    filters: {},
                    sort: null,
                    selection: null,
                    disabledFilters: [],
                    version: 1,
                  },
                });
              }
            },
          };
        },
      },
      {
        name: "PlaywrightUiAdapter with browser harness",
        create: async () => ({ adapter: new PlaywrightUiAdapter({ page: browserHarness(metadata), metadata }) }),
      },
    ];

    for (const { name, create } of testCases) {
      it(`[${name}] satisfies the UiAdapter interface contract`, async () => {
        const { adapter, onDispatch } = await create();
        const testSession = `parity-${name.toLowerCase().replace(/\s+/g, "-")}`;

        const beforeState = await adapter.getState(testSession);
        expect(beforeState).toBeNull();

        const action: UiAction = {
          type: "navigate",
          pageId: "medicines",
          route: "/inventory/medicines",
        };

        const { actionId } = await adapter.dispatch(testSession, action);
        expect(typeof actionId).toBe("string");
        expect(actionId.length).toBeGreaterThan(0);

        if (onDispatch) {
          onDispatch(testSession, actionId, action);
        }

        const ack = await adapter.awaitAck(testSession, actionId, 1000);
        expect("state" in ack).toBe(true);
        if ("state" in ack) {
          expect(ack.state.pageId).toBe("medicines");
        }

        const afterState = await adapter.getState(testSession);
        expect(afterState?.pageId).toBe("medicines");
      });
    }
  });
});

function browserHarness(metadata: AppMetadata): PlaywrightPage {
  let currentUrl = "http://localhost/";
  const makeLocator = (testId: string) => ({
    click: async () => {
      if (testId.startsWith("nav-")) {
        const page = metadata.pages.find((candidate) => candidate.id === testId.slice(4));
        if (page) currentUrl = `http://localhost${page.route}`;
      }
    },
    fill: async () => undefined,
    selectOption: async () => undefined,
    count: async () => Number(testId.startsWith("nav-")),
    getAttribute: async () => null,
  });
  return {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = new URL(url, currentUrl).toString(); },
    locator: (selector) => makeLocator(selector),
    getByTestId: makeLocator,
    waitForURL: async (match) => {
      const url = new URL(currentUrl);
      if (typeof match === "string" && !currentUrl.startsWith(match)) throw new Error("URL mismatch");
      if (match instanceof RegExp && !match.test(currentUrl)) throw new Error("URL mismatch");
      if (typeof match === "function" && !match(url)) throw new Error("URL mismatch");
    },
  };
}
