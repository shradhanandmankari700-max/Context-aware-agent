import type { AppMetadata, ImportBundle } from "./metadata";
import type { RetrievalContext, RetrievalHit, RetrievalKind } from "./retrieval";
import type { QuerySpec, QueryResult, AnalysisSpec, AnalysisResult } from "./query";
import type { UiState } from "./uiState";
import type { UiAction } from "./actions";
import type { Trace, ChatRequest, ConfirmRequest, AgentResponse } from "./chat";
import type { ToolCall, ToolResult } from "./tools";

/**
 * MODULE INTERFACES. Every module is written against these types and tested with an in-memory fake.
 * Owner implements the real thing; consumers only ever import the interface.
 */
export interface RequestContext {
  tenantId: string; appId: string; userId: string; role: string;
  sessionId: string; traceId: string;
  /** Demo clock, YYYY-MM-DD (env DEMO_NOW or app.referenceDate). NEVER use the real Date.now() for business dates. */
  now: string;
}

/** P2 */
export interface MetadataStore {
  getApp(ctx: RequestContext): Promise<AppMetadata>; // tenant-checked; cached in memory
  listApps(tenantId: string): Promise<{ appId: string; name: string; description: string }[]>;
  search(ctx: RequestContext, query: string, opts?: { k?: number; kinds?: RetrievalKind[]; currentPageId?: string }): Promise<RetrievalHit[]>;
  buildContext(ctx: RequestContext, hits: RetrievalHit[], currentPageId?: string): Promise<RetrievalContext>;
  importApp(tenantId: string, bundle: ImportBundle): Promise<{ appId: string; pages: number; widgets: number; filters: number; datasets: number; embedded: number; rowsLoaded: number }>;
}

/** P1 */
export interface DataService {
  query(ctx: RequestContext, spec: QuerySpec): Promise<QueryResult>;
  /** Same compile path the frontend table uses: widget + current UI state -> rows. Keeps agent answers consistent with the screen. */
  widgetData(ctx: RequestContext, pageId: string, widgetId: string, ui: UiState, opts?: { limit?: number }): Promise<QueryResult>;
}
export interface AnalyticsService {
  run(ctx: RequestContext, spec: AnalysisSpec): Promise<AnalysisResult>;
}

/** P4. Implementations: ApiUiAdapter (SSE + report), SimulatedUiAdapter (eval/CI, no browser), PlaywrightUiAdapter (fallback). */
export interface UiAdapter {
  getState(sessionId: string): Promise<UiState | null>;
  /** Sends the action; resolves with actionId immediately. */
  dispatch(sessionId: string, action: UiAction): Promise<{ actionId: string }>;
  /** Waits until the UI acknowledges actionId (applied or rejected) or timeout. */
  awaitAck(sessionId: string, actionId: string, timeoutMs: number): Promise<{ state: UiState; rejected?: { code: string; reason: string } } | { timeout: true }>;
}

/** P3 */
export interface LlmJsonRequest { system: string; user: string; schemaName: string; jsonSchema?: unknown; temperature?: number }
export interface LlmResult<T> { data: T; cached: boolean; usage?: { inputTokens?: number; outputTokens?: number }; latencyMs: number }
export interface LlmClient {
  json<T>(req: LlmJsonRequest, parse: (raw: unknown) => T): Promise<LlmResult<T>>; // retries once on parse failure
  text(req: { system: string; user: string; temperature?: number }): Promise<LlmResult<string>>;
  embed(texts: string[]): Promise<number[][]>; // dimension = EMBEDDING_DIM (384 default)
}

/** P6 */
export interface TraceStore {
  save(trace: Trace): Promise<void>;
  get(traceId: string): Promise<Trace | null>;
  list(appId: string, limit?: number): Promise<Trace[]>;
}

/** P4. Single entry point the agent uses to run any tool. Re-validates args itself (defense in depth), never throws. */
export interface ToolRegistry {
  execute(ctx: RequestContext, call: ToolCall): Promise<ToolResult>;
}

/** P3. What the HTTP layer calls. */
export interface AgentService {
  chat(ctx: RequestContext, req: ChatRequest): Promise<AgentResponse>;
  confirm(ctx: RequestContext, req: ConfirmRequest): Promise<AgentResponse>;
}

/** P6 wires these in backend/src/container.ts. Each owner exports a factory (see README "Wiring"). */
export interface Services {
  metadata: MetadataStore; data: DataService; analytics: AnalyticsService;
  ui: UiAdapter; llm: LlmClient; traces: TraceStore; tools: ToolRegistry; agent: AgentService;
}
