import { z } from "zod";

/** UI-facing ids (pages, widgets, filters, actions): camelCase or snake_case, start with a letter. */
export const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "id: letters/digits/underscore, start with a letter");
/** DB-facing names (datasets, tables, fields): lowercase snake_case. Safe to quote into SQL. */
export const DbName = z.string().regex(/^[a-z][a-z0-9_]*$/, "db name: lowercase snake_case");
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const Scalar = z.union([z.string(), z.number(), z.boolean()]);
export type Scalar = z.infer<typeof Scalar>;

export const Op = z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in", "between", "contains"]);
export type Op = z.infer<typeof Op>;

export const Agg = z.enum(["sum", "avg", "min", "max", "count"]);
export type Agg = z.infer<typeof Agg>;

export const Grain = z.enum(["day", "week", "month"]);
export type Grain = z.infer<typeof Grain>;

export const Direction = z.enum(["asc", "desc"]);
export type Direction = z.infer<typeof Direction>;

/** Relative date words the LLM may use. Resolved ONLY by code (dates.ts), never by the LLM. */
export const DateToken = z.enum([
  "today", "tomorrow", "yesterday",
  "this_week", "last_week",
  "this_month", "last_month", "last_month_to_date",
  "last_7_days", "last_30_days",
  "this_quarter", "last_quarter", "year_to_date",
]);
export type DateToken = z.infer<typeof DateToken>;

/** A filter's value as stored in UI state. Dates are ISO strings here (tokens are already resolved). */
export const FilterValue = z.object({
  op: Op,
  value: z.union([Scalar, z.array(Scalar)]),
});
export type FilterValue = z.infer<typeof FilterValue>;

/** One predicate on a dataset field. Used in metadata presets, query specs and KPI widgets. */
export const Condition = z.object({
  field: DbName,
  op: Op,
  value: z.union([Scalar, z.array(Scalar)]),
});
export type Condition = z.infer<typeof Condition>;
