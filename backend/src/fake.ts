// Owner: P6. In-memory fakes for every service interface.
// USE_FAKE_* env flags swap these in via container.ts.
// Hard-coded hospital data is ONLY allowed inside fakes (see AI_CONTEXT rule 1).
import type {
  MetadataStore, DataService, AnalyticsService, UiAdapter, LlmClient,
  TraceStore, ToolRegistry,
} from "@cab/contracts";
import {
  AppMetadata, UiState, emptyUiState, Trace,
} from "@cab/contracts";
import { readFileSync } from "node:fs";

// ── helpers ──────────────────────────────────────────────────────────────────

function loadFixture(name: string): AppMetadata {
  const raw = readFileSync(
    new URL(`../../metadata/${name}.json`, import.meta.url),
    "utf8",
  );
  return AppMetadata.parse(JSON.parse(raw));
}

// ── FakeMetadataStore ─────────────────────────────────────────────────────────

export function createFakeMetadataStore(): MetadataStore {
  const apps: Record<string, AppMetadata> = {
    hospital: loadFixture("hospital"),
  };
  // Lazily load hotel if it exists
  try { apps["hotel"] = loadFixture("hotel"); } catch { /* not present yet */ }

  return {
    async getApp(ctx) {
      const app = apps[ctx.appId];
      if (!app) throw new Error(`Fake: unknown appId '${ctx.appId}'`);
      return app;
    },
    async listApps(tenantId) {
      // fake: tenant-a owns hospital, tenant-b owns hotel
      const map: Record<string, string[]> = {
        "tenant-a": ["hospital"],
        "tenant-b": ["hotel"],
      };
      return (map[tenantId] ?? [])
        .filter((id) => apps[id])
        .map((id) => ({ appId: id, name: apps[id].name, description: apps[id].description }));
    },
    async search(_ctx, query) {
      // very naive: return 0 hits — P2 will replace this
      console.log(`[fakeMetadata] search: "${query}" → 0 hits`);
      return [];
    },
    async buildContext(ctx, _hits, _currentPageId) {
      const app = apps[ctx.appId];
      return {
        appId: ctx.appId,
        appName: app?.name ?? "Fake App",
        navTree: app ? app.pages.map((p) => ({ id: p.id, name: p.name, route: p.route, parent: null })) : [],
        pages: app?.pages.map((p) => ({
          id: p.id,
          name: p.name,
          route: p.route,
          path: `/${p.id}`,
          description: p.description,
          widgets: p.widgets.map((w) => ({
            id: w.id,
            name: w.name,
            type: w.type,
            dataset: w.dataset,
            description: w.description,
            columns: w.columns.map((c) => ({ field: c.field, label: c.label ?? c.field })),
            sortable: w.sortable ?? [],
          })),
          filters: p.filters.map((f) => ({
            id: f.id,
            label: f.label,
            type: f.type,
            field: f.field,
            description: f.description,
            operators: f.operators ?? [],
            options: f.options ? f.options.map((o) => ({ value: o.value, label: o.label })) : undefined,
          })),
        })) ?? [],
        datasets: app?.datasets.map((d) => ({
          name: d.name,
          description: d.description,
          timeField: d.timeField,
          fields: d.fields.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            description: f.description,
            derived: Boolean(f.derived),
            enumValues: f.enumValues,
            roles: f.roles ?? [],
          })),
          relations: d.relations.map((r) => ({ field: r.field, toDataset: r.toDataset, toField: r.toField })),
        })) ?? [],
        actions: app?.actions?.map((a) => ({
          id: a.id,
          label: a.label,
          destructive: a.destructive ?? false,
          description: a.description,
        })) ?? [],
      };
    },
    async importApp(tenantId, bundle) {
      apps[bundle.metadata.appId] = bundle.metadata;
      return {
        appId: bundle.metadata.appId,
        pages: bundle.metadata.pages.length,
        widgets: bundle.metadata.pages.reduce((s, p) => s + p.widgets.length, 0),
        filters: bundle.metadata.pages.reduce((s, p) => s + p.filters.length, 0),
        datasets: bundle.metadata.datasets.length,
        embedded: 0,
        rowsLoaded: 0,
      };
    },
  };
}

// ── FakeDataService ───────────────────────────────────────────────────────────

export function createFakeDataService(): DataService {
  return {
    async query(_ctx, _spec) {
      return {
        queryId: `fake-${Math.random().toString(36).slice(2)}`,
        dataset: "medicines",
        columns: [
          { name: "medicine", label: "Medicine", type: "string" as const },
          { name: "days_remaining", label: "Days remaining", type: "number" as const },
        ],
        rows: [
          { medicine: "Amoxicillin", days_remaining: 0.8 },
          { medicine: "Insulin", days_remaining: 0.6 },
          { medicine: "Metformin", days_remaining: 3.0 },
          { medicine: "Salbutamol", days_remaining: 3.8 },
        ],
        rowCount: 4,
        truncated: false,
        appliedWhere: [],
        sqlPreview: "SELECT … (fake)",
      };
    },
    async widgetData(ctx, _pageId, _widgetId, _ui, opts) {
      return this.query(ctx, {
        dataset: "medicines",
        where: [],
        groupBy: [],
        metrics: [],
        orderBy: [],
        limit: opts?.limit ?? 50,
      });
    },
  };
}

// ── FakeAnalyticsService ──────────────────────────────────────────────────────

export function createFakeAnalyticsService(): AnalyticsService {
  return {
    async run(_ctx, spec) {
      return {
        resultId: `fake-${Math.random().toString(36).slice(2)}`,
        kind: spec.kind,
        dataset: spec.dataset,
        metric: spec.metric,
        periods: spec.kind === "period_compare"
          ? {
              a: { start: "2026-10-01", end: "2026-10-07", days: 7, value: 0 },
              b: { start: "2026-09-01", end: "2026-09-07", days: 7, value: 0 },
              note: "Partial period: this month has 7 days vs 30 — P1 will replace this",
            }
          : undefined,
        evidence: [{ id: "e1", text: "Fake analytics — P1 will replace this." }],
        insufficientEvidence: true,
        provenance: { dataset: spec.dataset, queryIds: [] },
      };
    },
  };
}

// ── FakeUiAdapter ─────────────────────────────────────────────────────────────

export function createFakeUiAdapter(): UiAdapter {
  const states = new Map<string, UiState>();
  const acks = new Map<string, { resolve: (v: { state: UiState }) => void }>();

  return {
    async getState(sessionId) {
      return states.get(sessionId) ?? null;
    },
    async dispatch(sessionId, action) {
      const actionId = `action-${crypto.randomUUID()}`;
      // Apply the action immediately (simulated)
      let state = states.get(sessionId) ?? emptyUiState("hospital", "dashboard", "/dashboard");
      state = applyFakeAction(state, action);
      state = { ...state, version: state.version + 1 };
      states.set(sessionId, state);
      // Immediately resolve any pending ack
      setTimeout(() => {
        const pending = acks.get(actionId);
        if (pending) { pending.resolve({ state }); acks.delete(actionId); }
      }, 0);
      return { actionId };
    },
    async awaitAck(sessionId, actionId, timeoutMs) {
      const state = states.get(sessionId);
      if (state) return { state }; // already applied
      return new Promise((resolve) => {
        acks.set(actionId, { resolve });
        setTimeout(() => { acks.delete(actionId); resolve({ timeout: true }); }, timeoutMs);
      });
    },
  };
}

function applyFakeAction(state: UiState, action: unknown): UiState {
  const a = action as Record<string, unknown>;
  if (a["type"] === "navigate") {
    const route = a["route"] as string;
    return { ...state, route, filters: {}, sort: null };
  }
  if (a["type"] === "set_filter") {
    const { filterId, value } = a as { filterId: string; value: import("@cab/contracts").FilterValue };
    return { ...state, filters: { ...state.filters, [filterId]: value } };
  }
  if (a["type"] === "clear_filter") {
    const { filterId } = a as { filterId: string };
    const filters = { ...state.filters };
    delete filters[filterId];
    return { ...state, filters };
  }
  return state;
}

// ── FakeLlmClient ─────────────────────────────────────────────────────────────

export function createFakeLlmClient(): LlmClient {
  return {
    async json(_req, parse) {
      // Return a minimal AgentTurn-like object; P3 will validate with zod
      const raw = { intent: "fake", reasoning: "fake llm", steps: [], done: true };
      return { data: parse(raw), cached: true, usage: {}, latencyMs: 0 };
    },
    async text(_req) {
      return { data: "Fake LLM response — P3 will replace this.", cached: true, usage: {}, latencyMs: 0 };
    },
    async embed(texts) {
      // Return zero-vectors (P2 replaces with real embeddings)
      return texts.map(() => new Array(384).fill(0) as number[]);
    },
  };
}

// ── FakeTraceStore ─────────────────────────────────────────────────────────────

export function createFakeTraceStore(): TraceStore {
  const db = new Map<string, Trace>();
  return {
    async save(trace) {
      try {
        db.set(trace.traceId, Trace.parse(trace));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[fakeTraceStore] Failed to save trace (${msg})`);
      }
    },
    async get(traceId) { return db.get(traceId) ?? null; },
    async list(appId, limit = 50) {
      return [...db.values()].filter((t) => t.appId === appId).slice(0, limit);
    },
  };
}

// ── FakeToolRegistry ──────────────────────────────────────────────────────────

export function createFakeToolRegistry(): ToolRegistry {
  return {
    async execute(_ctx, call) {
      console.log(`[fakeTools] execute: ${call.tool}`);
      return { ok: true, data: { fake: true, tool: call.tool } };
    },
  };
}
