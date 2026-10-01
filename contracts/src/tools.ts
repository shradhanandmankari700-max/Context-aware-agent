import { z } from "zod";
import { Id, DbName, Scalar, Op, Direction, IsoDate, DateToken } from "./common";
import { QuerySpec, AnalysisSpec } from "./query";
import { RetrievalKind } from "./retrieval";

export const ErrorCode = z.enum([
  "PAGE_NOT_FOUND", "WIDGET_NOT_FOUND", "FILTER_NOT_FOUND", "FILTER_UNAVAILABLE", "INVALID_FILTER_VALUE", "INVALID_OPERATOR",
  "FIELD_NOT_ALLOWED", "DATASET_NOT_FOUND", "INVALID_QUERY", "FORBIDDEN", "TENANT_MISMATCH",
  "VERIFICATION_FAILED", "UI_TIMEOUT", "AMBIGUOUS", "NEEDS_CONFIRMATION", "LLM_ERROR", "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export type ToolError = { code: ErrorCode; message: string; candidates?: string[]; hint?: string };
/** Every tool returns this envelope; tools NEVER throw to the agent. */
export type ToolResult<T = unknown> =
  | { ok: true; data: T; meta?: { queryId?: string; resultId?: string } }
  | { ok: false; error: ToolError };

const FilterArg = z.union([Scalar, z.array(Scalar)]); // may be a DateToken for date filters; tool resolves it

/** The ONLY things the LLM may ask for. Anything else fails zod validation before execution. */
export const ToolCall = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("search_metadata"), args: z.object({ query: z.string().min(1), kinds: z.array(RetrievalKind).optional(), k: z.number().int().min(1).max(20).optional() }) }),
  z.object({ tool: z.literal("get_app_metadata"), args: z.object({}) }),
  z.object({ tool: z.literal("get_page_details"), args: z.object({ pageId: Id }) }),
  z.object({ tool: z.literal("get_available_filters"), args: z.object({ pageId: Id.optional() }) }),
  z.object({ tool: z.literal("get_current_page"), args: z.object({}) }),
  z.object({ tool: z.literal("get_current_ui_state"), args: z.object({}) }),
  z.object({ tool: z.literal("navigate"), args: z.object({ target: z.string().min(1) }) }), // pageId | route | page name
  z.object({ tool: z.literal("set_filter"), args: z.object({ filterId: Id, op: Op.optional(), value: FilterArg, pageId: Id.optional() }) }),
  z.object({ tool: z.literal("clear_filter"), args: z.object({ filterId: Id, pageId: Id.optional() }) }),
  z.object({ tool: z.literal("set_date_range"), args: z.object({ filterId: Id.optional(), token: DateToken.optional(), start: IsoDate.optional(), end: IsoDate.optional() }) }),
  z.object({ tool: z.literal("sort"), args: z.object({ widgetId: Id.optional(), field: DbName, direction: Direction }) }),
  z.object({ tool: z.literal("get_widget_data"), args: z.object({ widgetId: Id, limit: z.number().int().min(1).max(200).optional() }) }),
  z.object({ tool: z.literal("query_business_data"), args: z.object({ spec: QuerySpec }) }),
  z.object({ tool: z.literal("run_analysis"), args: z.object({ spec: AnalysisSpec }) }),
  z.object({ tool: z.literal("invoke_app_action"), args: z.object({ actionId: Id, params: z.record(z.string(), Scalar).default({}) }) }),
]);
export type ToolCall = z.infer<typeof ToolCall>;
export type ToolName = ToolCall["tool"];

/** read = auto-run; action = changes UI state (auto-run, verified); destructive = needs user confirmation. */
export const TOOL_KIND: Record<ToolName, "read" | "action" | "destructive"> = {
  search_metadata: "read", get_app_metadata: "read", get_page_details: "read", get_available_filters: "read",
  get_current_page: "read", get_current_ui_state: "read", get_widget_data: "read", query_business_data: "read", run_analysis: "read",
  navigate: "action", set_filter: "action", clear_filter: "action", set_date_range: "action", sort: "action",
  invoke_app_action: "destructive", // upgraded/downgraded per action by metadata `destructive` flag
};

/** What the planner LLM returns each iteration. */
export const AgentTurn = z.object({
  intent: z.string(),
  reasoning: z.string().max(600).describe("one or two sentences, shown in the debug panel"),
  clarification: z.object({ question: z.string(), options: z.array(z.string()).optional() }).optional(),
  steps: z.array(ToolCall).max(8),
  done: z.boolean(), // true = no more tool calls needed, go narrate
});
export type AgentTurn = z.infer<typeof AgentTurn>;
