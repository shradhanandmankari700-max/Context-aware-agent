import { z } from "zod";
import { Id, FilterValue, IsoDate, Direction } from "./common";

/**
 * UiAction = what actually reaches the frontend (already validated + resolved by the backend).
 * The LLM never emits these directly; it emits ToolCalls (tools.ts) which the backend turns into UiActions.
 */
export const UiAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), pageId: Id, route: z.string().startsWith("/") }),
  z.object({ type: z.literal("set_filter"), pageId: Id, filterId: Id, value: FilterValue }),
  z.object({ type: z.literal("clear_filter"), pageId: Id, filterId: Id }),
  z.object({ type: z.literal("clear_all_filters"), pageId: Id }),
  z.object({ type: z.literal("set_date_range"), pageId: Id, filterId: Id, start: IsoDate, end: IsoDate }),
  z.object({ type: z.literal("sort"), pageId: Id, widgetId: Id, field: z.string(), direction: Direction }),
  z.object({ type: z.literal("open_details"), pageId: Id, widgetId: Id, rowKey: z.string() }),
]);
export type UiAction = z.infer<typeof UiAction>;
