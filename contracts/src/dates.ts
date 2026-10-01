import type { DateToken, Op, Scalar } from "./common";
import { DateToken as DateTokenSchema } from "./common";

// All math is UTC date-only (no timezone surprises).
const DAY = 86_400_000;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => fmt(parse(s) + n * DAY);
const ymd = (s: string) => { const d = new Date(parse(s)); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() }; };
const startOfMonth = (y: number, m: number) => fmt(Date.UTC(y, m, 1));
const endOfMonth = (y: number, m: number) => fmt(Date.UTC(y, m + 1, 0));

export interface DateRange { start: string; end: string }

/** Resolve a token against the demo clock `now` (YYYY-MM-DD). Ranges are inclusive. Weeks start Monday. */
export function resolveDateToken(token: DateToken, now: string): DateRange {
  const { y, m, d, dow } = ymd(now);
  switch (token) {
    case "today": return { start: now, end: now };
    case "tomorrow": { const t = addDays(now, 1); return { start: t, end: t }; }
    case "yesterday": { const t = addDays(now, -1); return { start: t, end: t }; }
    case "this_week": { const s = addDays(now, -((dow + 6) % 7)); return { start: s, end: addDays(s, 6) }; }
    case "last_week": { const s = addDays(now, -((dow + 6) % 7) - 7); return { start: s, end: addDays(s, 6) }; }
    case "this_month": return { start: startOfMonth(y, m), end: now }; // month-to-date
    case "last_month": return { start: startOfMonth(y, m - 1), end: endOfMonth(y, m - 1) };
    case "last_month_to_date": {
      const start = startOfMonth(y, m - 1), full = endOfMonth(y, m - 1);
      const same = fmt(Date.UTC(y, m - 1, d));
      return { start, end: same < full ? same : full };
    }
    case "last_7_days": return { start: addDays(now, -6), end: now };
    case "last_30_days": return { start: addDays(now, -29), end: now };
    case "this_quarter": { const q = Math.floor(m / 3) * 3; return { start: startOfMonth(y, q), end: endOfMonth(y, q + 2) }; }
    case "last_quarter": { const q = Math.floor(m / 3) * 3 - 3; return { start: startOfMonth(y, q), end: endOfMonth(y, q + 2) }; }
    case "year_to_date": return { start: fmt(Date.UTC(y, 0, 1)), end: now };
  }
}

export const isDateToken = (v: unknown): v is DateToken => DateTokenSchema.safeParse(v).success;

/**
 * Normalize a (op, value) that may contain a date token into ISO values.
 * eq/between + single-day token -> eq ; + range token -> between ; gte/gt -> start ; lte -> end ; lt -> start.
 */
export function normalizeDateValue(op: Op, value: Scalar | Scalar[], now: string): { op: Op; value: Scalar | Scalar[] } {
  const v = Array.isArray(value) ? value[0] : value;
  if (!isDateToken(v)) return { op, value };
  const r = resolveDateToken(v, now);
  if (op === "eq" || op === "between" || op === "in") {
    return r.start === r.end ? { op: "eq", value: r.start } : { op: "between", value: [r.start, r.end] };
  }
  if (op === "gte" || op === "gt") return { op, value: r.start };
  if (op === "lte") return { op, value: r.end };
  if (op === "lt") return { op, value: r.start };
  return { op, value };
}
