import { Router } from "express";
import crypto from "node:crypto";
import { ChatRequest, ConfirmRequest, type AgentService, type RequestContext } from "@cab/contracts";

export function createAgentRouter(agent: AgentService): Router {
  const router = Router();

  router.post("/chat", async (req, res) => {
    const parseRes = ChatRequest.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({
        error: {
          code: "INVALID_QUERY",
          message: "Invalid chat request body",
          details: parseRes.error.format(),
        },
      });
    }

    const body = parseRes.data;
    const auth = req.auth;

    const ctx: RequestContext = {
      tenantId: auth?.tenantId ?? "tenant_demo",
      appId: body.appId,
      userId: auth?.userId ?? "user_demo",
      role: auth?.role ?? "staff",
      sessionId: body.sessionId,
      traceId: (req.headers["x-trace-id"] as string) || `trace-${crypto.randomUUID().slice(0, 8)}`,
      now: process.env.DEMO_NOW || "2026-10-07",
    };

    try {
      const response = await agent.chat(ctx, body);
      res.json(response);
    } catch (err: any) {
      console.error("[AgentRouter] Error in /chat:", err);
      const message = err instanceof Error ? err.message : "The AI request failed.";
      res.json({
        traceId: ctx.traceId,
        sessionId: body.sessionId,
        status: "failed",
        answer: [{ type: "text", markdown: message, provenance: [] }],
        steps: [],
        uiState: null,
        verification: { ok: false, attempts: 0, expected: null, actual: null, mismatches: [] },
      });
    }
  });

  router.post("/confirm", async (req, res) => {
    const parseRes = ConfirmRequest.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({
        error: {
          code: "INVALID_QUERY",
          message: "Invalid confirm request body",
          details: parseRes.error.format(),
        },
      });
    }

    const body = parseRes.data;
    const auth = req.auth;

    const ctx: RequestContext = {
      tenantId: auth?.tenantId ?? "tenant_demo",
      appId: (req.body.appId as string) || "hospital",
      userId: auth?.userId ?? "user_demo",
      role: auth?.role ?? "staff",
      sessionId: body.sessionId,
      traceId: (req.headers["x-trace-id"] as string) || `trace-${crypto.randomUUID().slice(0, 8)}`,
      now: process.env.DEMO_NOW || "2026-10-07",
    };

    try {
      const response = await agent.confirm(ctx, body);
      res.json(response);
    } catch (err: any) {
      console.error("[AgentRouter] Error in /confirm:", err);
      res.status(500).json({
        error: {
          code: "INTERNAL",
          message: err.message || "Internal confirmation error",
        },
      });
    }
  });

  return router;
}
