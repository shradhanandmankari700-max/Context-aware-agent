/** Small Mulberry32 generator; stable across Node versions. */
export function rng(seed = 0x51eed): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const isoDay = (daysAgo: number, now = "2026-10-07") => {
  const d = new Date(`${now}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - daysAgo); return d.toISOString().slice(0, 10);
};
