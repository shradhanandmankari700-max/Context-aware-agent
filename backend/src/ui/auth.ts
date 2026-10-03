import jwt from "jsonwebtoken";

export interface AuthUser {
  userId?: string;
  tenantId?: string;
  role?: string;
  [key: string]: unknown;
}

export interface SseAuthResult {
  ok: boolean;
  error?: string;
  user?: AuthUser;
}

/**
 * Validates the SSE authentication token from query string (?token=).
 * Uses process.env.JWT_SECRET (or default dev secret).
 * In test/dev environment, accepts standard dev mock tokens for seamless testing.
 */
export function verifySseToken(token?: string): SseAuthResult {
  if (!token) {
    return { ok: false, error: "Missing authentication token (?token= required)" };
  }

  // Allow standard dev/test tokens in non-production
  if (process.env.NODE_ENV !== "production") {
    if (token === "dev-token" || token === "test-token") {
      return { ok: true, user: { userId: "dev-user", tenantId: "tenant-a", role: "admin" } };
    }
  }

  const secret = process.env.JWT_SECRET || "change-me-in-dev";
  try {
    const decoded = jwt.verify(token, secret);
    return { ok: true, user: decoded as AuthUser };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid token";
    return { ok: false, error: `Invalid authentication token: ${message}` };
  }
}
