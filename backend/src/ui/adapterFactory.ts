import { UiAdapter } from "@cab/contracts";
import { ApiUiAdapter } from "./apiAdapter";
import { SimulatedUiAdapter, SimulatedUiAdapterOptions } from "./simulatedAdapter";
import { UiStateHub } from "./hub";
import { PlaywrightUiAdapter, PlaywrightUiAdapterOptions } from "./playwrightAdapter";

export type UiAdapterKind = "api" | "simulated" | "playwright";

export interface CreateUiAdapterOptions extends SimulatedUiAdapterOptions { hub?: UiStateHub }

export function createUiAdapter(kind: "api", options?: { hub?: UiStateHub }): ApiUiAdapter;
export function createUiAdapter(kind: "simulated", options?: SimulatedUiAdapterOptions): SimulatedUiAdapter;
export function createUiAdapter(kind: "playwright", options: PlaywrightUiAdapterOptions): PlaywrightUiAdapter;
export function createUiAdapter(kind: UiAdapterKind, options?: unknown): UiAdapter {
  const opts = options as CreateUiAdapterOptions | undefined;
  switch (kind) {
    case "api":
      return new ApiUiAdapter(opts?.hub);
    case "simulated":
      return new SimulatedUiAdapter(opts);
    case "playwright":
      return new PlaywrightUiAdapter(options as PlaywrightUiAdapterOptions);
    default:
      throw new Error(`Unknown UiAdapter kind: ${kind}`);
  }
}
