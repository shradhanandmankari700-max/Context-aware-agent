import type { AppMetadata, Page, Widget, Filter, Dataset } from "./metadata";

export const getPage = (app: AppMetadata, idOrRoute: string): Page | undefined =>
  app.pages.find((p) => p.id === idOrRoute || p.route === idOrRoute);
export const getDataset = (app: AppMetadata, name: string): Dataset | undefined => app.datasets.find((d) => d.name === name);
export const getWidget = (app: AppMetadata, widgetId: string): { page: Page; widget: Widget } | undefined => {
  for (const page of app.pages) { const widget = page.widgets.find((w) => w.id === widgetId); if (widget) return { page, widget }; }
  return undefined;
};
export const getFilter = (app: AppMetadata, pageId: string, filterId: string): Filter | undefined =>
  getPage(app, pageId)?.filters.find((f) => f.id === filterId);
/** "Inventory > Medicines" style breadcrumb. */
export function pagePath(app: AppMetadata, pageId: string): string {
  const parts: string[] = []; let p = getPage(app, pageId); let guard = 0;
  while (p && guard++ < 10) { parts.unshift(p.name); p = p.parent ? getPage(app, p.parent) : undefined; }
  return parts.join(" > ");
}
/** Default operators per filter type, used when `operators` is omitted. */
export const defaultOps = (t: Filter["type"]) =>
  ({ enum: ["eq", "in"], number: ["eq", "lt", "lte", "gt", "gte", "between"], text: ["contains", "eq"], date: ["eq", "lt", "lte", "gt", "gte"], dateRange: ["between"], boolean: ["eq"] } as const)[t];
