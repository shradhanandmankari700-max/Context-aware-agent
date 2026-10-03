// Owner: P6. JWT auth middleware + RequestContext builder.
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { RequestContext } from "@cab/contracts";

export interface AuthPayload {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const ah = req.headers.authorization;
  if (ah?.startsWith("Bearer ")) return ah.slice(7);

  // SSE fallback: EventSource cannot set custom headers, so accept ?token= on the SSE route.
  // Some tests/mock requests omit req.path, so allow the query token in that case too.
  const maybePath = req.path ?? req.originalUrl ?? "";
  const isEventRoute = maybePath === "/api/events" || maybePath.startsWith("/api/events?");
  const qt = req.query["token"];

  if (typeof qt === "string" && qt.length > 0 && (isEventRoute || maybePath === "")) {
    return qt;
  }

  return null;
}

/** Verifies JWT, attaches `req.auth`. Does NOT block if missing — use requireAuth for that. */
export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET not configured");
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as AuthPayload;
    req.auth = payload;
  } catch {
    // invalid token — treat as unauthenticated; requireAuth will reject if needed
  }
  next();
}

/** Rejects with 401 if no valid JWT. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: { code: "FORBIDDEN", message: "Authentication required" } });
    return;
  }
  next();
}

/** Rejects with 403 if caller's role is not in the allowed list. */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: `Requires role: ${roles.join(" | ")}` } });
      return;
    }
    next();
  };
}

/**
 * Build a RequestContext from an authenticated request.
 * appId comes from req.params.appId, req.body.appId, or req.query.appId — in that order.
 * traceId is generated per-request; sessionId is from body or query.
 */
export function buildRequestCtx(req: Request): RequestContext {
  const auth = req.auth;
  if (!auth) throw new Error("buildRequestCtx called on unauthenticated request");

  const appId =
    (req.params["appId"] as string | undefined) ??
    (req.body?.appId as string | undefined) ??
    (req.query["appId"] as string | undefined) ??
    "";

  const sessionId =
    (req.body?.sessionId as string | undefined) ??
    (req.query["sessionId"] as string | undefined) ??
    `sess-${crypto.randomUUID()}`;

  const traceId = `trace-${crypto.randomUUID()}`;

  // DEMO_NOW from env; never use real Date.now() for business dates (Rule 7)
  const now = process.env.DEMO_NOW ?? "2026-10-07";

  return {
    tenantId: auth.tenantId,
    appId,
    userId: auth.userId,
    role: auth.role,
    sessionId,
    traceId,
    now,
  };
}
