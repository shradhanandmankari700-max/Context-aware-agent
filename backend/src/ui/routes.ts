import { Router, Request, Response } from "express";
import { z } from "zod";
import { UiStateReport, UiAction } from "@cab/contracts";
import { uiHub } from "./hub";
import { verifySseToken } from "./auth";

export const uiRouter = Router();

// Heartbeat interval in milliseconds (15s per requirement)
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * GET /api/events (SSE)
 * Stream ui_action, hello, agent_status, agent_step
 */
uiRouter.get(["/api/events", "/events"], (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;
  const token = req.query.token as string | undefined;

  if (!sessionId) {
    res.status(400).json({
      error: { code: "AMBIGUOUS", message: "sessionId query parameter is required" },
    });
    return;
  }

  const auth = verifySseToken(token);
  if (!auth.ok) {
    res.status(401).json({
      error: { code: "FORBIDDEN", message: auth.error ?? "Unauthorized" },
    });
    return;
  }

  // Set SSE response headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  // Send initial "hello" event
  const helloPayload = JSON.stringify({ type: "hello", sessionId });
  res.write(`event: hello\ndata: ${helloPayload}\n\n`);

  // Register connection in hub
  const cleanup = uiHub.addConnection(sessionId, res);

  // Set up periodic heartbeat comment
  const heartbeatTimer = setInterval(() => {
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.write(": heartbeat\n\n");
      }
    } catch {
      clearInterval(heartbeatTimer);
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  req.on("close", () => {
    clearInterval(heartbeatTimer);
    cleanup();
  });
});

/**
 * GET /api/ui-state?sessionId=...
 * Returns the latest reported UiState for the session.
 */
uiRouter.get(["/api/ui-state", "/ui-state"], (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({
      error: { code: "AMBIGUOUS", message: "sessionId query parameter is required" },
    });
    return;
  }

  const state = uiHub.getState(sessionId);
  if (!state) {
    res.status(404).json({
      error: { code: "INTERNAL", message: "No UI state reported for session" },
    });
    return;
  }

  res.json(state);
});

/**
 * POST /api/ui-state/report
 * Accepts UiStateReport from frontend, updates state (ignoring stale versions),
 * and resolves any awaiting dispatch ack for actionId.
 */
uiRouter.post(["/api/ui-state/report", "/ui-state/report"], (req: Request, res: Response) => {
  const parseResult = UiStateReport.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: {
        code: "INVALID_FILTER_VALUE",
        message: `Invalid UiStateReport: ${parseResult.error.message}`,
      },
    });
    return;
  }

  const result = uiHub.reportState(parseResult.data);
  res.json({ ok: true, stale: result.stale });
});

const UiActionBody = z.object({
  sessionId: z.string().min(1),
  action: UiAction,
  timeoutMs: z.number().int().positive().optional().default(3000),
});

/**
 * POST /api/ui-actions
 * Manual testing endpoint to dispatch a UiAction and await acknowledgment.
 */
uiRouter.post(["/api/ui-actions", "/ui-actions"], async (req: Request, res: Response) => {
  const parseResult = UiActionBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: {
        code: "INVALID_VALUE",
        message: `Invalid ui action request: ${parseResult.error.message}`,
      },
    });
    return;
  }

  const { sessionId, action, timeoutMs } = parseResult.data;
  const { actionId } = uiHub.dispatch(sessionId, action);
  const ack = await uiHub.awaitAck(sessionId, actionId, timeoutMs);

  if ("timeout" in ack) {
    res.status(504).json({
      error: {
        code: "UI_TIMEOUT",
        message: `Timeout waiting for UI state report for action ${actionId}`,
      },
    });
    return;
  }

  res.json({
    actionId,
    state: ack.state,
    ...(ack.rejected ? { rejected: ack.rejected } : {}),
  });
});

const FaultsBody = z.object({
  sessionId: z.string().min(1),
  disableFilters: z.array(z.string()).default([]),
});

/**
 * POST /api/dev/faults
 * Developer fault-injection endpoint to disable specific filters for a session.
 */
uiRouter.post(["/api/dev/faults", "/dev/faults"], (req: Request, res: Response) => {
  const parseResult = FaultsBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: {
        code: "INVALID_VALUE",
        message: `Invalid faults request: ${parseResult.error.message}`,
      },
    });
    return;
  }

  const { sessionId, disableFilters } = parseResult.data;
  uiHub.setDisabledFilters(sessionId, disableFilters);

  res.json({
    ok: true,
    sessionId,
    disabledFilters: disableFilters,
  });
});
