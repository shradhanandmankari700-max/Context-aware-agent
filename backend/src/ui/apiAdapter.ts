import { UiAdapter, UiState, UiAction } from "@cab/contracts";
import { UiStateHub, uiHub, AckResult } from "./hub";

/**
 * ApiUiAdapter implements the UiAdapter interface by delegating to the UI State Hub.
 * It publishes actions to connected frontend clients via SSE and awaits their reports.
 */
export class ApiUiAdapter implements UiAdapter {
  constructor(private hub: UiStateHub = uiHub) {}

  /**
   * Retrieves the latest known UI state for a session.
   */
  async getState(sessionId: string): Promise<UiState | null> {
    return this.hub.getState(sessionId);
  }

  /**
   * Dispatches a UI action via SSE and returns the unique actionId immediately.
   */
  async dispatch(sessionId: string, action: UiAction): Promise<{ actionId: string }> {
    return this.hub.dispatch(sessionId, action);
  }

  /**
   * Waits for a UI state report carrying actionId to acknowledge the action.
   */
  async awaitAck(
    sessionId: string,
    actionId: string,
    timeoutMs: number = 3000,
  ): Promise<AckResult> {
    return this.hub.awaitAck(sessionId, actionId, timeoutMs);
  }
}
