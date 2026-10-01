import { z } from "zod";
import { Id, Op } from "./common";

export const RetrievalKind = z.enum(["page", "widget", "filter", "field", "dataset", "action"]);
export type RetrievalKind = z.infer<typeof RetrievalKind>;

export const RetrievalHit = z.object({
  kind: RetrievalKind,
  id: z.string(), // pageId | widgetId | filterId | "dataset.field" | dataset | actionId
  pageId: Id.optional(),
  widgetId: Id.optional(),
  name: z.string(),
  path: z.string(), // "Inventory > Medicines > Medicine Stock"
  description: z.string(),
  score: z.number(),
});
export type RetrievalHit = z.infer<typeof RetrievalHit>;

/** Compact, prompt-ready slice of the app. This (not the whole app) is what the planner LLM sees. */
export const RetrievalContext = z.object({
  appId: Id,
  appName: z.string(),
  navTree: z.array(z.object({ id: Id, name: z.string(), route: z.string(), parent: Id.nullable() })),
  pages: z.array(z.object({
    id: Id, name: z.string(), route: z.string(), path: z.string(), description: z.string(),
    widgets: z.array(z.object({
      id: Id, name: z.string(), type: z.string(), dataset: z.string(), description: z.string(),
      columns: z.array(z.object({ field: z.string(), label: z.string() })),
      sortable: z.array(z.string()),
    })),
    filters: z.array(z.object({
      id: Id, label: z.string(), type: z.string(), field: z.string(), description: z.string(),
      operators: z.array(Op),
      options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    })),
  })),
  datasets: z.array(z.object({
    name: z.string(), description: z.string(), timeField: z.string().optional(),
    fields: z.array(z.object({ name: z.string(), label: z.string(), type: z.string(), description: z.string(), derived: z.boolean(), enumValues: z.array(z.string()).optional(), roles: z.array(z.string()) })),
    relations: z.array(z.object({ field: z.string(), toDataset: z.string(), toField: z.string() })),
  })),
  actions: z.array(z.object({ id: Id, label: z.string(), destructive: z.boolean(), description: z.string() })),
});
export type RetrievalContext = z.infer<typeof RetrievalContext>;
