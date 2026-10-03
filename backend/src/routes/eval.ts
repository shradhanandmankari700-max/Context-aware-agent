// Owner: P6. GET /api/eval/latest, POST /api/eval/run
import { Router } from "express";
import type pg from "pg";
import { KpiReport } from "@cab/contracts";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LATEST_PATH = join(__dirname, "../../../evaluation/results/latest.json");

export function createEvalRouter(pool: pg.Pool | null): Router {
  const router = Router();

  // GET /api/eval/latest — read from disk (evaluation/ writes it)
  router.get("/latest", requireAuth, (_req, res, next) => {
    try {
      if (!existsSync(LATEST_PATH)) {
        res.status(404).json({ error: { code: "PAGE_NOT_FOUND", message: "No eval results yet. Run npm run eval first." } });
        return;
      }
      const raw = JSON.parse(readFileSync(LATEST_PATH, "utf8")) as unknown;
      const report = KpiReport.parse(raw);
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/eval/run — triggers async eval; returns 202 immediately
  // The heavy work is done by evaluation/src/run.ts via child_process
  router.post("/run", requireAuth, requireRole("admin"), async (req, res, next) => {
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(
        "node",
        ["--loader", "tsx/esm", "evaluation/src/run.ts"],
        {
          cwd: join(__dirname, "../../.."),
          detached: true,
          stdio: "ignore",
          env: { ...process.env },
        },
      );
      child.unref();
      res.status(202).json({ ok: true, message: "Eval started. Poll GET /api/eval/latest for results." });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
