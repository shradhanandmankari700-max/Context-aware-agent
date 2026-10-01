import type { AppMetadata, DerivedExpr } from "./metadata";

const refs = (e: DerivedExpr, out: string[] = []): string[] => {
  if (typeof e === "string") out.push(e);
  else if (typeof e === "object") e.args.forEach((a) => refs(a, out));
  return out;
};

/** Semantic validation on top of the zod shape. Returns human-readable errors ([] = valid). Used by importer + CI. */
export function validateAppMetadata(app: AppMetadata): string[] {
  const errs: string[] = [];
  const dup = (label: string, xs: string[]) => { const s = new Set<string>(); xs.forEach((x) => { if (s.has(x)) errs.push(`duplicate ${label}: ${x}`); s.add(x); }); };

  dup("dataset", app.datasets.map((d) => d.name));
  dup("page id", app.pages.map((p) => p.id));
  dup("route", app.pages.map((p) => p.route));
  dup("widget id", app.pages.flatMap((p) => p.widgets.map((w) => w.id)));

  const ds = new Map(app.datasets.map((d) => [d.name, d]));
  for (const d of app.datasets) {
    const fields = new Set(d.fields.map((f) => f.name));
    dup(`field in ${d.name}`, d.fields.map((f) => f.name));
    if (d.timeField && !fields.has(d.timeField)) errs.push(`${d.name}.timeField ${d.timeField} not a field`);
    for (const f of d.fields) if (f.derived !== undefined) for (const r of refs(f.derived)) if (!fields.has(r)) errs.push(`${d.name}.${f.name} derived refers to unknown field ${r}`);
    for (const r of d.relations) {
      if (!fields.has(r.field)) errs.push(`${d.name} relation field ${r.field} unknown`);
      const t = ds.get(r.toDataset);
      if (!t) errs.push(`${d.name} relation -> unknown dataset ${r.toDataset}`);
      else if (!t.fields.some((f) => f.name === r.toField)) errs.push(`${d.name} relation -> ${r.toDataset}.${r.toField} unknown`);
    }
  }

  const pageIds = new Set(app.pages.map((p) => p.id));
  for (const p of app.pages) {
    if (p.parent && !pageIds.has(p.parent)) errs.push(`page ${p.id} parent ${p.parent} unknown`);
    if (p.parent === p.id) errs.push(`page ${p.id} is its own parent`);
    dup(`filter id on ${p.id}`, p.filters.map((f) => f.id));
    const filterIds = new Set(p.filters.map((f) => f.id));
    for (const w of p.widgets) {
      const d = ds.get(w.dataset);
      if (!d) { errs.push(`widget ${w.id} dataset ${w.dataset} unknown`); continue; }
      const fields = new Set(d.fields.map((f) => f.name));
      const need = (f: string, where: string) => { if (!fields.has(f)) errs.push(`${where}: field ${f} not in dataset ${d.name}`); };
      w.columns.forEach((c) => need(c.field, `widget ${w.id} column`));
      w.sortable.forEach((f) => need(f, `widget ${w.id} sortable`));
      if (w.defaultSort) need(w.defaultSort.field, `widget ${w.id} defaultSort`);
      if (w.type === "table" && w.columns.length === 0) errs.push(`table widget ${w.id} has no columns`);
      if (w.type === "chart") { if (!w.chart) errs.push(`chart widget ${w.id} missing chart`); else { need(w.chart.x.field, `widget ${w.id} chart.x`); need(w.chart.y.field, `widget ${w.id} chart.y`); } }
      if (w.type === "kpi") { if (!w.kpi) errs.push(`kpi widget ${w.id} missing kpi`); else { need(w.kpi.field, `widget ${w.id} kpi`); w.kpi.where.forEach((c) => need(c.field, `widget ${w.id} kpi.where`)); } }
      (w.filters ?? []).forEach((fid) => { if (!filterIds.has(fid)) errs.push(`widget ${w.id} references unknown filter ${fid}`); });
    }
    const dsOnPage = p.widgets.map((w) => ds.get(w.dataset)).filter(Boolean);
    for (const f of p.filters) {
      if (dsOnPage.length && !dsOnPage.some((d) => d!.fields.some((x) => x.name === f.field))) errs.push(`filter ${p.id}.${f.id} field ${f.field} is in no dataset used on this page`);
      for (const o of f.options ?? []) for (const c of o.where ?? []) if (dsOnPage.length && !dsOnPage.some((d) => d!.fields.some((x) => x.name === c.field))) errs.push(`filter ${f.id} option ${o.value} where-field ${c.field} unknown`);
    }
  }
  for (const a of app.actions) if (a.pageId && !pageIds.has(a.pageId)) errs.push(`action ${a.id} pageId ${a.pageId} unknown`);
  return errs;
}
