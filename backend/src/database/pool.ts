// Owner: P6. Single shared pg Pool, created once and injected everywhere.
import pg from "pg";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      statement_timeout: 5_000, // 5 s hard cap (Rule 1 of data ownership)
    });
    _pool.on("error", (err) => {
      console.error("[pool] unexpected error on idle client", err.message);
    });
  }
  return _pool;
}

/** Call once during graceful shutdown (tests, process exit). */
export async function closePool(): Promise<void> {
  if (_pool) {
    const p = _pool;
    _pool = null;
    try {
      await p.end();
    } catch {
      // ignore if already ended
    }
  }
}
