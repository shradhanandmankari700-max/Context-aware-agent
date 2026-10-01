import { z } from "zod";
import { Id, FilterValue } from "./common";
import { SortState } from "./uiState";

/** One line of evaluation/corpus/*.jsonl */
export const EvalCase = z.object({
  id: z.string(),
  appId: Id,
  kind: z.enum(["navigate", "operate", "analyze", "multistep", "followup", "clarify", "adversarial"]),
  utterance: z.string(),
  history: z.array(z.string()).default([]), // earlier user turns replayed first (for follow-ups)
  startPageId: Id.optional(),
  gold: z.object({
    pageId: Id.optional(),
    widgetId: Id.optional(),
    filters: z.record(Id, FilterValue).optional(),
    sort: SortState.optional(),
    expectClarification: z.boolean().optional(),
    expectRefusal: z.boolean().optional(),      // nonexistent page/filter etc.
    expectConfirmation: z.boolean().optional(), // destructive request
    numbers: z.array(z.object({ label: z.string(), value: z.number(), tolerance: z.number().default(0.005) })).optional(),
  }),
});
export type EvalCase = z.infer<typeof EvalCase>;

/** One line of evaluation/corpus/retrieval.jsonl */
export const RetrievalCase = z.object({ id: z.string(), appId: Id, query: z.string(), goldIds: z.array(z.string()).min(1) });
export type RetrievalCase = z.infer<typeof RetrievalCase>;

/** evaluation/results/latest.json. The dashboard (frontend /eval) renders exactly this. */
export const KpiReport = z.object({
  runId: z.string(), createdAt: z.string(), commit: z.string().optional(),
  llm: z.object({ provider: z.string(), model: z.string(), cache: z.boolean() }),
  counts: z.object({ cases: z.number(), byKind: z.record(z.string(), z.number()) }),
  kpis: z.object({
    intentToDestination: z.number(),                                  // 0..1
    uiState: z.object({ fieldLevel: z.number(), exactMatch: z.number() }),
    taskSuccess: z.object({ rate: z.number(), avgSteps: z.number() }),
    analytical: z.object({ numericMatch: z.number(), cases: z.number() }),
    faithfulness: z.object({ traceableClaims: z.number(), totalClaims: z.number() }),
    retrieval: z.object({
      precisionAt1: z.number(), recallAt5: z.number(), mrr: z.number(),
      byScale: z.array(z.object({ pages: z.number(), mrr: z.number(), recallAt5: z.number() })),
    }),
    safety: z.object({ invalidActionsBlocked: z.number(), invalidActionsExecuted: z.number(), adversarialPassRate: z.number() }),
    recovery: z.object({ attempted: z.number(), recovered: z.number(), rate: z.number() }),
    latencyMs: z.object({ p50: z.number(), p95: z.number(), firstActionP50: z.number().optional() }),
    ux: z.object({ avgManualClicksSaved: z.number() }),
  }),
  failures: z.array(z.object({ caseId: z.string(), reason: z.string() })),
});
export type KpiReport = z.infer<typeof KpiReport>;
