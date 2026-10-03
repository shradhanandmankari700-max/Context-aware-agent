import {
  AppMetadata,
  type MetadataStore,
  type RequestContext,
  type RetrievalHit,
} from "@cab/contracts";
import { buildMetadataContext, buildMetadataDocuments } from "./documents";
import { MetadataStoreError, validateImportBundle } from "./store";

export interface FakeMetadataApp {
  tenantId: string;
  metadata: AppMetadata;
}

export function createFakeMetadataStore(initialApps: FakeMetadataApp[] = []): MetadataStore {
  const apps = new Map<string, AppMetadata>();
  for (const entry of initialApps) apps.set(`${entry.tenantId}\u0000${entry.metadata.appId}`, AppMetadata.parse(entry.metadata));

  const get = (tenantId: string, appId: string): AppMetadata => {
    const app = apps.get(`${tenantId}\u0000${appId}`);
    if (!app) throw new MetadataStoreError(`Application ${appId} is not available to this tenant`, "TENANT_MISMATCH");
    return AppMetadata.parse(app);
  };

  return {
    async getApp(ctx: RequestContext) {
      return get(ctx.tenantId, ctx.appId);
    },

    async listApps(tenantId) {
      return [...apps.entries()]
        .filter(([key]) => key.startsWith(`${tenantId}\u0000`))
        .map(([, app]) => ({ appId: app.appId, name: app.name, description: app.description }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async importApp(tenantId, bundleValue) {
      const parsed = validateImportBundle(bundleValue);
      const app = AppMetadata.parse(parsed.metadata);
      apps.set(`${tenantId}\u0000${app.appId}`, app);
      const embedded = buildMetadataDocuments(app).length;
      return {
        appId: app.appId,
        pages: app.pages.length,
        widgets: app.pages.reduce((sum, page) => sum + page.widgets.length, 0),
        filters: app.pages.reduce((sum, page) => sum + page.filters.length, 0),
        datasets: app.datasets.length,
        embedded,
        rowsLoaded: Object.values(parsed.data ?? {}).reduce((sum, rows) => sum + rows.length, 0),
      };
    },

    async search(ctx, query, opts = {}) {
      const app = get(ctx.tenantId, ctx.appId);
      const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
      const kinds = opts.kinds ? new Set(opts.kinds) : undefined;
      const hits: RetrievalHit[] = buildMetadataDocuments(app)
        .filter((document) => !kinds || kinds.has(document.kind))
        .map((document) => {
          const searchable = document.doc.toLowerCase();
          const matched = tokens.filter((token) => searchable.includes(token)).length;
          const page = app.pages.find((candidate) => candidate.id === document.pageId);
          const filter = page?.filters.find((candidate) =>
            candidate.id === document.id || `${page.id}.${candidate.id}` === document.id);
          return {
            kind: document.kind,
            id: document.kind === "filter"
              ? filter?.id ?? document.id
              : document.id,
            pageId: document.pageId,
            widgetId: document.widgetId,
            name: document.name,
            path: document.path,
            description: document.description,
            score: tokens.length ? matched / tokens.length : 0,
          };
        })
        .filter((hit) => hit.score > 0)
        .map((hit) => ({ ...hit, score: hit.pageId === opts.currentPageId ? hit.score * 1.08 : hit.score }))
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Math.min(opts.k ?? 8, 20)));
      return hits;
    },

    async buildContext(ctx, hits, currentPageId) {
      return buildMetadataContext(get(ctx.tenantId, ctx.appId), hits, currentPageId);
    },
  };
}
