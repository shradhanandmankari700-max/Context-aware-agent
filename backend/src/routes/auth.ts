// Owner: P6. POST /api/auth/login → {token, user}
import { Router } from "express";
import type pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { AuthPayload } from "../middleware/auth.js";

export function createAuthRouter(pool: pg.Pool | null): Router {
  const router = Router();

  router.post("/login", async (req, res, next) => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) {
        res.status(400).json({ error: { code: "INVALID_QUERY", message: "email and password required" } });
        return;
      }

      if (!pool) {
        // In-memory demo auth when database is not connected
        const demoUsers: Record<string, { id: string; tenant_id: string; role: string; pass: string }> = {
          "admin@hospital.demo": { id: "u-hosp-admin", tenant_id: "tenant-a", role: "admin", pass: "hospitalAdmin123" },
          "staff@hospital.demo": { id: "u-hosp-staff", tenant_id: "tenant-a", role: "staff", pass: "hospitalStaff123" },
          "viewer@hospital.demo": { id: "u-hosp-viewer", tenant_id: "tenant-a", role: "viewer", pass: "hospitalViewer123" },
          "admin@hotel.demo": { id: "u-hotel-admin", tenant_id: "tenant-b", role: "admin", pass: "hotelAdmin123" },
          "staff@hotel.demo": { id: "u-hotel-staff", tenant_id: "tenant-b", role: "staff", pass: "hotelStaff123" },
          "viewer@hotel.demo": { id: "u-hotel-viewer", tenant_id: "tenant-b", role: "viewer", pass: "hotelViewer123" },
        };
        const user = demoUsers[email.toLowerCase().trim()];
        if (!user || user.pass !== password) {
          res.status(401).json({ error: { code: "FORBIDDEN", message: "Invalid credentials" } });
          return;
        }
        const secret = process.env.JWT_SECRET ?? "dev-jwt-secret";
        const payload: AuthPayload = { userId: user.id, tenantId: user.tenant_id, role: user.role, email: email.toLowerCase().trim() };
        const token = jwt.sign(payload, secret, { expiresIn: "24h" });
        res.json({ token, user: { id: user.id, tenantId: user.tenant_id, role: user.role, email: payload.email } });
        return;
      }

      const { rows } = await pool.query<{
        id: string; tenant_id: string; email: string; password_hash: string; role: string;
      }>(
        "SELECT id, tenant_id, email, password_hash, role FROM users WHERE email = $1 LIMIT 1",
        [email.toLowerCase().trim()],
      );

      if (rows.length === 0) {
        res.status(401).json({ error: { code: "FORBIDDEN", message: "Invalid credentials" } });
        return;
      }

      const user = rows[0];
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        res.status(401).json({ error: { code: "FORBIDDEN", message: "Invalid credentials" } });
        return;
      }

      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error("JWT_SECRET not configured");

      const payload: AuthPayload = { userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email };
      const token = jwt.sign(payload, secret, { expiresIn: "24h" });

      res.json({ token, user: { id: user.id, tenantId: user.tenant_id, role: user.role, email: user.email } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
