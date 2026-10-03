// Owner: P6. The single wiring point. All modules plug in here via their factory.
// USE_FAKE_METADATA=1, USE_FAKE_DATA=1, etc. swap a real module for its in-memory fake.
// P3/P4/P5 can develop against fakes from Day 2 by setting the relevant flags.
import type { Services } from "@cab/contracts";
import type pg from "pg";
import { getPool, closePool } from "./database/pool.js";
import { createTraceStore } from "./database/traceStore.js";
import {
  createFakeMetadataStore,
  createFakeDataService,
  createFakeAnalyticsService,
  createFakeUiAdapter,
  createFakeLlmClient,
  createFakeTraceStore,
  createFakeToolRegistry,
} from "./fake.js";

export type ModuleStatusValue = "real" | "fake" | "fake (db unreachable)";

export type ModuleStatus = Record<
  "metadata" | "data" | "analytics" | "ui" | "tools" | "llm" | "traces" | "agent",
  ModuleStatusValue
>;

export interface ContainerResult extends Services {
  moduleStatus: ModuleStatus;
  pool: pg.Pool | null;
}

function env(key: string): boolean {
  return process.env[key] === "1";
}

async function tryImport<T = Record<string, any>>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

/**
 * Build the complete Services object, swapping in fakes for any module whose
 * USE_FAKE_<MODULE>=1 flag is set. Each real factory is dynamically imported so
 * teammates who haven't implemented their module yet don't block compilation.
 */
export async function createServices(): Promise<ContainerResult> {
  const dbUrl = process.env.DATABASE_URL;
  let pool: pg.Pool | null = null;
  let dbUnreachable = false;

  if (!dbUrl || dbUrl.trim() === "") {
    console.warn("[container] DATABASE_URL is empty — using fakes and in-memory trace store");
  } else {
    try {
      const candidatePool = getPool();
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Database ping timed out after 2000ms")), 2000);
      });

      try {
        await Promise.race([
          candidatePool.query("SELECT 1"),
          timeoutPromise,
        ]);
        pool = candidatePool;
      } catch (pingErr) {
        await closePool();
        throw pingErr;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[container] WARNING: Database is unreachable (SELECT 1 failed: ${msg}) — falling back to fakes and in-memory trace store`);
      pool = null;
      dbUnreachable = true;
    }
  }

  const moduleStatus: ModuleStatus = {
    metadata: "fake",
    data: "fake",
    analytics: "fake",
    ui: "fake",
    tools: "fake",
    llm: "fake",
    traces: "fake",
    agent: "fake",
  };

  // ── MetadataStore (P2) ────────────────────────────────────────────────────
  let metadata: Services["metadata"];
  if (dbUnreachable) {
    metadata = createFakeMetadataStore();
    moduleStatus.metadata = "fake (db unreachable)";
  } else if (!pool || env("USE_FAKE_METADATA")) {
    metadata = createFakeMetadataStore();
    moduleStatus.metadata = "fake";
  } else {
    const mod = await tryImport<{ createMetadataStore: (opts: { pool: any }) => Services["metadata"] }>("./metadata/index.js");
    if (mod?.createMetadataStore) {
      metadata = mod.createMetadataStore({ pool });
      moduleStatus.metadata = "real";
    } else {
      console.warn("[container] metadata/index.ts not ready — using fake");
      metadata = createFakeMetadataStore();
      moduleStatus.metadata = "fake";
    }
  }

  // ── LlmClient (P3) ───────────────────────────────────────────────────────
  let llm: Services["llm"];
  if (env("USE_FAKE_LLM")) {
    llm = createFakeLlmClient();
    moduleStatus.llm = "fake";
  } else {
    const mod = await tryImport<{ createLlmClient: (env: Record<string, string>) => Services["llm"] }>("./llm/index.js");
    if (mod?.createLlmClient) {
      llm = mod.createLlmClient(process.env as Record<string, string>);
      moduleStatus.llm = "real";
    } else {
      console.warn("[container] llm/index.ts not ready — using fake");
      llm = createFakeLlmClient();
      moduleStatus.llm = "fake";
    }
  }

  // ── DataService (P1) ──────────────────────────────────────────────────────
  let data: Services["data"];
  if (dbUnreachable) {
    data = createFakeDataService();
    moduleStatus.data = "fake (db unreachable)";
  } else if (!pool || env("USE_FAKE_DATA")) {
    data = createFakeDataService();
    moduleStatus.data = "fake";
  } else {
    const mod = await tryImport<{ createDataService: (opts: { pool: any; metadata: Services["metadata"] }) => Services["data"] }>("./data/index.js");
    if (mod?.createDataService) {
      data = mod.createDataService({ pool, metadata });
      moduleStatus.data = "real";
    } else {
      console.warn("[container] data/index.ts not ready — using fake");
      data = createFakeDataService();
      moduleStatus.data = "fake";
    }
  }

  // ── AnalyticsService (P1) ─────────────────────────────────────────────────
  let analytics: Services["analytics"];
  if (env("USE_FAKE_ANALYTICS")) {
    analytics = createFakeAnalyticsService();
    moduleStatus.analytics = "fake";
  } else {
    const mod = await tryImport<{ createAnalyticsService: (opts: { data: Services["data"]; metadata: Services["metadata"] }) => Services["analytics"] }>("./analytics/index.js");
    if (mod?.createAnalyticsService) {
      analytics = mod.createAnalyticsService({ data, metadata });
      moduleStatus.analytics = "real";
    } else {
      console.warn("[container] analytics/index.ts not ready — using fake");
      analytics = createFakeAnalyticsService();
      moduleStatus.analytics = "fake";
    }
  }

  // ── UiAdapter (P4) ────────────────────────────────────────────────────────
  let ui: Services["ui"];
  if (env("USE_FAKE_UI")) {
    ui = createFakeUiAdapter();
    moduleStatus.ui = "fake";
  } else {
    const kind = (process.env["UI_ADAPTER"] ?? "api") as "api" | "simulated" | "playwright";
    const mod = await tryImport<{ createUiAdapter: (kind: string) => Services["ui"] }>("./ui/index.js");
    if (mod?.createUiAdapter) {
      ui = mod.createUiAdapter(kind);
      moduleStatus.ui = "real";
    } else {
      console.warn("[container] ui/index.ts not ready — using fake");
      ui = createFakeUiAdapter();
      moduleStatus.ui = "fake";
    }
  }

  // ── ToolRegistry (P4) ────────────────────────────────────────────────────
  let tools: Services["tools"];
  if (env("USE_FAKE_TOOLS")) {
    tools = createFakeToolRegistry();
    moduleStatus.tools = "fake";
  } else {
    const mod = await tryImport<{ createToolRegistry: (opts: { metadata: Services["metadata"]; data: Services["data"]; analytics: Services["analytics"]; ui: Services["ui"] }) => Services["tools"] }>("./tools/index.js");
    if (mod?.createToolRegistry) {
      tools = mod.createToolRegistry({ metadata, data, analytics, ui });
      moduleStatus.tools = "real";
    } else {
      console.warn("[container] tools/index.ts not ready — using fake");
      tools = createFakeToolRegistry();
      moduleStatus.tools = "fake";
    }
  }

  // ── TraceStore (P6) ───────────────────────────────────────────────────────
  let traces: Services["traces"];
  if (dbUnreachable) {
    traces = createFakeTraceStore();
    moduleStatus.traces = "fake (db unreachable)";
  } else if (!pool || env("USE_FAKE_TRACES")) {
    traces = createFakeTraceStore();
    moduleStatus.traces = "fake";
  } else {
    traces = createTraceStore(pool);
    moduleStatus.traces = "real";
  }

  // ── AgentService (P3) ────────────────────────────────────────────────────
  let agent: Services["agent"];
  if (env("USE_FAKE_AGENT")) {
    // Minimal stub: returns a placeholder response
    agent = {
      async chat(_ctx, req) {
        return {
          traceId: "fake-trace", sessionId: req.sessionId,
          status: "ok" as const,
          answer: [{ type: "text" as const, markdown: "Fake agent — P3 will replace this.", provenance: [] }],
          steps: [], uiState: null,
        };
      },
      async confirm(_ctx, _req) {
        return {
          traceId: "fake-trace", sessionId: "fake",
          status: "ok" as const,
          answer: [], steps: [], uiState: null,
        };
      },
    };
    moduleStatus.agent = "fake";
  } else {
    const mod = await tryImport<{ createAgent: (opts: { metadata: Services["metadata"]; tools: Services["tools"]; llm: Services["llm"]; ui: Services["ui"]; traces: Services["traces"] }) => Services["agent"] }>("./agent/index.js");
    if (mod?.createAgent) {
      agent = mod.createAgent({ metadata, tools, llm, ui, traces });
      moduleStatus.agent = "real";
    } else {
      console.warn("[container] agent/index.ts not ready — using stub");
      agent = {
        async chat(_ctx, req) {
          return {
            traceId: "stub", sessionId: req.sessionId,
            status: "ok" as const,
            answer: [{ type: "text" as const, markdown: "Agent not yet implemented.", provenance: [] }],
            steps: [], uiState: null,
          };
        },
        async confirm(_ctx, req) {
          return { traceId: "stub", sessionId: req.sessionId, status: "ok" as const, answer: [], steps: [], uiState: null };
        },
      };
      moduleStatus.agent = "fake";
    }
  }

  // ── Log real-vs-fake per module at startup ────────────────────────────────
  console.log("[container] Module status:");
  for (const [mod, status] of Object.entries(moduleStatus)) {
    console.log(`  - ${mod}: ${status}`);
  }

  // ── STRICT_REAL check ─────────────────────────────────────────────────────
  if (process.env.STRICT_REAL === "1") {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret || jwtSecret === "change-me-in-dev") {
      console.error("[container] STRICT_REAL=1: JWT_SECRET is missing or set to insecure default ('change-me-in-dev')");
      process.exit(1);
    }

    const fakes = Object.entries(moduleStatus)
      .filter(([_, status]) => status !== "real")
      .map(([mod, status]) => `${mod} (${status})`);
    if (fakes.length > 0) {
      console.error(`[container] STRICT_REAL=1: refusing to start with fake modules: ${fakes.join(", ")}`);
      process.exit(1);
    }
  }

  return { metadata, data, analytics, ui, llm, traces, tools, agent, moduleStatus, pool };
}
