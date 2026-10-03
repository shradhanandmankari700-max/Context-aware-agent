import {
  ToolRegistry,
  MetadataStore,
  DataService,
  AnalyticsService,
  RequestContext,
  AppMetadata,
  RetrievalHit,
  RetrievalContext,
  QueryResult,
  AnalysisResult,
} from "@cab/contracts";
import { fakeHospitalMetadata, createFakeUiAdapter } from "../ui/fake";
import { createToolRegistry } from "./registry";

/**
 * In-memory fake MetadataStore backed by fakeHospitalMetadata.
 */
export class FakeMetadataStore implements MetadataStore {
  constructor(private app: AppMetadata = fakeHospitalMetadata) {}

  async getApp(_ctx: RequestContext): Promise<AppMetadata> {
    return this.app;
  }

  async listApps(_tenantId: string): Promise<{ appId: string; name: string; description: string }[]> {
    return [{ appId: this.app.appId, name: this.app.name, description: this.app.description }];
  }

  async search(_ctx: RequestContext, query: string, opts?: { kinds?: import("@cab/contracts").RetrievalKind[] }): Promise<RetrievalHit[]> {
    const hits: RetrievalHit[] = [];
    const q = query.toLowerCase();

    // Search pages
    if (!opts?.kinds || opts.kinds.includes("page")) {
      for (const p of this.app.pages) {
        if (p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) {
          hits.push({
            kind: "page",
            id: p.id,
            pageId: p.id,
            score: 0.9,
            name: p.name,
            path: p.name,
            description: p.description,
          });
        }
      }
    }

    return hits;
  }

  async buildContext(_ctx: RequestContext, _hits: RetrievalHit[]): Promise<RetrievalContext> {
    return {
      appId: this.app.appId,
      appName: this.app.name,
      navTree: this.app.pages.map((p) => ({ id: p.id, name: p.name, route: p.route, parent: p.parent })),
      pages: this.app.pages.map((p) => ({
          id: p.id, name: p.name, route: p.route, path: p.name, description: p.description,
        widgets: p.widgets.map((w) => ({
          id: w.id, name: w.name, type: w.type, dataset: w.dataset, description: w.description,
          columns: w.columns.map((c) => ({ field: c.field, label: c.label ?? c.field })), sortable: w.sortable ?? [],
        })),
        filters: p.filters.map((f) => ({
          id: f.id, label: f.label, type: f.type, field: f.field, description: f.description,
          operators: f.operators ?? [], options: f.options?.map((o) => ({ value: o.value, label: o.label })),
        })),
      })),
      datasets: this.app.datasets.map((d) => ({
        name: d.name, description: d.description, timeField: d.timeField,
        fields: d.fields.map((f) => ({
          name: f.name, label: f.label, type: f.type, description: f.description,
          derived: !!f.derived, enumValues: f.enumValues, roles: f.roles ?? [],
        })),
        relations: d.relations,
      })),
      actions: this.app.actions.map((a) => ({
        id: a.id, label: a.label, destructive: a.destructive, description: a.description,
      })),
    };
  }

  async importApp(): Promise<any> {
    return {
      appId: this.app.appId,
      pages: this.app.pages.length,
      widgets: 1,
      filters: 1,
      datasets: this.app.datasets.length,
      embedded: 0,
      rowsLoaded: 0,
    };
  }
}

/**
 * In-memory fake DataService.
 */
export class FakeDataService implements DataService {
  async query(_ctx: RequestContext, _spec: any): Promise<QueryResult> {
    return {
      queryId: crypto.randomUUID(),
      dataset: _spec.dataset ?? "medicines",
      columns: [{ name: "id", label: "ID", type: "string" }, { name: "name", label: "Name", type: "string" }],
      rows: [{ id: "1", name: "Amoxicillin" }],
      rowCount: 1,
      truncated: false,
      appliedWhere: _spec.where ?? [],
    };
  }

  async widgetData(
    _ctx: RequestContext,
    _pageId: string,
    _widgetId: string,
    _ui: any,
  ): Promise<QueryResult> {
    return {
      queryId: crypto.randomUUID(),
      dataset: "medicines",
      columns: [{ name: "medicine", label: "Medicine", type: "string" }, { name: "stock", label: "Stock", type: "number" }],
      rows: [{ medicine: "Paracetamol", stock: 120 }],
      rowCount: 1,
      truncated: false,
      appliedWhere: [],
    };
  }
}

/**
 * In-memory fake AnalyticsService.
 */
export class FakeAnalyticsService implements AnalyticsService {
  async run(_ctx: RequestContext, _spec: any): Promise<AnalysisResult> {
    return {
      resultId: crypto.randomUUID(),
      kind: _spec.kind ?? "rank",
      dataset: _spec.dataset ?? "medicines",
      metric: _spec.metric ?? { field: "stock", agg: "sum" },
      ranking: [{ key: "Paracetamol", value: 120 }],
      evidence: [{ id: "fake-stock", text: "Paracetamol stock is 120", value: 120 }],
      insufficientEvidence: false,
      provenance: { dataset: _spec.dataset ?? "medicines", queryIds: [] },
    };
  }
}

/**
 * Instantiates a fully functional in-memory ToolRegistry for testing and P3 agent integration.
 */
export interface FakeToolRegistryOptions {
  sessionId?: string;
  initialPageId?: string;
  disabledFilters?: string[];
}

/**
 * Builds a deterministic, in-memory registry. Options let demos and tests script
 * the starting page and failure-injection state without reaching into internals.
 */
export function createFakeToolRegistry(options: FakeToolRegistryOptions = {}): ToolRegistry {
  const metadata = new FakeMetadataStore();
  const data = new FakeDataService();
  const analytics = new FakeAnalyticsService();
  const sessionId = options.sessionId ?? "fake-session";
  const ui = createFakeUiAdapter(sessionId, options.initialPageId ?? "medicines");
  if (options.disabledFilters?.length) {
    ui.setDisabledFilters(sessionId, options.disabledFilters);
  }

  return createToolRegistry({
    metadata,
    data,
    analytics,
    ui,
  });
}
