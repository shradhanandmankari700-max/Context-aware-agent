// Owner: P6. Postgres-backed TraceStore implementation.
import type pg from "pg";
import type { TraceStore } from "@cab/contracts";
import { Trace } from "@cab/contracts";

export function createTraceStore(pool: pg.Pool): TraceStore {
  return {
    async save(trace) {
      try {
        const t = Trace.parse(trace); // validate before persisting
        await pool.query(
          `INSERT INTO agent_traces (trace_id, session_id, app_id, user_id, created_at, status, latency_ms, trace)
           VALUES ($1, $2, $3, $4, now(), $5, $6, $7)
           ON CONFLICT (trace_id) DO UPDATE
             SET status = EXCLUDED.status, latency_ms = EXCLUDED.latency_ms, trace = EXCLUDED.trace`,
          [
            t.traceId,
            t.sessionId,
            t.appId,
            t.userId,
            t.status,
            t.latencyMs.total,
            JSON.stringify(t),
          ],
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[traceStore] Failed to save trace ${trace?.traceId}: ${msg}`);
      }
    },

    async get(traceId) {
      const { rows } = await pool.query<{ trace: unknown }>(
        "SELECT trace FROM agent_traces WHERE trace_id = $1 LIMIT 1",
        [traceId],
      );
      if (rows.length === 0) return null;
      return Trace.parse(rows[0].trace);
    },

    async list(appId, limit = 50) {
      const cap = Math.min(limit, 200);
      const { rows } = await pool.query<{ trace: unknown }>(
        "SELECT trace FROM agent_traces WHERE app_id = $1 ORDER BY created_at DESC LIMIT $2",
        [appId, cap],
      );
      return rows.map((r) => Trace.parse(r.trace));
    },
  };
}
