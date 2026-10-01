import { z } from "zod";
import { Id, DbName, IsoDate, Op, Agg, Direction, Condition, FilterValue } from "./common";

export const FieldType = z.enum(["string", "number", "date", "boolean"]);
export type FieldType = z.infer<typeof FieldType>;

/**
 * Derived (computed) field expression. Strings are references to other fields of the SAME dataset,
 * numbers are literals. Compiled to SQL by the query engine (div => NULLIF guard). No raw SQL, ever.
 * Example days_remaining: { op:"round", args:[{ op:"div", args:["stock","daily_usage"] }, 1] }
 */
export type DerivedExpr = string | number | { op: "add" | "sub" | "mul" | "div" | "min" | "max" | "round"; args: DerivedExpr[] };
export const DerivedExpr: z.ZodType<DerivedExpr> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.object({ op: z.enum(["add", "sub", "mul", "div", "min", "max", "round"]), args: z.array(DerivedExpr).min(1) }),
  ]),
);

export const DatasetField = z.object({
  name: DbName,
  label: z.string(),
  type: FieldType,
  description: z.string().default(""),
  synonyms: z.array(z.string()).default([]),
  unit: z.string().optional(),
  format: z.enum(["text", "integer", "decimal", "currency", "percent", "date"]).optional(),
  derived: DerivedExpr.optional(),
  enumValues: z.array(z.string()).optional(),
  /** key=row id, label=display name, metric=summable/averageable, dimension=groupable, time=period field */
  roles: z.array(z.enum(["key", "label", "metric", "dimension", "time"])).default([]),
});
export type DatasetField = z.infer<typeof DatasetField>;

export const Dataset = z.object({
  name: DbName,
  label: z.string(),
  description: z.string().default(""),
  table: DbName, // physical table inside the app's schema (app_<appId>)
  timeField: DbName.optional(),
  fields: z.array(DatasetField).min(1),
  relations: z.array(z.object({ field: DbName, toDataset: DbName, toField: DbName })).default([]),
});
export type Dataset = z.infer<typeof Dataset>;

export const FilterOption = z.object({
  value: z.string(),
  label: z.string(),
  synonyms: z.array(z.string()).default([]),
  /** Preset predicate(s). If omitted the option means "field eq value". */
  where: z.array(Condition).optional(),
});
export type FilterOption = z.infer<typeof FilterOption>;

export const Filter = z.object({
  id: Id,
  label: z.string(),
  description: z.string().default(""),
  synonyms: z.array(z.string()).default([]),
  type: z.enum(["enum", "number", "text", "date", "dateRange", "boolean"]),
  field: DbName,
  operators: z.array(Op).optional(), // allowed ops; defaults are derived from `type`
  options: z.array(FilterOption).optional(),
  defaultValue: FilterValue.optional(),
});
export type Filter = z.infer<typeof Filter>;

export const Widget = z.object({
  id: Id,
  name: z.string(),
  type: z.enum(["table", "chart", "kpi"]),
  description: z.string().default(""),
  dataset: DbName,
  columns: z.array(z.object({ field: DbName, label: z.string().optional() })).default([]),
  sortable: z.array(DbName).default([]),
  defaultSort: z.object({ field: DbName, direction: Direction }).optional(),
  chart: z.object({
    kind: z.enum(["bar", "line", "pie", "donut"]),
    x: z.object({ field: DbName, grain: z.enum(["day", "week", "month"]).optional() }),
    y: z.object({ field: DbName, agg: Agg }),
    series: DbName.optional(),
  }).optional(),
  kpi: z.object({ field: DbName, agg: Agg, where: z.array(Condition).default([]) }).optional(),
  /** Which page filters apply to this widget. Omitted = all filters of the page whose field exists in the dataset. */
  filters: z.array(Id).optional(),
});
export type Widget = z.infer<typeof Widget>;

export const Page = z.object({
  id: Id,
  name: z.string(),
  route: z.string().startsWith("/"),
  parent: Id.nullable().default(null),
  description: z.string().default(""),
  icon: z.string().optional(),
  widgets: z.array(Widget).default([]),
  filters: z.array(Filter).default([]),
  allowedRoles: z.array(z.string()).optional(),
});
export type Page = z.infer<typeof Page>;

export const AppAction = z.object({
  id: Id,
  label: z.string(),
  description: z.string().default(""),
  pageId: Id.optional(),
  destructive: z.boolean().default(false),
  requiredRole: z.string().default("admin"),
  params: z.array(z.object({ name: z.string(), type: FieldType, required: z.boolean().default(true) })).default([]),
});
export type AppAction = z.infer<typeof AppAction>;

export const AppMetadata = z.object({
  schemaVersion: z.literal(1),
  appId: Id,
  name: z.string(),
  description: z.string().default(""),
  /** Demo clock for this app (YYYY-MM-DD). Seed data is generated relative to it. */
  referenceDate: IsoDate.optional(),
  roles: z.array(z.string()).default(["admin", "staff", "viewer"]),
  datasets: z.array(Dataset).min(1),
  pages: z.array(Page).min(1),
  actions: z.array(AppAction).default([]),
});
export type AppMetadata = z.infer<typeof AppMetadata>;

/** Bundle accepted by POST /api/apps/import: metadata + optional business rows per dataset. */
export const ImportBundle = z.object({
  metadata: AppMetadata,
  data: z.record(DbName, z.array(z.record(z.string(), z.unknown()))).optional(),
});
export type ImportBundle = z.infer<typeof ImportBundle>;
