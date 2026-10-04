import type { AgentResponse, AppMetadata, KpiReport, QueryResult, UiAction, UiState } from "@cab/contracts";
import hospital from "../../metadata/hospital.json";
import { AppMetadata as AppMetadataSchema } from "@cab/contracts";

export const API_BASE = (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const staticMetadata = AppMetadataSchema.parse(hospital) as AppMetadata;
export const tokenKey = "cab.jwt";
let memoryToken = localStorage.getItem(tokenKey);
export function setAuthToken(value: string | null) { memoryToken = value; if (value) localStorage.setItem(tokenKey, value); else localStorage.removeItem(tokenKey); }
const token = () => memoryToken;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (token()) headers.set("Authorization", `Bearer ${token()}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function loadMetadata(appId: string): Promise<AppMetadata> {
  try { return await api<AppMetadata>(`/api/apps/${encodeURIComponent(appId)}/metadata`); }
  catch { if (appId === staticMetadata.appId) return staticMetadata; throw new Error("This app's metadata is unavailable. Connect the API or select the bundled demo app."); }
}

export async function loadWidget(appId: string, pageId: string, widgetId: string, uiState: UiState): Promise<QueryResult> {
  return api<QueryResult>("/api/data/widget", { method: "POST", body: JSON.stringify({ appId, pageId, widgetId, uiState }) });
}

export type AgentMessage = { id: string; role: "user" | "assistant"; text?: string; response?: AgentResponse; pending?: boolean };
export type ActionEnvelope = { actionId: string; action: UiAction; baseVersion: number };
export type AgentEvent = { type: "agent_status"; traceId: string; stage: string; detail?: string } | { type: "agent_step"; traceId: string; step: unknown };
export type Report = { sessionId: string; state: UiState; actionId?: string; rejected?: { code: "FILTER_UNAVAILABLE" | "PAGE_NOT_FOUND" | "INVALID_VALUE" | "OTHER"; reason: string } };
export type AppsList = { appId: string; name: string; description: string }[];
export type EvalResult = KpiReport;
