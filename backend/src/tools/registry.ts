import {
  ToolRegistry,
  RequestContext,
  ToolCall,
  ToolResult,
  ErrorCode,
  MetadataStore,
  DataService,
  AnalyticsService,
  UiAdapter,
  UiAction,
  UiMismatch,
  ExpectedUiState,
  diffUiState,
  normalizeDateValue,
  resolveDateToken,
  DateToken,
  Op,
  Scalar,
  FilterValue,
  Page,
  AppMetadata,
  getWidget,
} from "@cab/contracts";

export interface ToolRegistryDeps {
  metadata: MetadataStore;
  data?: DataService;
  analytics?: AnalyticsService;
  ui: UiAdapter;
}

export class DefaultToolRegistry implements ToolRegistry {
  constructor(private deps: ToolRegistryDeps) {}

  async execute(ctx: RequestContext, rawCall: ToolCall): Promise<ToolResult> {
    try {
      // 1. Zod runtime re-validation
      const parseResult = ToolCall.safeParse(rawCall);
      if (!parseResult.success) {
        return {
          ok: false,
          error: {
            code: "INVALID_QUERY",
            message: `Invalid tool call payload: ${parseResult.error.message}`,
          },
        };
      }

      const call = parseResult.data;

      // 2. Dispatch to specific tool handler
      switch (call.tool) {
        case "search_metadata":
          return await this.searchMetadata(ctx, call.args);
        case "get_app_metadata":
          return await this.getAppMetadata(ctx);
        case "get_page_details":
          return await this.getPageDetails(ctx, call.args);
        case "get_available_filters":
          return await this.getAvailableFilters(ctx, call.args);
        case "get_current_page":
          return await this.getCurrentPage(ctx);
        case "get_current_ui_state":
          return await this.getCurrentUiState(ctx);
        case "navigate":
          return await this.navigate(ctx, call.args);
        case "set_filter":
          return await this.setFilter(ctx, call.args);
        case "clear_filter":
          return await this.clearFilter(ctx, call.args);
        case "set_date_range":
          return await this.setDateRange(ctx, call.args);
        case "sort":
          return await this.sort(ctx, call.args);
        case "get_widget_data":
          return await this.getWidgetData(ctx, call.args);
        case "query_business_data":
          return await this.queryBusinessData(ctx, call.args);
        case "run_analysis":
          return await this.runAnalysis(ctx, call.args);
        case "invoke_app_action":
          return await this.invokeAppAction(ctx, call.args);
        default: {
          const _exhaustive: never = call;
          return {
            ok: false,
            error: {
              code: "AMBIGUOUS",
              message: `Unknown tool: ${JSON.stringify(_exhaustive)}`,
            },
          };
        }
      }
    } catch (err: unknown) {
      // Tools NEVER throw to the agent: catch all errors and map to INTERNAL
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message,
        },
      };
    }
  }

  // --- READ TOOLS (Thin wrappers) ---

  private async searchMetadata(
    ctx: RequestContext,
    args: { query: string; kinds?: any[]; k?: number },
  ): Promise<ToolResult> {
    const hits = await this.deps.metadata.search(ctx, args.query, {
      kinds: args.kinds,
      k: args.k,
    });
    return {
      ok: true,
      data: hits,
      meta: { queryId: crypto.randomUUID() },
    };
  }

  private async getAppMetadata(ctx: RequestContext): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const navTree = app.pages.map((p) => ({
      id: p.id,
      name: p.name,
      route: p.route,
      parent: p.parent,
      description: p.description,
      widgetsCount: p.widgets.length,
      filtersCount: p.filters.length,
    }));

    return {
      ok: true,
      data: {
        appId: app.appId,
        name: app.name,
        description: app.description,
        pages: navTree,
        datasets: app.datasets.map((d) => ({
          name: d.name,
          label: d.label,
          description: d.description,
        })),
      },
      meta: { queryId: crypto.randomUUID() },
    };
  }

  private async getPageDetails(
    ctx: RequestContext,
    args: { pageId: string },
  ): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const page = app.pages.find((p) => p.id === args.pageId);
    if (!page) {
      return {
        ok: false,
        error: {
          code: "PAGE_NOT_FOUND",
          message: `Page "${args.pageId}" not found in app metadata`,
          candidates: app.pages.slice(0, 3).map((p) => p.name),
        },
      };
    }

    return {
      ok: true,
      data: page,
      meta: { queryId: crypto.randomUUID() },
    };
  }

  private async getAvailableFilters(
    ctx: RequestContext,
    args: { pageId?: string },
  ): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const currentState = await this.deps.ui.getState(ctx.sessionId);

    const targetPageId = args.pageId || currentState?.pageId || app.pages[0]?.id;
    const page = app.pages.find((p) => p.id === targetPageId);
    if (!page) {
      return {
        ok: false,
        error: {
          code: "PAGE_NOT_FOUND",
          message: `Page "${targetPageId}" not found`,
          candidates: app.pages.slice(0, 3).map((p) => p.name),
        },
      };
    }

    const disabledList = currentState?.disabledFilters ?? [];
    const available = page.filters.filter((f) => !disabledList.includes(f.id));

    return {
      ok: true,
      data: {
        pageId: page.id,
        filters: available,
        disabledFilters: disabledList,
      },
      meta: { queryId: crypto.randomUUID() },
    };
  }

  private async getCurrentPage(ctx: RequestContext): Promise<ToolResult> {
    const state = await this.deps.ui.getState(ctx.sessionId);
    return {
      ok: true,
      data: {
        pageId: state?.pageId ?? null,
        route: state?.route ?? null,
      },
      meta: { queryId: crypto.randomUUID() },
    };
  }

  private async getCurrentUiState(ctx: RequestContext): Promise<ToolResult> {
    const state = await this.deps.ui.getState(ctx.sessionId);
    return {
      ok: true,
      data: state,
      meta: { queryId: crypto.randomUUID() },
    };
  }

  // --- ACTION TOOLS (with verification) ---

  private async navigate(
    ctx: RequestContext,
    args: { target: string },
  ): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const resolvedPage = await this.resolveTargetPage(ctx, app, args.target);

    if (!resolvedPage) {
      const candidates = app.pages.slice(0, 3).map((p) => p.name);
      return {
        ok: false,
        error: {
          code: "PAGE_NOT_FOUND",
          message: `Could not resolve navigation target "${args.target}" to a valid page`,
          candidates,
        },
      };
    }

    const action: UiAction = {
      type: "navigate",
      pageId: resolvedPage.id,
      route: resolvedPage.route,
    };

    const { actionId } = await this.deps.ui.dispatch(ctx.sessionId, action);
    const ack = await this.deps.ui.awaitAck(ctx.sessionId, actionId, 3000);

    if ("timeout" in ack) {
      // No live browser client: fall back to the hub's last-known state. If the
      // hub already reflects the target page, treat the navigation as applied.
      const fallback = await this.deps.ui.getState(ctx.sessionId);
      if (fallback && fallback.pageId === resolvedPage.id) {
        return {
          ok: true,
          data: { navigated: true, fallback: true },
          meta: { resultId: `nav-${resolvedPage.id}` },
        };
      }
      return {
        ok: false,
        error: {
          code: "UI_TIMEOUT",
          message: `Timed out waiting for UI navigation to page "${resolvedPage.id}"`,
        },
      };
    }

    if (ack.rejected) {
      return {
        ok: false,
        error: {
          code: (ack.rejected.code as ErrorCode) || "INTERNAL",
          message: ack.rejected.reason,
        },
      };
    }

    const expected: ExpectedUiState = {
      pageId: resolvedPage.id,
      route: resolvedPage.route,
    };
    const mismatches = diffUiState(expected, ack.state);
    const verified = mismatches.length === 0;

    return {
      ok: true,
      data: {
        expected,
        actual: ack.state,
        verified,
        mismatches,
      },
      meta: { resultId: crypto.randomUUID() },
    };
  }

  private async setFilter(
    ctx: RequestContext,
    args: { filterId: string; op?: Op; value: Scalar | Scalar[]; pageId?: string },
  ): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const currentState = await this.deps.ui.getState(ctx.sessionId);

    const targetPageId = args.pageId || currentState?.pageId || app.pages[0]?.id;
    const page = app.pages.find((p) => p.id === targetPageId);
    if (!page) {
      return {
        ok: false,
        error: {
          code: "PAGE_NOT_FOUND",
          message: `Target page "${targetPageId}" not found`,
          candidates: app.pages.slice(0, 3).map((p) => p.name),
        },
      };
    }

    // Resolve filter by id, label, or synonym
    const filter = this.resolveFilterOnPage(page, args.filterId);
    if (!filter) {
      const candidates = page.filters.map((f) => f.id);
      return {
        ok: false,
        error: {
          code: "FILTER_NOT_FOUND",
          message: `Filter "${args.filterId}" not found on page "${page.id}"`,
          candidates,
        },
      };
    }

    // Check if the filter is currently disabled for this session
    const disabledList = currentState?.disabledFilters ?? [];
    if (disabledList.includes(filter.id)) {
      const otherSameFieldFilters = page.filters
        .filter((f) => f.id !== filter.id && !disabledList.includes(f.id) && f.field === filter.field)
        .map((f) => f.id);

      return {
        ok: false,
        error: {
          code: "FILTER_UNAVAILABLE",
          message: `Filter "${filter.id}" is disabled for this session`,
          candidates: otherSameFieldFilters,
          hint: otherSameFieldFilters.length > 0 ? `Try using ${otherSameFieldFilters.join(", ")} instead` : undefined,
        },
      };
    }

    // Operator resolution and validation
    let op: Op = args.op || (Array.isArray(args.value) ? "in" : "eq");
    if (filter.type === "number" && filter.operators && filter.operators.length > 0) {
      if (!filter.operators.includes(op as any)) {
        return {
          ok: false,
          error: {
            code: "INVALID_OPERATOR",
            message: `Operator "${op}" is not allowed for filter "${filter.id}". Allowed operators: ${filter.operators.join(", ")}`,
            candidates: filter.operators,
          },
        };
      }
    }

    // Enum value normalization
    let normalizedValue = args.value;
    if (filter.type === "enum" && filter.options) {
      if (Array.isArray(args.value)) {
        const mappedList: Scalar[] = [];
        for (const item of args.value) {
          const matched = this.normalizeEnumValue(filter, item);
          if (matched === null) {
            return {
              ok: false,
              error: {
                code: "INVALID_FILTER_VALUE",
                message: `Value "${item}" is not valid for enum filter "${filter.id}"`,
                candidates: filter.options.map((o) => o.value),
              },
            };
          }
          mappedList.push(matched);
        }
        normalizedValue = mappedList;
      } else {
        const matched = this.normalizeEnumValue(filter, args.value);
        if (matched === null) {
          return {
            ok: false,
            error: {
              code: "INVALID_FILTER_VALUE",
              message: `Value "${args.value}" is not valid for enum filter "${filter.id}"`,
              candidates: filter.options.map((o) => o.value),
            },
          };
        }
        normalizedValue = matched;
      }
    }

    // Date normalization (resolves date words using normalizeDateValue against ctx.now)
    if (filter.type === "date" || filter.type === "dateRange" || typeof normalizedValue === "string") {
      const dateNorm = normalizeDateValue(op, normalizedValue, ctx.now);
      op = dateNorm.op;
      normalizedValue = dateNorm.value;
    }

    const action: UiAction = {
      type: "set_filter",
      pageId: page.id,
      filterId: filter.id,
      value: {
        op,
        value: normalizedValue,
      },
    };

    const { actionId } = await this.deps.ui.dispatch(ctx.sessionId, action);
    const ack = await this.deps.ui.awaitAck(ctx.sessionId, actionId, 3000);

    if ("timeout" in ack) {
      const fallback = await this.deps.ui.getState(ctx.sessionId);
      const applied = fallback?.filters?.[filter.id];
      if (applied && applied.op === op && JSON.stringify(applied.value) === JSON.stringify(normalizedValue)) {
        return {
          ok: true,
          data: { filterApplied: true, fallback: true },
          meta: { resultId: `filter-${filter.id}` },
        };
      }
      return {
        ok: false,
        error: {
          code: "UI_TIMEOUT",
          message: `Timed out waiting for filter update on "${filter.id}"`,
        },
      };
    }

    if (ack.rejected) {
      const otherFilters = page.filters
        .filter((f) => f.id !== filter.id && f.field === filter.field)
        .map((f) => f.id);

      return {
        ok: false,
        error: {
          code: (ack.rejected.code as ErrorCode) || "FILTER_UNAVAILABLE",
          message: ack.rejected.reason,
          candidates: otherFilters,
        },
      };
    }

    const expected: ExpectedUiState = {
      pageId: page.id,
      filters: {
        [filter.id]: { op, value: normalizedValue },
      },
    };
    const mismatches = diffUiState(expected, ack.state);
    const verified = mismatches.length === 0;

    return {
      ok: true,
      data: {
        expected,
        actual: ack.state,
        verified,
        mismatches,
      },
      meta: { resultId: crypto.randomUUID() },
    };
  }

  private async clearFilter(
    ctx: RequestContext,
    args: { filterId: string; pageId?: string },
  ): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const currentState = await this.deps.ui.getState(ctx.sessionId);

    const targetPageId = args.pageId || currentState?.pageId || app.pages[0]?.id;
    const page = app.pages.find((p) => p.id === targetPageId);
    if (!page) {
      return {
        ok: false,
        error: {
          code: "PAGE_NOT_FOUND",
          message: `Target page "${targetPageId}" not found`,
          candidates: app.pages.slice(0, 3).map((p) => p.name),
        },
      };
    }

    const filter = this.resolveFilterOnPage(page, args.filterId);
    const filterId = filter ? filter.id : args.filterId;

    const action: UiAction = {
      type: "clear_filter",
      pageId: page.id,
      filterId,
    };

    const { actionId } = await this.deps.ui.dispatch(ctx.sessionId, action);
    const ack = await this.deps.ui.awaitAck(ctx.sessionId, actionId, 3000);

    if ("timeout" in ack) {
      const fallback = await this.deps.ui.getState(ctx.sessionId);
      if (fallback && !fallback.filters?.[filterId]) {
        return {
          ok: true,
          data: { filterCleared: true, fallback: true },
          meta: { resultId: `clear-${filterId}` },
        };
      }
      return {
        ok: false,
        error: {
          code: "UI_TIMEOUT",
          message: `Timed out waiting for clear_filter on "${filterId}"`,
        },
      };
    }

    const expected: ExpectedUiState = {
      pageId: page.id,
      absentFilters: [filterId],
    };
    const mismatches = diffUiState(expected, ack.state);
    const verified = mismatches.length === 0;

    return {
      ok: true,
      data: {
        expected,
        actual: ack.state,
        verified,
        mismatches,
      },
      meta: { resultId: crypto.randomUUID() },
    };
  }

  private async setDateRange(
    ctx: RequestContext,
    args: { filterId?: string; token?: DateToken; start?: string; end?: string },
  ): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const currentState = await this.deps.ui.getState(ctx.sessionId);

    const targetPageId = currentState?.pageId || app.pages[0]?.id;
    const page = app.pages.find((p) => p.id === targetPageId);
    if (!page) {
      return {
        ok: false,
        error: {
          code: "PAGE_NOT_FOUND",
          message: `Current page not found`,
        },
      };
    }

    // Resolve date filter: either explicitly specified or the page's single date/dateRange filter
    let dateFilter = args.filterId ? this.resolveFilterOnPage(page, args.filterId) : undefined;
    if (!dateFilter) {
      dateFilter = page.filters.find((f) => f.type === "dateRange" || f.type === "date");
    }

    if (!dateFilter) {
      return {
        ok: false,
        error: {
          code: "FILTER_NOT_FOUND",
          message: `No date or dateRange filter found on page "${page.id}"`,
          candidates: page.filters.map((f) => f.id),
        },
      };
    }

    // Resolve dates from token or explicit start/end
    let start = args.start;
    let end = args.end;

    if (args.token) {
      const resolved = resolveDateToken(args.token, ctx.now);
      start = resolved.start;
      end = resolved.end;
    }

    if (!start || !end) {
      return {
        ok: false,
        error: {
          code: "INVALID_FILTER_VALUE",
          message: "A date token or both start and end ISO dates must be provided",
          hint: "Example: token: 'last_month' or start: '2026-09-01', end: '2026-09-30'",
        },
      };
    }

    const action: UiAction = {
      type: "set_date_range",
      pageId: page.id,
      filterId: dateFilter.id,
      start,
      end,
    };

    const { actionId } = await this.deps.ui.dispatch(ctx.sessionId, action);
    const ack = await this.deps.ui.awaitAck(ctx.sessionId, actionId, 3000);

    if ("timeout" in ack) {
      const fallback = await this.deps.ui.getState(ctx.sessionId);
      const applied = fallback?.filters?.[dateFilter.id];
      if (applied && applied.op === "between" && JSON.stringify(applied.value) === JSON.stringify([start, end])) {
        return {
          ok: true,
          data: { dateRangeSet: true, fallback: true },
          meta: { resultId: `date-${dateFilter.id}` },
        };
      }
      return {
        ok: false,
        error: {
          code: "UI_TIMEOUT",
          message: `Timed out setting date range on "${dateFilter.id}"`,
        },
      };
    }

    if (ack.rejected) {
      return {
        ok: false,
        error: {
          code: (ack.rejected.code as ErrorCode) || "FILTER_UNAVAILABLE",
          message: ack.rejected.reason,
        },
      };
    }

    const expected: ExpectedUiState = {
      pageId: page.id,
      filters: {
        [dateFilter.id]: { op: "between", value: [start, end] },
      },
    };
    const mismatches = diffUiState(expected, ack.state);
    const verified = mismatches.length === 0;

    return {
      ok: true,
      data: {
        expected,
        actual: ack.state,
        verified,
        mismatches,
      },
      meta: { resultId: crypto.randomUUID() },
    };
  }

  private async sort(
    ctx: RequestContext,
    args: { widgetId?: string; field: string; direction: "asc" | "desc" },
  ): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const currentState = await this.deps.ui.getState(ctx.sessionId);

    const targetPageId = currentState?.pageId || app.pages[0]?.id;
    const page = app.pages.find((p) => p.id === targetPageId);
    if (!page) {
      return {
        ok: false,
        error: { code: "PAGE_NOT_FOUND", message: `Current page not found` },
      };
    }

    // Resolve widget: either specified widgetId or the first table widget on page
    const widget = args.widgetId
      ? page.widgets.find((w) => w.id === args.widgetId)
      : page.widgets.find((w) => w.type === "table") || page.widgets[0];

    if (!widget) {
      return {
        ok: false,
        error: {
          code: "WIDGET_NOT_FOUND",
          message: `No sortable table widget found on page "${page.id}"`,
        },
      };
    }

    // Validate that field is in widget.sortable
    if (widget.sortable && widget.sortable.length > 0) {
      if (!widget.sortable.includes(args.field)) {
        return {
          ok: false,
          error: {
            code: "FIELD_NOT_ALLOWED",
            message: `Field "${args.field}" is not sortable on widget "${widget.id}". Sortable fields: ${widget.sortable.join(", ")}`,
            candidates: widget.sortable,
          },
        };
      }
    }

    const action: UiAction = {
      type: "sort",
      pageId: page.id,
      widgetId: widget.id,
      field: args.field,
      direction: args.direction,
    };

    const { actionId } = await this.deps.ui.dispatch(ctx.sessionId, action);
    const ack = await this.deps.ui.awaitAck(ctx.sessionId, actionId, 3000);

    if ("timeout" in ack) {
      const fallback = await this.deps.ui.getState(ctx.sessionId);
      if (fallback?.sort && fallback.sort.field === args.field && fallback.sort.direction === args.direction) {
        return {
          ok: true,
          data: { sorted: true, fallback: true },
          meta: { resultId: `sort-${widget.id}` },
        };
      }
      return {
        ok: false,
        error: { code: "UI_TIMEOUT", message: `Timed out waiting for sort on "${widget.id}"` },
      };
    }

    const expected: ExpectedUiState = {
      pageId: page.id,
      sort: {
        widgetId: widget.id,
        field: args.field,
        direction: args.direction,
      },
    };
    const mismatches = diffUiState(expected, ack.state);
    const verified = mismatches.length === 0;

    return {
      ok: true,
      data: {
        expected,
        actual: ack.state,
        verified,
        mismatches,
      },
      meta: { resultId: crypto.randomUUID() },
    };
  }

  // --- DATA, ANALYTICS & APP ACTION TOOLS ---

  private async getWidgetData(
    ctx: RequestContext,
    args: { widgetId: string; limit?: number },
  ): Promise<ToolResult> {
    if (!this.deps.data) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "DataService is not configured" },
      };
    }

    const currentState = await this.deps.ui.getState(ctx.sessionId);
    const app = await this.deps.metadata.getApp(ctx);
    const pageId = currentState?.pageId || app.pages[0]?.id;

    // Resolve the widget across the whole app BEFORE delegating to the data layer.
    // DataService.widgetData is page-scoped and would otherwise throw a bare
    // "Unknown page or widget" that the planner cannot recover from.
    const owner = getWidget(app, args.widgetId);
    if (!owner) {
      const onPage = (app.pages.find((p) => p.id === pageId)?.widgets ?? []).map((w) => w.id);
      return {
        ok: false,
        error: {
          code: "WIDGET_NOT_FOUND",
          message: `Widget "${args.widgetId}" not found in application "${app.name}"`,
          candidates: onPage,
        },
      };
    }
    if (owner.page.id !== pageId) {
      return {
        ok: false,
        error: {
          code: "WIDGET_NOT_FOUND",
          message: `Widget "${args.widgetId}" is on page "${owner.page.id}" but the current page is "${pageId}"`,
          candidates: [owner.page.id],
          hint: `Navigate to "${owner.page.id}" first, or use query_business_data with dataset "${owner.widget.dataset}" for page-independent evidence.`,
        },
      };
    }

    const result = await this.deps.data.widgetData(
      ctx,
      pageId,
      args.widgetId,
      currentState ?? {
        appId: ctx.appId,
        pageId,
        route: `/${pageId}`,
        filters: {},
        sort: null,
        selection: null,
        disabledFilters: [],
        version: 0,
      },
      { limit: args.limit },
    );

    return {
      ok: true,
      data: result,
      meta: { queryId: crypto.randomUUID() },
    };
  }

  private async queryBusinessData(
    ctx: RequestContext,
    args: { spec: any },
  ): Promise<ToolResult> {
    if (!this.deps.data) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "DataService is not configured" },
      };
    }

    const result = await this.deps.data.query(ctx, args.spec);
    return {
      ok: true,
      data: result,
      meta: { queryId: crypto.randomUUID() },
    };
  }

  private async runAnalysis(
    ctx: RequestContext,
    args: { spec: any },
  ): Promise<ToolResult> {
    if (!this.deps.analytics) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "AnalyticsService is not configured" },
      };
    }

    const result = await this.deps.analytics.run(ctx, args.spec);
    return {
      ok: true,
      data: result,
      meta: { queryId: crypto.randomUUID() },
    };
  }

  private async invokeAppAction(
    ctx: RequestContext,
    args: { actionId: string; params: Record<string, Scalar> },
  ): Promise<ToolResult> {
    const app = await this.deps.metadata.getApp(ctx);
    const action = app.actions?.find((a) => a.id === args.actionId);

    if (!action) {
      return {
        ok: false,
        error: {
          code: "AMBIGUOUS",
          message: `App action "${args.actionId}" not found in metadata`,
          candidates: app.actions?.map((a) => a.id) ?? [],
        },
      };
    }

    // Role check from metadata
    if (action.requiredRole && ctx.role !== action.requiredRole && ctx.role !== "admin") {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: `Role "${ctx.role}" is not authorized to invoke action "${action.id}". Required: "${action.requiredRole}"`,
        },
      };
    }

    // Policy gate: NEVER execute without confirmation if action is destructive
    const isConfirmed = (ctx as any).confirmed === true || (args.params as any)._confirmed === true;
    if (action.destructive && !isConfirmed) {
      return {
        ok: false,
        error: {
          code: "NEEDS_CONFIRMATION",
          message: `Action "${action.label || action.id}" is destructive and requires user confirmation before execution`,
        },
      };
    }

    return {
      ok: true,
      data: {
        actionId: action.id,
        executed: true,
        params: args.params,
        timestamp: ctx.now,
      },
      meta: { resultId: crypto.randomUUID() },
    };
  }

  // --- TARGET & FILTER RESOLUTION HELPERS ---

  private async resolveTargetPage(
    ctx: RequestContext,
    app: AppMetadata,
    target: string,
  ): Promise<Page | undefined> {
    const trimmed = target.trim();
    const lower = trimmed.toLowerCase();

    // 1. Exact pageId match
    let page = app.pages.find((p) => p.id === trimmed);
    if (page) return page;

    // 2. Case-insensitive pageId match
    page = app.pages.find((p) => p.id.toLowerCase() === lower);
    if (page) return page;

    // 3. Exact route match
    page = app.pages.find((p) => p.route === trimmed);
    if (page) return page;

    // 4. Case-insensitive route match
    page = app.pages.find((p) => p.route.toLowerCase() === lower);
    if (page) return page;

    // 5. Exact page name match
    page = app.pages.find((p) => p.name === trimmed);
    if (page) return page;

    // 6. Case-insensitive page name match
    page = app.pages.find((p) => p.name.toLowerCase() === lower);
    if (page) return page;

    // 7. Substring in page name or description
    page = app.pages.find(
      (p) => p.name.toLowerCase().includes(lower) || p.description?.toLowerCase().includes(lower),
    );
    if (page) return page;

    // 8. Try metadata search fallback
    try {
      const searchHits = await this.deps.metadata.search(ctx, trimmed, { kinds: ["page"] });
      if (searchHits.length > 0) {
        const topHit = searchHits[0];
        const pageId = topHit.pageId || (topHit.kind === "page" ? topHit.id : undefined);
        page = app.pages.find((p) => p.id === pageId);
        if (page) return page;
      }
    } catch {
      // Ignore metadata search failures during resolution
    }

    return undefined;
  }

  private resolveFilterOnPage(page: Page, targetFilter: string) {
    const lower = targetFilter.toLowerCase().trim();

    // Exact ID
    let filter = page.filters.find((f) => f.id === targetFilter);
    if (filter) return filter;

    // Case-insensitive ID
    filter = page.filters.find((f) => f.id.toLowerCase() === lower);
    if (filter) return filter;

    // Label or synonyms
    filter = page.filters.find(
      (f) =>
        f.label.toLowerCase() === lower ||
        f.synonyms?.some((s) => s.toLowerCase() === lower),
    );
    return filter;
  }

  private normalizeEnumValue(filter: any, raw: Scalar): string | null {
    const s = String(raw).toLowerCase().trim();
    for (const opt of filter.options ?? []) {
      if (opt.value.toLowerCase() === s) return opt.value;
      if (opt.label.toLowerCase() === s) return opt.value;
      if (opt.synonyms?.some((syn: string) => syn.toLowerCase() === s)) return opt.value;
    }
    return null;
  }
}

/**
 * Factory function exporting createToolRegistry.
 */
export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  return new DefaultToolRegistry(deps);
}
