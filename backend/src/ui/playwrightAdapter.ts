import {
  AppMetadata,
  UiAction,
  UiAdapter,
  UiState,
  fromDeepLink,
  toDeepLink,
} from "@cab/contracts";

/** The small Playwright surface used here keeps Playwright optional for API/CI deployments. */
export interface PlaywrightLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  selectOption(value: string, options?: { timeout?: number }): Promise<unknown>;
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
}

export interface PlaywrightPage {
  url(): string;
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle" }): Promise<unknown>;
  locator(selector: string): PlaywrightLocator;
  getByTestId(testId: string): PlaywrightLocator;
  waitForURL(url: string | RegExp | ((url: URL) => boolean), options?: { timeout?: number }): Promise<void>;
}

export interface PlaywrightUiAdapterOptions {
  page: PlaywrightPage;
  metadata: AppMetadata;
  timeoutMs?: number;
  /** Optional source for fault-demo state exposed by the real UI. */
  getDisabledFilters?: () => string[];
}

type Ack = { state: UiState; rejected?: { code: string; reason: string } } | { timeout: true };

/** Fallback adapter that drives one real browser page and reconstructs state from its URL. */
export class PlaywrightUiAdapter implements UiAdapter {
  private readonly pending = new Map<string, Promise<Exclude<Ack, { timeout: true }>>>();
  private readonly states = new Map<string, UiState>();
  private readonly timeoutMs: number;

  constructor(private readonly options: PlaywrightUiAdapterOptions) {
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  async getState(sessionId: string): Promise<UiState | null> {
    const state = this.readState(sessionId);
    if (!state) return this.states.get(sessionId) ?? null;
    this.states.set(sessionId, state);
    return state;
  }

  async dispatch(sessionId: string, action: UiAction): Promise<{ actionId: string }> {
    const actionId = crypto.randomUUID();
    const task = this.perform(sessionId, action).then((result) => {
      this.states.set(sessionId, result.state);
      return result;
    });
    this.pending.set(actionId, task);
    void task.finally(() => this.pending.delete(actionId)).catch(() => undefined);
    return { actionId };
  }

  async awaitAck(sessionId: string, actionId: string, timeoutMs = this.timeoutMs): Promise<Ack> {
    const task = this.pending.get(actionId);
    if (!task) return { timeout: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<{ timeout: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
        }),
      ]);
    } catch (error) {
      return {
        state: this.states.get(sessionId) ?? this.emptyState(),
        rejected: { code: "INTERNAL", reason: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async perform(sessionId: string, action: UiAction): Promise<Exclude<Ack, { timeout: true }>> {
    const current = this.readState(sessionId);
    if ((action.type === "set_filter" || action.type === "set_date_range") &&
        (this.options.getDisabledFilters?.() ?? current?.disabledFilters ?? []).includes(action.filterId)) {
      return {
        state: current ?? this.emptyState(),
        rejected: { code: "FILTER_UNAVAILABLE", reason: `Filter "${action.filterId}" is disabled for this session` },
      };
    }

    switch (action.type) {
      case "navigate": {
        const nav = this.options.page.getByTestId(`nav-${action.pageId}`);
        if (await nav.count()) await nav.click({ timeout: this.timeoutMs });
        else await this.options.page.goto(action.route, { waitUntil: "domcontentloaded" });
        break;
      }
      case "set_filter": {
        const control = this.options.page.getByTestId(`filter-${action.filterId}`);
        const value = action.value.value;
        const filter = this.options.metadata.pages.find((p) => p.id === action.pageId)?.filters.find((f) => f.id === action.filterId);
        if (filter?.type === "enum") {
          for (const item of Array.isArray(value) ? value : [value]) {
            const option = this.options.page.getByTestId(`filter-${action.filterId}-option-${String(item)}`);
            if (await option.count()) await option.click({ timeout: this.timeoutMs });
            else await control.selectOption(String(item), { timeout: this.timeoutMs });
          }
        } else {
          await control.fill(Array.isArray(value) ? value.join(",") : String(value), { timeout: this.timeoutMs });
        }
        break;
      }
      case "clear_filter": {
        const control = this.options.page.getByTestId(`filter-${action.filterId}`);
        const filter = this.options.metadata.pages.find((p) => p.id === action.pageId)?.filters.find((f) => f.id === action.filterId);
        if (filter?.type === "enum") await control.selectOption("", { timeout: this.timeoutMs });
        else await control.fill("", { timeout: this.timeoutMs });
        break;
      }
      case "clear_all_filters": {
        for (const filter of this.options.metadata.pages.find((p) => p.id === action.pageId)?.filters ?? []) {
          const control = this.options.page.getByTestId(`filter-${filter.id}`);
          if (filter.type === "enum") await control.selectOption("", { timeout: this.timeoutMs });
          else await control.fill("", { timeout: this.timeoutMs });
        }
        break;
      }
      case "set_date_range": {
        const control = this.options.page.getByTestId(`filter-${action.filterId}`);
        await control.fill(`${action.start},${action.end}`, { timeout: this.timeoutMs });
        break;
      }
      case "sort":
        await this.options.page.getByTestId(`sort-${action.widgetId}-${action.field}`).click({ timeout: this.timeoutMs });
        break;
      case "open_details":
        await this.options.page.getByTestId(`row-${action.widgetId}-${action.rowKey}`).click({ timeout: this.timeoutMs });
        break;
    }

    const next = await this.waitForState(sessionId, action, current);
    return { state: next };
  }

  private async waitForState(sessionId: string, action: UiAction, before: UiState | null): Promise<UiState> {
    const targetPageId = action.pageId;
    const targetPage = this.options.metadata.pages.find((candidate) => candidate.id === targetPageId);
    const route = action.type === "navigate" ? action.route : targetPage?.route;
    if (!route) throw new Error(`Page "${targetPageId}" is not present in metadata`);
    const samePage = before?.pageId === targetPageId;
    const filters = samePage ? { ...before.filters } : {};
    let sort = samePage ? before.sort : null;
    if (action.type === "set_filter") filters[action.filterId] = action.value;
    if (action.type === "set_date_range") filters[action.filterId] = { op: "between", value: [action.start, action.end] };
    if (action.type === "clear_filter") delete filters[action.filterId];
    if (action.type === "clear_all_filters") Object.keys(filters).forEach((id) => delete filters[id]);
    if (action.type === "sort") sort = { widgetId: action.widgetId, field: action.field, direction: action.direction };
    const expectedUrl = toDeepLink(route, { filters, sort });
    await this.options.page.waitForURL(
      (url) => `${url.pathname}${url.search}` === expectedUrl,
      { timeout: this.timeoutMs },
    );
    const state = this.readState(sessionId);
    if (!state) throw new Error("Could not map the browser URL to an app page");
    return { ...state, version: Math.max(state.version, (before?.version ?? 0) + 1) };
  }

  private readState(sessionId?: string): UiState | null {
    const url = new URL(this.options.page.url(), "http://localhost");
    const parsed = fromDeepLink(`${url.pathname}${url.search}`);
    const page = this.options.metadata.pages.find((candidate) => candidate.route === parsed.route);
    if (!page) return null;
    return {
      appId: this.options.metadata.appId,
      pageId: page.id,
      route: page.route,
      filters: parsed.filters,
      sort: parsed.sort,
      selection: null,
      disabledFilters: this.options.getDisabledFilters?.() ?? (sessionId ? this.states.get(sessionId)?.disabledFilters : undefined) ?? [],
      version: sessionId ? this.states.get(sessionId)?.version ?? 0 : 0,
    };
  }

  private emptyState(): UiState {
    const page = this.options.metadata.pages[0];
    return { appId: this.options.metadata.appId, pageId: page.id, route: page.route, filters: {}, sort: null, selection: null, disabledFilters: [], version: 0 };
  }
}
