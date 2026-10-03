// Owner: P6. GET /api/traces, GET /api/traces/:id
import { Router } from "express";
import type pg from "pg";
import type { TraceStore } from "@cab/contracts";
import { requireAuth, buildRequestCtx } from "../middleware/auth.js";
import { assertAppAccess, tenantOwnsApp } from "../middleware/assertAppAccess.js";

export function createTracesRouter(traces: TraceStore, pool: pg.Pool | null = null): Router {
  const router = Router();

  // GET /api/traces?appId=hospital
  router.get("/", requireAuth, assertAppAccess(pool), async (req, res, next) => {
    try {
      const ctx = buildRequestCtx(req);
      const appId = (req.query["appId"] as string | undefined) ?? ctx.appId;
      if (!appId) {
        res.status(400).json({ error: { code: "INVALID_QUERY", message: "appId query param required" } });
        return;
      }
      const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
      const list = await traces.list(appId, limit);
      res.json(list);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/traces/:id
  router.get("/:id", requireAuth, async (req, res, next) => {
    try {
      const trace = await traces.get(req.params["id"]);
      if (!trace) {
        res.status(404).json({ error: { code: "PAGE_NOT_FOUND", message: "Trace not found" } });
        return;
      }

      if (req.auth && !(await tenantOwnsApp(req.auth.tenantId, trace.appId, pool))) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Access to app denied" } });
        return;
      }

      res.json(trace);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
