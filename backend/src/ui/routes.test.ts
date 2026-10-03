import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "http";
import jwt from "jsonwebtoken";
import { uiRouter } from "./routes";
import { uiHub } from "./hub";
import type { UiState, UiAction } from "@cab/contracts";

describe("UI Routes integration", () => {
  let app: express.Express;
  let server: Server;
  let baseUrl: string;

  const validJwt = jwt.sign(
    { userId: "u1", tenantId: "tenant-a", role: "admin" },
    process.env.JWT_SECRET || "change-me-in-dev"
  );

  const mockState: UiState = {
    appId: "hospital",
    pageId: "medicines",
    route: "/inventory/medicines",
    filters: {},
    sort: null,
    selection: null,
    disabledFilters: [],
    version: 1,
  };

  const mockAction: UiAction = {
    type: "navigate",
    pageId: "medicines",
    route: "/inventory/medicines",
  };

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use(uiRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    uiHub.reset();
  });

  describe("GET /api/events (SSE)", () => {
    it("returns 400 when sessionId is missing", async () => {
      const res = await fetch(`${baseUrl}/api/events?token=test-token`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("AMBIGUOUS");
    });

    it("returns 401 when token is missing", async () => {
      const res = await fetch(`${baseUrl}/api/events?sessionId=s1`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("returns 401 when token is invalid in production mode", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const res = await fetch(`${baseUrl}/api/events?sessionId=s1&token=bad-token`);
        expect(res.status).toBe(401);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it("establishes SSE stream and sends hello event", async () => {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/events?sessionId=s1&token=${validJwt}`, {
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body?.getReader();
      expect(reader).toBeDefined();

      const chunk = await reader!.read();
      const text = new TextDecoder().decode(chunk.value);

      expect(text).toContain("event: hello");
      expect(text).toContain('"type":"hello"');
      expect(text).toContain('"sessionId":"s1"');

      controller.abort();
    });
  });

  describe("GET /api/ui-state", () => {
    it("returns 400 when sessionId is missing", async () => {
      const res = await fetch(`${baseUrl}/api/ui-state`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("AMBIGUOUS");
    });

    it("returns 404 when no state exists for session", async () => {
      const res = await fetch(`${baseUrl}/api/ui-state?sessionId=unknown`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe("INTERNAL");
    });

    it("returns 200 and state when present", async () => {
      uiHub.setState("s1", mockState);
      const res = await fetch(`${baseUrl}/api/ui-state?sessionId=s1`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(mockState);
    });
  });

  describe("POST /api/ui-state/report", () => {
    it("returns 400 on invalid payload", async () => {
      const res = await fetch(`${baseUrl}/api/ui-state/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: true }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_FILTER_VALUE");
    });

    it("returns 200 { ok: true } and updates state on valid report", async () => {
      const report = {
        sessionId: "s1",
        state: mockState,
      };

      const res = await fetch(`${baseUrl}/api/ui-state/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(uiHub.getState("s1")).toEqual(mockState);
    });
  });

  describe("POST /api/ui-actions", () => {
    it("returns 400 on invalid payload", async () => {
      const res = await fetch(`${baseUrl}/api/ui-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_VALUE");
    });

    it("returns 504 on timeout when no report arrives", async () => {
      const res = await fetch(`${baseUrl}/api/ui-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "s1",
          action: mockAction,
          timeoutMs: 80,
        }),
      });

      expect(res.status).toBe(504);
      const data = await res.json();
      expect(data.error.code).toBe("UI_TIMEOUT");
    });

    it("returns 200 with state when report arrives during await", async () => {
      // Fire action request
      const actionPromise = fetch(`${baseUrl}/api/ui-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "s1",
          action: mockAction,
          timeoutMs: 2000,
        }),
      });

      // Wait 50ms for dispatch to register, then report with actionId
      await new Promise((r) => setTimeout(r, 50));
      // Read the dispatched actionId from pending acks in hub
      const session = (uiHub as any).sessions.get("s1");
      const actionId = session.pendingAcks.keys().next().value;

      await fetch(`${baseUrl}/api/ui-state/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "s1",
          actionId,
          state: { ...mockState, version: 2 },
        }),
      });

      const res = await actionPromise;
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.actionId).toBe(actionId);
      expect(data.state.version).toBe(2);
    });
  });

  describe("POST /api/dev/faults", () => {
    it("returns 400 on invalid payload", async () => {
      const res = await fetch(`${baseUrl}/api/dev/faults`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", disableFilters: "not-an-array" }),
      });
      expect(res.status).toBe(400);
    });

    it("sets disabledFilters and reflects in state", async () => {
      uiHub.setState("s1", mockState);

      const res = await fetch(`${baseUrl}/api/dev/faults`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "s1",
          disableFilters: ["stockLevel"],
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.disabledFilters).toEqual(["stockLevel"]);

      const stateRes = await fetch(`${baseUrl}/api/ui-state?sessionId=s1`);
      const stateData = await stateRes.json();
      expect(stateData.disabledFilters).toEqual(["stockLevel"]);
    });
  });
});
