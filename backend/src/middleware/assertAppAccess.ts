// Owner: P6. Tenant isolation guard — every app-scoped route calls this.
import type { Request, Response, NextFunction } from "express";
import type pg from "pg";

const FORBIDDEN_RESPONSE = { error: { code: "FORBIDDEN", message: "Access to app denied" } };

// Default tenant mapping for fixture apps when database is not connected
const FAKE_APP_TENANTS: Record<string, string> = {
  hospital: "tenant-a",
  hotel: "tenant-b",
};

export async function tenantOwnsApp(tenantId: string, appId: string, pool: pg.Pool | null): Promise<boolean> {
  const trimmedAppId = appId.trim();

  if (!trimmedAppId) return false;

  if (!pool) {
    return FAKE_APP_TENANTS[trimmedAppId] === tenantId;
  }

  try {
    const { rows } = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM applications WHERE id = $1 LIMIT 1",
      [trimmedAppId],
    );
    return rows.length > 0 && rows[0].tenant_id === tenantId;
  } catch {
    return false;
  }
}

/**
 * Middleware factory. Verifies the appId (read from params, then body, then query) belongs to the caller's tenant.
 * Uses the `applications` platform table (or in-memory fake list if pool is null).
 * Returns 400 if appId is missing.
 * Returns the SAME 403 body for not found and other tenant to prevent app enumeration.
 */
export function assertAppAccess(pool: pg.Pool | null) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: { code: "FORBIDDEN", message: "Authentication required" } });
      return;
    }

    const appId =
      req.params?.["appId"] ||
      (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>)["appId"] : undefined) ||
      (typeof req.query?.["appId"] === "string" ? req.query["appId"] : undefined);

    if (!appId || typeof appId !== "string" || appId.trim() === "") {
      res.status(400).json({ error: { code: "INVALID_QUERY", message: "appId required" } });
      return;
    }

    const trimmedAppId = appId.trim();

    if (!(await tenantOwnsApp(auth.tenantId, trimmedAppId, pool))) {
      res.status(403).json(FORBIDDEN_RESPONSE);
      return;
    }

    next();
  };
}
