import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { fromDeepLink, toDeepLink, type FilterValue, type UiAction, type UiState } from "@cab/contracts";
import type { AppMetadata } from "@cab/contracts";
import { api, type Report } from "../api";

function readUser(): string { return localStorage.getItem("cab.user") || "demo"; }
export function getSessionId(appId: string): string {
  const key = `cab.session.${appId}.${readUser()}`;
  let session = localStorage.getItem(key);
  if (!session) { session = crypto.randomUUID(); localStorage.setItem(key, session); }
  return session;
}

export function useUiState(metadata: AppMetadata, disabledFilters: string[] = []) {
  const location = useLocation();
  const navigate = useNavigate();
  const versionRef = useRef(0);
  const sessionId = useMemo(() => getSessionId(metadata.appId), [metadata.appId]);
  const decoded = fromDeepLink(`${location.pathname}${location.search}`);
  const page = metadata.pages.find((item) => item.route === decoded.route) ?? metadata.pages[0];
  const state: UiState = { appId: metadata.appId, pageId: page.id, route: page.route, filters: decoded.filters, sort: decoded.sort, selection: null, disabledFilters, version: versionRef.current };

  useEffect(() => { void api("/api/ui-state/report", { method: "POST", body: JSON.stringify({ sessionId, state } satisfies Report) }).catch(() => undefined); }, [sessionId, location.pathname, location.search, state.pageId, disabledFilters.join("|")]);

  const change = useCallback((nextRoute: string, filters: Record<string, FilterValue>, sort: UiState["sort"], replace = false) => {
    versionRef.current += 1;
    navigate(toDeepLink(nextRoute, { filters, sort }), { replace });
  }, [navigate]);
  const applyAction = useCallback((action: UiAction, actionId?: string) => {
    let nextRoute = state.route;
    let filters = { ...state.filters };
    let sort = state.sort;
    let rejected: Report["rejected"];
    const pageForAction = metadata.pages.find((item) => item.id === action.pageId);
    if (action.type === "navigate") { nextRoute = action.route; if (action.pageId !== state.pageId) { filters = {}; sort = null; } }
    else if (!pageForAction) rejected = { code: "PAGE_NOT_FOUND", reason: "The target page is unavailable." };
    else if (["set_filter", "clear_filter", "set_date_range"].includes(action.type)) {
      const filterId = action.type === "set_filter" || action.type === "clear_filter" || action.type === "set_date_range" ? action.filterId : "";
      if (disabledFilters.includes(filterId)) rejected = { code: "FILTER_UNAVAILABLE", reason: `Filter ${filterId} is disabled.` };
      else if (action.type === "set_filter") filters[filterId] = action.value;
      else if (action.type === "clear_filter") delete filters[filterId];
      else if (action.type === "set_date_range") filters[filterId] = { op: "between", value: [action.start, action.end] };
    } else if (action.type === "clear_all_filters") filters = {};
    else if (action.type === "sort") sort = { widgetId: action.widgetId, field: action.field, direction: action.direction };
    else if (action.type === "open_details") filters = { ...filters };
    if (!rejected) {
      if (action.type === "navigate") navigate(toDeepLink(nextRoute, { filters, sort }));
      else change(nextRoute, filters, sort);
    }
    const updatedPage = metadata.pages.find((item) => item.route === nextRoute) ?? page;
    const updated: UiState = { appId: metadata.appId, pageId: updatedPage.id, route: nextRoute, filters, sort, selection: null, disabledFilters, version: versionRef.current };
    void api("/api/ui-state/report", { method: "POST", body: JSON.stringify({ sessionId, state: updated, actionId, rejected } satisfies Report) }).catch(() => undefined);
  }, [state, metadata, disabledFilters, page, navigate, change, sessionId]);

  return { state, sessionId, change, applyAction, undo: () => navigate(-1) };
}
