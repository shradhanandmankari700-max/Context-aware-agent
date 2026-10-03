import type {
  AppMetadata,
  MetadataStore,
  RequestContext,
  ToolCall,
  ToolRegistry,
  ToolResult,
  Trace,
  TraceStore,
  UiAdapter,
  UiState,
} from "@cab/contracts";

export interface MockUiAdapter extends UiAdapter {
  getStateSync(): UiState;
  setDisabledFilters(filters: string[]): void;
}

export function createMockUiAdapter(initialState?: UiState): MockUiAdapter {
  let state: UiState = initialState ?? {
    appId: "hospital",
    pageId: "dashboard",
    route: "/dashboard",
    filters: {},
    sort: null,
    selection: null,
    disabledFilters: [],
    version: 0,
  };

  return {
    async getState() {
      return state;
    },
    getStateSync() {
      return state;
    },
    setDisabledFilters(filters: string[]) {
      state.disabledFilters = [...filters];
    },
    async dispatch(_sessionId, action) {
      if (action.type === "navigate") {
        state.pageId = action.pageId;
        state.route = action.route;
      } else if (action.type === "set_filter") {
        state.filters[action.filterId] = action.value;
      } else if (action.type === "clear_filter") {
        delete state.filters[action.filterId];
      } else if (action.type === "clear_all_filters") {
        state.filters = {};
      } else if (action.type === "set_date_range") {
        state.filters[action.filterId] = {
          op: "between",
          value: [action.start, action.end],
        };
      } else if (action.type === "sort") {
        state.sort = {
          widgetId: action.widgetId,
          field: action.field,
          direction: action.direction,
        };
      }
      state.version++;
      return { actionId: `act-${state.version}` };
    },
    async awaitAck() {
      return { state };
    },
  };
}

export function createMockMetadataStore(app: AppMetadata): MetadataStore {
  return {
    async getApp() {
      return app;
    },
    async listApps() {
      return [{ appId: app.appId, name: app.name, description: app.description }];
    },
    async search(_ctx, query) {
      const q = query.toLowerCase();
      const hits = [];
      for (const p of app.pages) {
        if (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || q.includes(p.name.toLowerCase())) {
          hits.push({ kind: "page" as const, id: p.id, name: p.name, path: p.name, description: p.description, score: 0.9 });
        }
        for (const f of p.filters) {
          if (f.label.toLowerCase().includes(q) || f.id.toLowerCase().includes(q) || f.synonyms?.some((s) => s.toLowerCase().includes(q))) {
            hits.push({ kind: "filter" as const, id: f.id, name: f.label, path: `${p.name} > ${f.label}`, description: f.description, score: 0.85 });
          }
        }
      }
      if (hits.length === 0) {
        const firstPage = app.pages[0];
        if (firstPage) {
          hits.push({ kind: "page" as const, id: firstPage.id, name: firstPage.name, path: firstPage.name, description: firstPage.description, score: 0.5 });
        }
      }
      return hits;
    },
    async buildContext() {
      return {
        appId: app.appId,
        appName: app.name,
        navTree: app.pages.map((p) => ({
          id: p.id,
          name: p.name,
          route: p.route,
          parent: p.parent,
        })),
        pages: app.pages.map((p) => ({
          id: p.id,
          name: p.name,
          route: p.route,
          path: p.name,
          description: p.description,
          widgets: p.widgets.map((w) => ({
            id: w.id,
            name: w.name,
            type: w.type,
            dataset: w.dataset,
            description: w.description,
            columns: (w.columns ?? []).map((c) => ({ field: c.field, label: c.label || c.field })),
            sortable: w.sortable ?? [],
          })),
          filters: p.filters.map((f) => ({
            id: f.id,
            label: f.label,
            type: f.type,
            field: f.field,
            description: f.description,
            operators: f.operators ?? (["eq"] as any),
            options: f.options,
          })),
        })),
        datasets: app.datasets.map((d) => ({
          name: d.name,
          description: d.description,
          timeField: d.timeField,
          fields: d.fields.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            description: f.description,
            derived: !!f.derived,
            roles: f.roles,
          })),
          relations: d.relations ?? [],
        })),
        actions: app.actions.map((a) => ({
          id: a.id,
          label: a.label,
          destructive: a.destructive,
          description: a.description,
        })),
      };
    },
    async importApp() {
      return { appId: app.appId, pages: app.pages.length, widgets: 5, filters: 5, datasets: 5, embedded: 10, rowsLoaded: 50 };
    },
  };
}

export interface MockToolRegistry extends ToolRegistry {
  executedCalls: ToolCall[];
}

export function createMockToolRegistry(
  app: AppMetadata,
  uiAdapter: UiAdapter,
  customHandlers?: Partial<Record<string, (call: ToolCall) => Promise<ToolResult>>>,
): MockToolRegistry {
  const executedCalls: ToolCall[] = [];

  return {
    executedCalls,
    async execute(ctx: RequestContext, call: ToolCall): Promise<ToolResult> {
      executedCalls.push(call);

      if (customHandlers && customHandlers[call.tool]) {
        return customHandlers[call.tool]!(call);
      }

      if (call.tool === "navigate") {
        const page = app.pages.find((p) => p.id === call.args.target || p.name.toLowerCase() === call.args.target.toLowerCase());
        if (page) {
          await uiAdapter.dispatch(ctx.sessionId, {
            type: "navigate",
            pageId: page.id,
            route: page.route,
          });
          return { ok: true, data: { navigatedTo: page.id, route: page.route } };
        }
        return {
          ok: false,
          error: { code: "PAGE_NOT_FOUND", message: `Page "${call.args.target}" not found` },
        };
      }

      if (call.tool === "set_filter") {
        const pageId = call.args.pageId ?? (await uiAdapter.getState(ctx.sessionId))?.pageId ?? app.pages[0]?.id!;
        await uiAdapter.dispatch(ctx.sessionId, {
          type: "set_filter",
          pageId,
          filterId: call.args.filterId,
          value: { op: call.args.op ?? "eq", value: call.args.value as any },
        });
        return { ok: true, data: { filterSet: call.args.filterId, value: call.args.value } };
      }

      if (call.tool === "clear_filter") {
        const pageId = call.args.pageId ?? (await uiAdapter.getState(ctx.sessionId))?.pageId ?? app.pages[0]?.id!;
        await uiAdapter.dispatch(ctx.sessionId, {
          type: "clear_filter",
          pageId,
          filterId: call.args.filterId,
        });
        return { ok: true, data: { filterCleared: call.args.filterId } };
      }

      if (call.tool === "set_date_range") {
        const pageId = (await uiAdapter.getState(ctx.sessionId))?.pageId ?? app.pages[0]?.id!;
        const filterId = call.args.filterId ?? "dateRange";
        const start = call.args.start ?? "2026-10-07";
        const end = call.args.end ?? "2026-10-08";
        await uiAdapter.dispatch(ctx.sessionId, {
          type: "set_date_range",
          pageId,
          filterId,
          start,
          end,
        });
        return { ok: true, data: { dateRangeSet: { start, end } } };
      }

      if (call.tool === "sort") {
        const pageId = (await uiAdapter.getState(ctx.sessionId))?.pageId ?? app.pages[0]?.id!;
        await uiAdapter.dispatch(ctx.sessionId, {
          type: "sort",
          pageId,
          widgetId: call.args.widgetId ?? "table",
          field: call.args.field,
          direction: call.args.direction,
        });
        return { ok: true, data: { sortSet: call.args.field, direction: call.args.direction } };
      }

      if (call.tool === "get_widget_data") {
        return {
          ok: true,
          data: {
            dataset: "medicines",
            columns: [{ name: "medicine", label: "Medicine", type: "string" }],
            rows: [
              { medicine: "Amoxicillin", stock: 12, daily_usage: 15, days_remaining: 0.8 },
              { medicine: "Insulin", stock: 5, daily_usage: 8, days_remaining: 0.6 },
            ],
            rowCount: 2,
          },
          meta: { resultId: "res-widget-medicines" },
        };
      }

      if (call.tool === "query_business_data") {
        return {
          ok: true,
          data: {
            dataset: call.args.spec.dataset,
            columns: [{ name: "item", label: "Item", type: "string" }],
            rows: [{ item: "data-1", value: 100 }],
            rowCount: 1,
            appliedWhere: [],
          },
          meta: { resultId: `res-query-${call.args.spec.dataset}` },
        };
      }

      if (call.tool === "run_analysis") {
        return {
          ok: true,
          data: {
            resultId: "res-analysis-1",
            kind: call.args.spec.kind,
            dataset: call.args.spec.dataset,
            metric: call.args.spec.metric,
            periods: {
              a: { start: "2026-10-01", end: "2026-10-07", days: 7, value: 500 },
              b: { start: "2026-09-01", end: "2026-09-07", days: 7, value: 450 },
              note: "Period A is month-to-date (7 days) vs same 7 days last month",
            },
            pctChange: 0.11,
            evidence: [{ id: "e1", text: "Usage increased by 11% month-to-date", value: 11 }],
            insufficientEvidence: false,
            provenance: { dataset: call.args.spec.dataset, queryIds: ["q1"] },
          },
          meta: { resultId: "res-analysis-1" },
        };
      }

      if (call.tool === "invoke_app_action") {
        return { ok: true, data: { actionExecuted: call.args.actionId } };
      }

      return { ok: true, data: { success: true } };
    },
  };
}

export function createMockTraceStore(): TraceStore & { traces: Trace[] } {
  const traces: Trace[] = [];
  return {
    traces,
    async save(trace) {
      traces.push(trace);
    },
    async get(id) {
      return traces.find((t) => t.traceId === id) ?? null;
    },
    async list() {
      return traces;
    },
  };
}
