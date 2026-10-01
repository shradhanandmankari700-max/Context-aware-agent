import { z } from "zod";
import { DbName, Condition, Agg, Grain, Direction, DateToken, IsoDate } from "./common";

/** Structured query. The LLM can only produce this; the backend validates it against metadata and builds SQL. */
export const QuerySpec = z.object({
  dataset: DbName,
  select: z.array(DbName).optional(),
  where: z.array(Condition).default([]), // date fields may use DateToken strings; the engine resolves them
  groupBy: z.array(z.object({ field: DbName, grain: Grain.optional() })).default([]),
  metrics: z.array(z.object({ field: DbName, agg: Agg, as: DbName.optional() })).default([]),
  orderBy: z.array(z.object({ field: DbName, direction: Direction })).default([]), // field may be a metric alias
  limit: z.number().int().min(1).max(500).default(100),
});
export type QuerySpec = z.infer<typeof QuerySpec>;

export const QueryResult = z.object({
  queryId: z.string(),
  dataset: DbName,
  columns: z.array(z.object({ name: z.string(), label: z.string(), type: z.enum(["string", "number", "date", "boolean"]) })),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  truncated: z.boolean().default(false),
  appliedWhere: z.array(Condition), // after token resolution (shown in provenance)
  sqlPreview: z.string().optional(),
});
export type QueryResult = z.infer<typeof QueryResult>;

export const Period = z.object({ token: DateToken.optional(), start: IsoDate.optional(), end: IsoDate.optional() })
  .refine((p) => !!p.token || (!!p.start && !!p.end), "period needs a token or start+end");
export type Period = z.infer<typeof Period>;

const Metric = z.object({ field: DbName, agg: Agg });

/** Convention: periodA = the CURRENT/recent period, periodB = the BASELINE/previous period. */
export const AnalysisSpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("period_compare"), dataset: DbName, metric: Metric, dateField: DbName.optional(),
    periodA: Period, periodB: Period, breakdownBy: z.array(DbName).default([]), where: z.array(Condition).default([]),
  }),
  z.object({
    kind: z.literal("trend"), dataset: DbName, metric: Metric, dateField: DbName.optional(),
    grain: Grain, period: Period, breakdownBy: z.array(DbName).default([]), where: z.array(Condition).default([]),
  }),
  z.object({
    kind: z.literal("rank"), dataset: DbName, metric: Metric, by: DbName, direction: Direction.default("desc"),
    limit: z.number().int().min(1).max(50).default(10), period: Period.optional(), dateField: DbName.optional(), where: z.array(Condition).default([]),
  }),
]);
export type AnalysisSpec = z.infer<typeof AnalysisSpec>;

const KeyCell = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

/** Everything here is computed by CODE. The narrator may only cite these values. */
export const AnalysisResult = z.object({
  resultId: z.string(),
  kind: z.enum(["period_compare", "trend", "rank"]),
  dataset: DbName,
  metric: Metric,
  periods: z.object({
    a: z.object({ start: IsoDate, end: IsoDate, days: z.number(), value: z.number() }),
    b: z.object({ start: IsoDate, end: IsoDate, days: z.number(), value: z.number() }),
    note: z.string().optional(), // e.g. "Period A is month-to-date (7 days) vs 30 days"
  }).optional(),
  absChange: z.number().nullable().optional(),
  pctChange: z.number().nullable().optional(), // 0.12 = +12%; null when baseline is 0
  breakdown: z.array(z.object({
    key: KeyCell, a: z.number(), b: z.number(), abs: z.number(), pct: z.number().nullable(), shareOfChange: z.number().nullable(),
  })).optional(),
  series: z.array(z.object({ period: z.string(), value: z.number(), key: KeyCell.optional() })).optional(),
  ranking: z.array(z.object({ key: z.union([z.string(), z.number()]), value: z.number() })).optional(),
  evidence: z.array(z.object({ id: z.string(), text: z.string(), value: z.number().optional() })),
  insufficientEvidence: z.boolean(),
  reason: z.string().optional(),
  provenance: z.object({ dataset: DbName, queryIds: z.array(z.string()) }),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;
