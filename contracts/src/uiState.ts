import { z } from "zod";
import { Id, FilterValue, Scalar, Direction } from "./common";

export const SortState = z.object({ widgetId: Id, field: z.string(), direction: Direction });
export type SortState = z.infer<typeof SortState>;

/**
 * UI STATE = THE URL. The frontend derives this from the route + query string and nothing else
 * (see toDeepLink / fromDeepLink). Filter values are ISO/resolved, never date tokens.
 */
export const UiState = z.object({
  appId: Id,
  pageId: Id,
  route: z.string().startsWith("/"),
  filters: z.record(Id, FilterValue),
  sort: SortState.nullable(),
  selection: z.object({ widgetId: Id, rowKey: z.string() }).nullable().default(null),
  /** Filters the UI currently refuses (used for the failure demo). Reported by the frontend. */
  disabledFilters: z.array(Id).default([]),
  /** Incremented by the frontend on every state change. */
  version: z.number().int().nonnegative(),
});
export type UiState = z.infer<typeof UiState>;

export const emptyUiState = (appId: string, pageId: string, route: string): UiState =>
  ({ appId, pageId, route, filters: {}, sort: null, selection: null, disabledFilters: [], version: 0 });

const enc = (v: Scalar) => encodeURIComponent(String(v));
const dec = (s: string): Scalar => {
  const d = decodeURIComponent(s);
  if (d === "true") return true;
  if (d === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(d)) return Number(d);
  return d;
};

/** /inventory/medicines?f.stockLevel=eq:low&f.daysRemaining=lte:2&sort=medicineStock:stock:asc */
export function toDeepLink(route: string, s: Pick<UiState, "filters" | "sort">): string {
  const p = new URLSearchParams();
  for (const [id, fv] of Object.entries(s.filters).sort(([a], [b]) => a.localeCompare(b))) {
    const vals = Array.isArray(fv.value) ? fv.value : [fv.value];
    p.set(`f.${id}`, `${fv.op}:${vals.map(enc).join("|")}`);
  }
  if (s.sort) p.set("sort", `${s.sort.widgetId}:${s.sort.field}:${s.sort.direction}`);
  const q = p.toString();
  return q ? `${route}?${q}` : route;
}

export function fromDeepLink(url: string): { route: string; filters: Record<string, FilterValue>; sort: SortState | null } {
  const i = url.indexOf("?");
  const route = i < 0 ? url : url.slice(0, i);
  const params = new URLSearchParams(i < 0 ? "" : url.slice(i + 1));
  const filters: Record<string, FilterValue> = {};
  let sort: SortState | null = null;
  params.forEach((val, key) => {
    if (key.startsWith("f.")) {
      const c = val.indexOf(":");
      const op = val.slice(0, c) as FilterValue["op"];
      const vals = val.slice(c + 1).split("|").map(dec);
      filters[key.slice(2)] = { op, value: op === "in" || op === "between" ? vals : vals[0] };
    } else if (key === "sort") {
      const [widgetId, field, direction] = val.split(":");
      if (widgetId && field && (direction === "asc" || direction === "desc")) sort = { widgetId, field, direction };
    }
  });
  return { route, filters, sort };
}

export interface UiMismatch { field: string; expected: unknown; actual: unknown }
export interface ExpectedUiState {
  pageId?: string;
  route?: string;
  filters?: Record<string, FilterValue>;
  absentFilters?: string[];
  sort?: SortState | null;
}

const norm = (fv: FilterValue) =>
  `${fv.op}:${Array.isArray(fv.value) ? (fv.op === "between" ? fv.value.map(String) : fv.value.map(String).sort()).join("|") : String(fv.value)}`;

/** Verification primitive shared by agent (P3), UI layer (P4) and eval (P6). [] = state matches. */
export function diffUiState(expected: ExpectedUiState, actual: UiState): UiMismatch[] {
  const out: UiMismatch[] = [];
  if (expected.pageId !== undefined && expected.pageId !== actual.pageId) out.push({ field: "pageId", expected: expected.pageId, actual: actual.pageId });
  if (expected.route !== undefined && expected.route !== actual.route) out.push({ field: "route", expected: expected.route, actual: actual.route });
  for (const [id, fv] of Object.entries(expected.filters ?? {})) {
    const a = actual.filters[id];
    if (!a || norm(a) !== norm(fv)) out.push({ field: `filters.${id}`, expected: fv, actual: a ?? null });
  }
  for (const id of expected.absentFilters ?? []) if (actual.filters[id]) out.push({ field: `filters.${id}`, expected: null, actual: actual.filters[id] });
  if (expected.sort !== undefined) {
    const e = expected.sort, a = actual.sort;
    if (JSON.stringify(e) !== JSON.stringify(a)) out.push({ field: "sort", expected: e, actual: a });
  }
  return out;
}
