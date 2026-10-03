import "./env.js";
// Owner: P6. Keep this file thin — each team member's router is mounted here.
import express from "express";
import cors from "cors";
import type { Request, Response, NextFunction } from "express";

<<<<<<< HEAD
import { uiRouter } from "./routes/ui";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:5173" }));
app.use(express.json({ limit: "5mb" }));
app.use(uiRouter);
=======
import { createServices } from "./container.js";
import { attachAuth } from "./middleware/auth.js";
import { createAuthRouter } from "./routes/auth.js";
import { createTracesRouter } from "./routes/traces.js";
import { createEvalRouter } from "./routes/eval.js";
>>>>>>> 52d060d255c95766cc0eebfea73991442855500f

async function main() {
  const app = express();

  app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:5173" }));
  app.use(express.json({ limit: "5mb" }));

  // Attach JWT auth on every request (does NOT reject unauthenticated requests)
  app.use(attachAuth);

  // ── Boot services ─────────────────────────────────────────────────────────
  const services = await createServices();
  const pool = services.pool;

  // ── Health (public) ───────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      demoNow: process.env.DEMO_NOW ?? "2026-10-07",
      modules: services.moduleStatus,
    });
  });

  async function tryImport<T = Record<string, any>>(specifier: string): Promise<T | null> {
    try {
      return (await import(specifier)) as T;
    } catch {
      return null;
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  app.use("/api/auth", createAuthRouter(pool));

  // ── Metadata / Apps (P2) ─────────────────────────────────────────────────
  // P2 mounts their router at /api/apps via their routes file
  const metaMod = await tryImport<{ createAppsRouter: (metadata: any, pool: any) => any }>("./metadata/routes.js");
  if (metaMod?.createAppsRouter) {
    app.use("/api/apps", metaMod.createAppsRouter(services.metadata, pool));
  } else {
    console.warn("[server] metadata routes not ready — /api/apps not mounted");
  }

  // ── Data + Analytics (P1) ─────────────────────────────────────────────────
  const dataMod = await tryImport<{ createDataRouter: (services: any) => any }>("./data/routes.js");
  if (dataMod?.createDataRouter) {
    app.use("/api/data", dataMod.createDataRouter(services));
  } else {
    console.warn("[server] data routes not ready — /api/data not mounted");
  }

  const analyticsMod = await tryImport<{ createAnalyticsRouter: (services: any) => any }>("./analytics/routes.js");
  if (analyticsMod?.createAnalyticsRouter) {
    app.use("/api/analytics", analyticsMod.createAnalyticsRouter(services));
  } else {
    console.warn("[server] analytics routes not ready — /api/analytics not mounted");
  }

  // ── UI / SSE (P4) ─────────────────────────────────────────────────────────
  const uiMod = await tryImport<{ createUiRouter: (services: any) => any }>("./ui/routes.js");
  if (uiMod?.createUiRouter) {
    app.use("/api", uiMod.createUiRouter(services));
  } else {
    console.warn("[server] ui routes not ready — /api/events, /api/ui-state not mounted");
  }

  // ── Agent (P3) ────────────────────────────────────────────────────
  const agentMod = await tryImport<{ createAgentRouter: (services: any) => any }>("./agent/routes.js");
  if (agentMod?.createAgentRouter) {
    app.use("/api/agent", agentMod.createAgentRouter(services));
  } else {
    console.warn("[server] agent routes not ready — /api/agent not mounted");
  }

  // ── Traces + Eval (P6) ────────────────────────────────────────────────────
  app.use("/api/traces", createTracesRouter(services.traces, pool));
  app.use("/api/eval", createEvalRouter(pool));

  // ── Global error handler ──────────────────────────────────────────────────
  // Must be registered AFTER all routes (4-arg signature)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; code?: string; message?: string };
    const status = typeof e.status === "number" ? e.status : 500;
    const code = e.code ?? "INTERNAL";
    const message = e.message ?? "Unexpected error";
    if (status >= 500) console.error("[server] 500", message, err);
    res.status(status).json({ error: { code, message } });
  });

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`[server] backend on :${port}  DEMO_NOW=${process.env.DEMO_NOW ?? "2026-10-07"}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error", err);
  process.exit(1);
});
