import {
  UiAdapter,
  UiState,
  UiAction,
  AppMetadata,
  MetadataStore,
  Page,
  emptyUiState,
} from "@cab/contracts";

export interface SimulatedUiAdapterOptions {
  metadata?: AppMetadata;
  metadataStore?: MetadataStore;
  defaultAppId?: string;
  initialState?: UiState;
}

interface SimulatedSession {
  sessionId: string;
  state: UiState | null;
  disabledFilters: Set<string>;
  pendingAcks: Map<string, { state: UiState; rejected?: { code: string; reason: string } }>;
  history: { actionId: string; action: UiAction; state: UiState; rejected?: { code: string; reason: string } }[];
}

export class SimulatedUiAdapter implements UiAdapter {
  private sessions = new Map<string, SimulatedSession>();
  private metadata?: AppMetadata;
  private defaultAppId: string;

  constructor(private options: SimulatedUiAdapterOptions = {}) {
    this.metadata = options.metadata;
    this.defaultAppId = options.defaultAppId ?? options.metadata?.appId ?? "hospital";
  }

  /**
   * Resets all in-memory simulated sessions (useful for tests).
   */
  reset(): void {
    this.sessions.clear();
  }

  /**
   * Updates or sets cached AppMetadata.
   */
  setMetadata(metadata: AppMetadata): void {
    this.metadata = metadata;
    if (!this.options.defaultAppId && metadata.appId) {
      this.defaultAppId = metadata.appId;
    }
  }

  /**
   * Manually seeds or overrides the UI state for a session.
   */
  setState(sessionId: string, state: UiState): void {
    const session = this.getOrCreateSession(sessionId);
    const combinedDisabled = Array.from(
      new Set([...state.disabledFilters, ...Array.from(session.disabledFilters)]),
    );
    session.state = {
      ...state,
      disabledFilters: combinedDisabled,
    };
  }

  /**
   * Sets disabled filters for failure injection demonstrations and test scenarios.
   */
  setDisabledFilters(sessionId: string, disabledFilters: string[]): void {
    const session = this.getOrCreateSession(sessionId);
    session.disabledFilters = new Set(disabledFilters);
    if (session.state) {
      session.state = {
        ...session.state,
        disabledFilters: [...disabledFilters],
      };
    }
  }

  /**
   * Gets currently disabled filters for a session.
   */
  getDisabledFilters(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? Array.from(session.disabledFilters) : [];
  }

  /**
   * UiAdapter contract: retrieves current UI state for a session.
   */
  async getState(sessionId: string): Promise<UiState | null> {
    const session = this.sessions.get(sessionId);
    return session?.state ?? null;
  }

  /**
   * UiAdapter contract: dispatches action, simulates UI state transition,
   * generates and returns actionId immediately.
   */
  async dispatch(sessionId: string, action: UiAction): Promise<{ actionId: string }> {
    const session = this.getOrCreateSession(sessionId);
    const actionId = crypto.randomUUID();

    const result = this.applyAction(session, action);
    session.pendingAcks.set(actionId, result);
    session.history.push({
      actionId,
      action,
      state: result.state,
      rejected: result.rejected,
    });

    return { actionId };
  }

  /**
   * UiAdapter contract: awaits acknowledgment for actionId.
   * In SimulatedUiAdapter, this returns the precomputed transition or { timeout: true }.
   */
  async awaitAck(
    sessionId: string,
    actionId: string,
    _timeoutMs: number = 3000,
  ): Promise<{ state: UiState; rejected?: { code: string; reason: string } } | { timeout: true }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { timeout: true };
    }

    const ack = session.pendingAcks.get(actionId);
    if (!ack) {
      return { timeout: true };
    }

    return {
      state: ack.state,
      ...(ack.rejected ? { rejected: ack.rejected } : {}),
    };
  }

  private getOrCreateSession(sessionId: string): SimulatedSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      let initial: UiState | null = null;
      if (this.options.initialState) {
        initial = { ...this.options.initialState };
      }

      session = {
        sessionId,
        state: initial,
        disabledFilters: new Set<string>(),
        pendingAcks: new Map(),
        history: [],
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private resolvePage(pageId: string): Page | undefined {
    return this.metadata?.pages.find((p) => p.id === pageId);
  }

  private initDefaultState(session: SimulatedSession, pageId: string): UiState {
    const page = this.resolvePage(pageId);
    const route = page?.route ?? `/${pageId}`;
    const state = emptyUiState(this.defaultAppId, pageId, route);
    state.disabledFilters = Array.from(session.disabledFilters);
    state.version = 1;
    session.state = state;
    return state;
  }

  private applyAction(
    session: SimulatedSession,
    action: UiAction,
  ): { state: UiState; rejected?: { code: string; reason: string } } {
    switch (action.type) {
      case "navigate": {
        const page = this.resolvePage(action.pageId);
        const targetRoute = action.route || page?.route || `/${action.pageId}`;
        const targetPageId = action.pageId;

        const isSamePage = session.state !== null && session.state.pageId === targetPageId;
        const currentVersion = session.state?.version ?? 0;

        // "navigate resets filters unless the page is unchanged"
        const nextFilters = isSamePage && session.state ? { ...session.state.filters } : {};
        const nextSort = isSamePage && session.state ? session.state.sort : null;

        session.state = {
          appId: this.defaultAppId,
          pageId: targetPageId,
          route: targetRoute,
          filters: nextFilters,
          sort: nextSort,
          selection: null,
          disabledFilters: Array.from(session.disabledFilters),
          version: currentVersion + 1,
        };

        return { state: session.state };
      }

      case "set_filter": {
        // Honor disabled filters: reject with FILTER_UNAVAILABLE without altering state
        if (session.disabledFilters.has(action.filterId)) {
          const currentState = session.state ?? this.initDefaultState(session, action.pageId);
          return {
            state: currentState,
            rejected: {
              code: "FILTER_UNAVAILABLE",
              reason: `Filter "${action.filterId}" is disabled for this session`,
            },
          };
        }

        const current = session.state ?? this.initDefaultState(session, action.pageId);
        session.state = {
          ...current,
          filters: {
            ...current.filters,
            [action.filterId]: action.value,
          },
          disabledFilters: Array.from(session.disabledFilters),
          version: current.version + 1,
        };

        return { state: session.state };
      }

      case "clear_filter": {
        const current = session.state ?? this.initDefaultState(session, action.pageId);
        const nextFilters = { ...current.filters };
        delete nextFilters[action.filterId];

        session.state = {
          ...current,
          filters: nextFilters,
          disabledFilters: Array.from(session.disabledFilters),
          version: current.version + 1,
        };

        return { state: session.state };
      }

      case "clear_all_filters": {
        const current = session.state ?? this.initDefaultState(session, action.pageId);
        session.state = {
          ...current,
          filters: {},
          disabledFilters: Array.from(session.disabledFilters),
          version: current.version + 1,
        };

        return { state: session.state };
      }

      case "set_date_range": {
        if (session.disabledFilters.has(action.filterId)) {
          const currentState = session.state ?? this.initDefaultState(session, action.pageId);
          return {
            state: currentState,
            rejected: {
              code: "FILTER_UNAVAILABLE",
              reason: `Filter "${action.filterId}" is disabled for this session`,
            },
          };
        }

        const current = session.state ?? this.initDefaultState(session, action.pageId);
        session.state = {
          ...current,
          filters: {
            ...current.filters,
            [action.filterId]: {
              op: "between",
              value: [action.start, action.end],
            },
          },
          disabledFilters: Array.from(session.disabledFilters),
          version: current.version + 1,
        };

        return { state: session.state };
      }

      case "sort": {
        const current = session.state ?? this.initDefaultState(session, action.pageId);
        session.state = {
          ...current,
          sort: {
            widgetId: action.widgetId,
            field: action.field,
            direction: action.direction,
          },
          disabledFilters: Array.from(session.disabledFilters),
          version: current.version + 1,
        };

        return { state: session.state };
      }

      case "open_details": {
        const current = session.state ?? this.initDefaultState(session, action.pageId);
        session.state = {
          ...current,
          selection: {
            widgetId: action.widgetId,
            rowKey: action.rowKey,
          },
          disabledFilters: Array.from(session.disabledFilters),
          version: current.version + 1,
        };

        return { state: session.state };
      }

      default: {
        const current = session.state ?? this.initDefaultState(session, "home");
        return { state: current };
      }
    }
  }
}
