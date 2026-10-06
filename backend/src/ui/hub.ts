import type { Response } from "express";
import { UiState, UiAction, SseEvent, UiStateReport } from "@cab/contracts";

export type AckResult =
  | { state: UiState; rejected?: { code: string; reason: string } }
  | { timeout: true };

interface PendingAck {
  resolve: (result: AckResult) => void;
  promise: Promise<AckResult>;
  timer?: NodeJS.Timeout;
  baseVersion: number;
  waiterAttached: boolean;
}

interface CompletedAck {
  state: UiState;
  rejected?: { code: string; reason: string };
  timestamp: number;
}

interface SessionData {
  sessionId: string;
  state: UiState | null;
  disabledFilters: string[];
  connections: Set<Response>;
  pendingAcks: Map<string, PendingAck>;
  recentAcks: Map<string, CompletedAck>;
}

export class UiStateHub {
  private sessions = new Map<string, SessionData>();

  private getOrCreateSession(sessionId: string): SessionData {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        state: null,
        disabledFilters: [],
        connections: new Set<Response>(),
        pendingAcks: new Map<string, PendingAck>(),
        recentAcks: new Map<string, CompletedAck>(),
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Retrieves the latest known UI state for a session.
   */
  getState(sessionId: string): UiState | null {
    const session = this.sessions.get(sessionId);
    return session?.state ?? null;
  }

  /**
   * Directly sets or updates UI state for a session (used by simulated adapter or testing).
   */
  setState(sessionId: string, state: UiState): void {
    const session = this.getOrCreateSession(sessionId);
    const combinedDisabled = Array.from(new Set([...state.disabledFilters, ...session.disabledFilters]));
    session.state = {
      ...state,
      disabledFilters: combinedDisabled,
    };
  }

  /**
   * Dispatches a UI action: generates actionId, publishes ui_action SSE event, returns actionId.
   */
  dispatch(sessionId: string, action: UiAction): { actionId: string } {
    const session = this.getOrCreateSession(sessionId);
    const actionId = crypto.randomUUID();
    const baseVersion = session.state?.version ?? 0;
    let resolveAck!: (result: AckResult) => void;
    const promise = new Promise<AckResult>((resolve) => {
      resolveAck = resolve;
    });
    session.pendingAcks.set(actionId, {
      resolve: resolveAck,
      promise,
      baseVersion,
      waiterAttached: false,
    });

    const event: SseEvent = {
      type: "ui_action",
      actionId,
      action,
      baseVersion,
    };

    this.publish(sessionId, event);
    return { actionId };
  }

  /**
   * Waits for a UI state report carrying actionId to acknowledge the action.
   * Defaults to 3000ms timeout.
   */
  awaitAck(sessionId: string, actionId: string, timeoutMs: number = 3000): Promise<AckResult> {
    const session = this.getOrCreateSession(sessionId);

    // If already acknowledged prior to awaitAck call (race condition protection)
    const existing = session.recentAcks.get(actionId);
    if (existing) {
      session.recentAcks.delete(actionId);
      return Promise.resolve({
        state: existing.state,
        rejected: existing.rejected,
      });
    }

    let pending = session.pendingAcks.get(actionId);
    if (!pending) {
      let resolveAck!: (result: AckResult) => void;
      const promise = new Promise<AckResult>((resolve) => {
        resolveAck = resolve;
      });
      pending = {
        resolve: resolveAck,
        promise,
        baseVersion: session.state?.version ?? 0,
        waiterAttached: false,
      };
      session.pendingAcks.set(actionId, pending);
    }

    if (!pending.waiterAttached) {
      pending.waiterAttached = true;
      const pendingAck = pending;
      pending.timer = setTimeout(() => {
        if (session.pendingAcks.get(actionId) === pendingAck) {
          session.pendingAcks.delete(actionId);
          pendingAck.resolve({ timeout: true });
        }
      }, timeoutMs);
      pending.timer.unref?.();
    }

    return pending.promise;
  }

  /**
   * Handles incoming UI state report from frontend.
   * Stores state (ignoring stale versions), reflects disabledFilters, and resolves any waiting action ack.
   */
  reportState(report: UiStateReport): { accepted: boolean; stale: boolean } {
    const session = this.getOrCreateSession(report.sessionId);
    let isStale = false;

    // Check version: ignore report if incoming version is older than current version
    if (session.state !== null && report.state.version < session.state.version) {
      isStale = true;
    } else {
      // Merge session disabled filters into state
      const combinedDisabled = Array.from(
        new Set([...report.state.disabledFilters, ...session.disabledFilters]),
      );
      session.state = {
        ...report.state,
        disabledFilters: combinedDisabled,
      };
    }

    // Resolve any waiting ack for actionId
    if (report.actionId) {
      const pending = session.pendingAcks.get(report.actionId);
      const effectiveState = session.state ?? report.state;
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve({
          state: effectiveState,
          rejected: report.rejected,
        });
        session.pendingAcks.delete(report.actionId);
        if (!pending.waiterAttached) {
          session.recentAcks.set(report.actionId, {
            state: effectiveState,
            rejected: report.rejected,
            timestamp: Date.now(),
          });
        }
      } else {
        // Cache recent ack in case awaitAck is registered slightly later
        session.recentAcks.set(report.actionId, {
          state: effectiveState,
          rejected: report.rejected,
          timestamp: Date.now(),
        });

        // Prune older recent acks (older than 10 seconds)
        const now = Date.now();
        for (const [id, item] of session.recentAcks.entries()) {
          if (now - item.timestamp > 10_000) {
            session.recentAcks.delete(id);
          }
        }
      }
    }

    return { accepted: !isStale, stale: isStale };
  }

  /**
   * Publishes an SSE event to all connected clients in this session.
   * Automatically cleans up closed or errored connections.
   */
  publish(sessionId: string, event: SseEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.connections.size === 0) {
      return;
    }

    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const deadConnections: Response[] = [];

    for (const res of session.connections) {
      try {
        if (res.writableEnded || res.destroyed) {
          deadConnections.push(res);
        } else {
          res.write(payload);
        }
      } catch {
        deadConnections.push(res);
      }
    }

    for (const dead of deadConnections) {
      session.connections.delete(dead);
    }
  }

  /**
   * Configures fault-injected disabled filters for a session.
   * Immediately updates session.disabledFilters and reflects them in session.state if present.
   */
  setDisabledFilters(sessionId: string, disabledFilters: string[]): void {
    const session = this.getOrCreateSession(sessionId);
    session.disabledFilters = [...disabledFilters];
    if (session.state) {
      session.state = {
        ...session.state,
        disabledFilters: [...disabledFilters],
      };
    }
  }

  getDisabledFilters(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.disabledFilters] : [];
  }

  /**
   * Registers an active SSE HTTP Response connection for a session.
   * Returns an unregister cleanup function.
   */
  addConnection(sessionId: string, res: Response): () => void {
    const session = this.getOrCreateSession(sessionId);
    session.connections.add(res);

    const cleanup = () => {
      this.removeConnection(sessionId, res);
    };

    res.on("close", cleanup);
    res.on("error", cleanup);

    return cleanup;
  }

  removeConnection(sessionId: string, res: Response): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.connections.delete(res);
    }
  }

  getConnectionCount(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session?.connections.size ?? 0;
  }

  /**
   * Clears all session data (useful for test resets).
   */
  reset(): void {
    for (const session of this.sessions.values()) {
      for (const pending of session.pendingAcks.values()) {
        if (pending.timer) clearTimeout(pending.timer);
      }
      for (const res of session.connections) {
        try {
          if (!res.writableEnded) res.end();
        } catch {
          // ignore
        }
      }
    }
    this.sessions.clear();
  }
}

/** Global singleton instance */
export const uiHub = new UiStateHub();

/**
 * Exported publish function so P3 (and other components) can emit agent_status / agent_step
 */
export function publish(sessionId: string, event: SseEvent): void {
  uiHub.publish(sessionId, event);
}
