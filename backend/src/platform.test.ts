// Owner: P6. Tests for auth middleware and in-memory fake trace store.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import jwt from "jsonwebtoken";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    query: {},
    body: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): { res: Response; statusCode: number; body: unknown } {
  const ctx = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { ctx.statusCode = code; return res; },
    json(body: unknown) { ctx.body = body; return res; },
  } as unknown as Response;
  return { res, ...ctx, get statusCode() { return ctx.statusCode; }, get body() { return ctx.body; } };
}

const next: NextFunction = vi.fn();

// ── Auth middleware ───────────────────────────────────────────────────────────

describe("auth middleware", async () => {
  const { attachAuth, requireAuth, requireRole, buildRequestCtx } = await import("./middleware/auth.js");

  beforeEach(() => {
    process.env["JWT_SECRET"] = "test-secret";
    process.env["DEMO_NOW"] = "2026-10-07";
    vi.mocked(next).mockClear();
  });

  it("attachAuth: sets req.auth for valid token in Authorization header", () => {
    const token = jwt.sign({ userId: "u1", tenantId: "tenant-a", role: "admin", email: "admin@test.demo" }, "test-secret");
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const { res } = makeRes();
    attachAuth(req, res, next);
    expect(req.auth).toBeDefined();
    expect(req.auth?.role).toBe("admin");
    expect(next).toHaveBeenCalledOnce();
  });

  it("attachAuth: sets req.auth for valid token in ?token= query param (SSE)", () => {
    const token = jwt.sign({ userId: "u2", tenantId: "tenant-b", role: "staff", email: "staff@test.demo" }, "test-secret");
    const req = makeReq({ query: { token } });
    const { res } = makeRes();
    attachAuth(req, res, next);
    expect(req.auth?.role).toBe("staff");
  });

  it("attachAuth: does NOT block on missing token, just calls next", () => {
    const req = makeReq();
    const { res } = makeRes();
    attachAuth(req, res, next);
    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("attachAuth: does NOT block on invalid token, just calls next", () => {
    const req = makeReq({ headers: { authorization: "Bearer bad-token" } });
    const { res } = makeRes();
    attachAuth(req, res, next);
    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("requireAuth: rejects 401 when no auth", () => {
    const req = makeReq();
    const ctx = makeRes();
    requireAuth(req, ctx.res, next);
    expect(ctx.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("requireAuth: calls next when auth present", () => {
    const req = makeReq();
    req.auth = { userId: "u1", tenantId: "t", role: "admin", email: "a@b.com" };
    const { res } = makeRes();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("requireRole: rejects 403 for wrong role", () => {
    const req = makeReq();
    req.auth = { userId: "u1", tenantId: "t", role: "viewer", email: "a@b.com" };
    const ctx = makeRes();
    requireRole("admin")(req, ctx.res, next);
    expect(ctx.statusCode).toBe(403);
  });

  it("requireRole: passes for correct role", () => {
    const req = makeReq();
    req.auth = { userId: "u1", tenantId: "t", role: "admin", email: "a@b.com" };
    const { res } = makeRes();
    requireRole("admin", "staff")(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("buildRequestCtx: assembles ctx from req correctly", () => {
    const req = makeReq({ params: { appId: "hospital" }, body: { sessionId: "sess-1" } });
    req.auth = { userId: "u1", tenantId: "tenant-a", role: "admin", email: "admin@hospital.demo" };
    const ctx = buildRequestCtx(req);
    expect(ctx.appId).toBe("hospital");
    expect(ctx.tenantId).toBe("tenant-a");
    expect(ctx.sessionId).toBe("sess-1");
    expect(ctx.now).toBe("2026-10-07");
    expect(ctx.traceId).toMatch(/^trace-/);
  });
});

// ── Fake TraceStore ───────────────────────────────────────────────────────────

describe("fakeTraceStore", async () => {
  const { createFakeTraceStore } = await import("./fake.js");

  it("save, get, list round-trip", async () => {
    const store = createFakeTraceStore();
    const trace = {
      traceId: "t1", sessionId: "s1", appId: "hospital", userId: "u1",
      createdAt: "2026-10-07T00:00:00Z",
      userMessage: "show low stock", intent: "navigate + filter",
      retrieved: [], turns: [], toolCalls: [],
      uiBefore: null, uiAfter: null, queries: [], recoveries: [],
      finalAnswer: "Found 4 low-stock medicines", status: "ok",
      invalidActionsBlocked: 0, invalidActionsExecuted: 0,
      llm: { calls: 2, cachedCalls: 0, provider: "gemini", model: "gemini-flash" },
      latencyMs: { total: 1200, firstAction: 400, llm: 800 },
    };
    await store.save(trace);
    const got = await store.get("t1");
    expect(got?.traceId).toBe("t1");
    expect(got?.appId).toBe("hospital");

    const list = await store.list("hospital");
    expect(list).toHaveLength(1);

    const empty = await store.list("hotel");
    expect(empty).toHaveLength(0);

    const missing = await store.get("not-there");
    expect(missing).toBeNull();
  });

  it("list caps at 200", async () => {
    const store = createFakeTraceStore();
    const base = {
      sessionId: "s", appId: "hospital", userId: "u",
      createdAt: "2026-10-07T00:00:00Z", userMessage: "x", intent: "",
      retrieved: [], turns: [], toolCalls: [], uiBefore: null, uiAfter: null,
      queries: [], recoveries: [], finalAnswer: "", status: "ok",
      invalidActionsBlocked: 0, invalidActionsExecuted: 0,
      llm: { calls: 0, cachedCalls: 0, provider: "fake", model: "fake" },
      latencyMs: { total: 0 },
    };
    for (let i = 0; i < 250; i++) {
      await store.save({ ...base, traceId: `t${i}` });
    }
    expect((await store.list("hospital", 200)).length).toBe(200);
  });

  it("createTraceStore.save catches errors and does not throw", async () => {
    const { createTraceStore } = await import("./database/traceStore.js");
    const failingPool = {
      query: vi.fn().mockRejectedValue(new Error("DB connection lost")),
    } as unknown as import("pg").Pool;

    const store = createTraceStore(failingPool);
    await expect(
      store.save({
        traceId: "t-fail", sessionId: "s", appId: "hospital", userId: "u",
        createdAt: "2026-10-07T00:00:00Z", userMessage: "test", intent: "test",
        retrieved: [], turns: [], toolCalls: [], uiBefore: null, uiAfter: null,
        queries: [], recoveries: [], finalAnswer: "ans", status: "ok",
        invalidActionsBlocked: 0, invalidActionsExecuted: 0,
        llm: { calls: 1, cachedCalls: 0, provider: "fake", model: "fake" },
        latencyMs: { total: 100 },
      }),
    ).resolves.not.toThrow();
  });
});

// ── Container & Env ───────────────────────────────────────────────────────────

describe("trace route app access", async () => {
  const { createTracesRouter } = await import("./routes/traces.js");
  const { createFakeTraceStore } = await import("./fake.js");

  it("rejects cross-tenant access to another app's traces", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.auth = { userId: "u-tenant-b", tenantId: "tenant-b", role: "viewer", email: "viewer@hotel.demo" };
      next();
    });
    app.use("/api/traces", createTracesRouter(createFakeTraceStore()));

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/traces?appId=hospital`);
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("container & env", async () => {
  const { createServices } = await import("./container.js");
  const { closePool } = await import("./database/pool.js");

  it("loads repo-root env via env.js without error", async () => {
    await import("./env.js");
    expect(process.env.DEMO_NOW).toBeDefined();
  });

  it("createServices: handles empty DATABASE_URL gracefully with fakes and pool=null", async () => {
    const origDb = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    await closePool();

    const services = await createServices();
    expect(services.pool).toBeNull();
    expect(services.moduleStatus).toBeDefined();
    expect(services.moduleStatus.metadata).toBe("fake");
    expect(services.moduleStatus.data).toBe("fake");
    expect(services.moduleStatus.traces).toBe("fake");

    if (origDb) process.env.DATABASE_URL = origDb;
  });

  it("createServices: marks fake (db unreachable) when DATABASE_URL fails SELECT 1 ping", async () => {
    const origDb = process.env.DATABASE_URL;
    await closePool();
    // Use an unroutable/unreachable port on localhost
    process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54329/unreachable_db";

    const services = await createServices();
    expect(services.pool).toBeNull();
    expect(services.moduleStatus.metadata).toBe("fake (db unreachable)");
    expect(services.moduleStatus.data).toBe("fake (db unreachable)");
    expect(services.moduleStatus.traces).toBe("fake (db unreachable)");

    await closePool();
    if (origDb) process.env.DATABASE_URL = origDb;
    else delete process.env.DATABASE_URL;
  });

  it("createServices: exits on STRICT_REAL=1 when modules are fake", async () => {
    const origStrict = process.env.STRICT_REAL;
    const origDb = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    await closePool();
    process.env.STRICT_REAL = "1";

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(createServices()).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    if (origStrict) process.env.STRICT_REAL = origStrict;
    else delete process.env.STRICT_REAL;
    if (origDb) process.env.DATABASE_URL = origDb;
  });
});


