import { z } from "zod";
import { Id, DbName, Direction } from "./common";
import { UiState } from "./uiState";
import { UiAction } from "./actions";
import { ErrorCode } from "./tools";

export const ChatRequest = z.object({
  sessionId: z.string().min(8),
  appId: Id,
  message: z.string().min(1).max(2000),
  uiState: UiState.optional(), // frontend's current state (backend also keeps its own via reports)
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ConfirmRequest = z.object({ sessionId: z.string(), confirmationId: z.string(), approve: z.boolean() });
export type ConfirmRequest = z.infer<typeof ConfirmRequest>;

export const Provenance = z.object({ resultId: z.string(), dataset: DbName, description: z.string(), widgetId: Id.optional(), pageId: Id.optional() });
export type Provenance = z.infer<typeof Provenance>;

const Prov = z.array(Provenance).default([]);
/** What the frontend renders. Numbers inside blocks are copied from tool results by CODE, never typed by the LLM. */
export const AnswerBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), markdown: z.string(), provenance: Prov }),
  z.object({ type: z.literal("table"), title: z.string(), columns: z.array(z.object({ name: z.string(), label: z.string() })), rows: z.array(z.record(z.string(), z.unknown())), provenance: Prov }),
  z.object({ type: z.literal("chart"), kind: z.enum(["bar", "line", "pie", "donut"]), title: z.string(), xKey: z.string(), yKeys: z.array(z.string()), data: z.array(z.record(z.string(), z.unknown())), provenance: Prov }),
  z.object({ type: z.literal("kpi"), label: z.string(), value: z.union([z.string(), z.number()]), delta: z.object({ pct: z.number(), direction: z.enum(["up", "down", "flat"]) }).optional(), provenance: Prov }),
  z.object({ type: z.literal("comparison"), title: z.string(), a: z.object({ label: z.string(), value: z.number() }), b: z.object({ label: z.string(), value: z.number() }), pctChange: z.number().nullable(), note: z.string().optional(), provenance: Prov }),
]);
export type AnswerBlock = z.infer<typeof AnswerBlock>;

/** What the NARRATOR LLM returns: references to results, not data. P3's assembler fills in the numbers. */
export const NarratorOutput = z.object({
  blocks: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), markdown: z.string(), cites: z.array(z.string()).default([]) }),
    z.object({ type: z.literal("table"), title: z.string(), resultId: z.string(), columns: z.array(z.string()).optional() }),
    z.object({ type: z.literal("chart"), kind: z.enum(["bar", "line", "pie", "donut"]), title: z.string(), resultId: z.string(), xKey: z.string(), yKeys: z.array(z.string()) }),
    z.object({ type: z.literal("comparison"), title: z.string(), resultId: z.string() }),
    z.object({ type: z.literal("kpi"), label: z.string(), resultId: z.string(), valuePath: z.string() }),
  ])),
});
export type NarratorOutput = z.infer<typeof NarratorOutput>;

export const StepRecord = z.object({
  index: z.number().int(),
  tool: z.string(),
  args: z.unknown(),
  status: z.enum(["ok", "error", "skipped", "awaiting_confirmation"]),
  summary: z.string(),
  error: z.object({ code: ErrorCode, message: z.string() }).optional(),
  recovery: z.object({ strategy: z.string(), detail: z.string() }).optional(),
  durationMs: z.number(),
});
export type StepRecord = z.infer<typeof StepRecord>;

export const Verification = z.object({
  ok: z.boolean(),
  attempts: z.number().int(),
  expected: z.unknown(),
  actual: UiState.nullable(),
  mismatches: z.array(z.object({ field: z.string(), expected: z.unknown(), actual: z.unknown() })),
});
export type Verification = z.infer<typeof Verification>;

export const AgentResponse = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  status: z.enum(["ok", "partial", "failed", "needs_clarification", "needs_confirmation"]),
  intent: z.string().optional(),
  answer: z.array(AnswerBlock),
  steps: z.array(StepRecord),
  uiState: UiState.nullable(),
  verification: Verification.optional(),
  deepLink: z.string().optional(),
  clarification: z.object({ question: z.string(), options: z.array(z.string()).optional() }).optional(),
  pendingConfirmation: z.object({ confirmationId: z.string(), description: z.string(), actionId: Id }).optional(),
  manualClicksSaved: z.number().int().optional(),
  latencyMs: z.number().optional(),
});
export type AgentResponse = z.infer<typeof AgentResponse>;

/** Per-session memory used for follow-ups ("which one is used faster?"). */
export const ConversationMemory = z.object({
  sessionId: z.string(), appId: Id,
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).max(20),
  lastUiState: UiState.nullable(),
  lastResult: z.object({
    widgetId: Id.optional(), dataset: DbName.optional(), keyField: DbName.optional(),
    keys: z.array(z.string()), description: z.string(),
  }).nullable(),
  pendingConfirmation: z.object({ confirmationId: z.string(), toolCall: z.unknown(), description: z.string() }).nullable(),
});
export type ConversationMemory = z.infer<typeof ConversationMemory>;

/* ---------- Frontend <-> backend UI sync protocol ---------- */
export const AgentStage = z.enum(["thinking", "retrieving", "planning", "acting", "verifying", "analyzing", "answering", "done", "error"]);
/** Backend -> frontend over SSE: GET /api/events?sessionId=..&token=.. */
export const SseEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), sessionId: z.string() }),
  z.object({ type: z.literal("ui_action"), actionId: z.string(), action: UiAction, baseVersion: z.number().int() }),
  z.object({ type: z.literal("agent_status"), traceId: z.string(), stage: AgentStage, detail: z.string().optional() }),
  z.object({ type: z.literal("agent_step"), traceId: z.string(), step: StepRecord }),
]);
export type SseEvent = z.infer<typeof SseEvent>;

/** Frontend -> backend after EVERY state change and after every applied/rejected ui_action: POST /api/ui-state/report */
export const UiStateReport = z.object({
  sessionId: z.string(),
  actionId: z.string().optional(), // echo of the ui_action being acknowledged
  state: UiState,
  rejected: z.object({ code: z.enum(["FILTER_UNAVAILABLE", "PAGE_NOT_FOUND", "INVALID_VALUE", "OTHER"]), reason: z.string() }).optional(),
});
export type UiStateReport = z.infer<typeof UiStateReport>;

export const Trace = z.object({
  traceId: z.string(), sessionId: z.string(), appId: Id, userId: z.string(), createdAt: z.string(),
  userMessage: z.string(), intent: z.string().optional(),
  retrieved: z.array(z.object({ kind: z.string(), id: z.string(), score: z.number() })),
  turns: z.array(z.unknown()), // raw AgentTurn JSON per LLM iteration
  toolCalls: z.array(z.object({ step: z.number(), tool: z.string(), args: z.unknown(), ok: z.boolean(), errorCode: z.string().optional(), durationMs: z.number() })),
  uiBefore: UiState.nullable(), uiAfter: UiState.nullable(),
  queries: z.array(z.object({ queryId: z.string(), dataset: z.string(), sql: z.string(), params: z.array(z.unknown()), rowCount: z.number() })),
  recoveries: z.array(z.object({ step: z.number(), error: z.string(), strategy: z.string() })),
  verification: Verification.optional(),
  finalAnswer: z.string(),
  status: z.string(),
  invalidActionsBlocked: z.number().int().default(0), // validator rejections (KPI)
  invalidActionsExecuted: z.number().int().default(0), // must stay 0 (KPI)
  llm: z.object({ calls: z.number(), cachedCalls: z.number(), provider: z.string(), model: z.string() }),
  latencyMs: z.object({ total: z.number(), firstAction: z.number().optional(), llm: z.number().optional() }),
});
export type Trace = z.infer<typeof Trace>;
