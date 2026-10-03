import type { ConversationMemory, UiState } from "@cab/contracts";

export class MemoryStore {
  private sessions = new Map<string, ConversationMemory>();

  get(sessionId: string, appId: string): ConversationMemory {
    let memory = this.sessions.get(sessionId);
    if (!memory) {
      memory = {
        sessionId,
        appId,
        history: [],
        lastUiState: null,
        lastResult: null,
        pendingConfirmation: null,
      };
      this.sessions.set(sessionId, memory);
    }
    return memory;
  }

  recordUserTurn(sessionId: string, appId: string, text: string): void {
    const memory = this.get(sessionId, appId);
    memory.history.push({ role: "user", text });
    if (memory.history.length > 20) {
      memory.history.shift();
    }
  }

  recordAssistantTurn(
    sessionId: string,
    appId: string,
    text: string,
    uiState: UiState | null,
    lastResult?: ConversationMemory["lastResult"],
  ): void {
    const memory = this.get(sessionId, appId);
    memory.history.push({ role: "assistant", text });
    if (memory.history.length > 20) {
      memory.history.shift();
    }
    memory.lastUiState = uiState;
    if (lastResult !== undefined) {
      memory.lastResult = lastResult;
    }
  }

  setPendingConfirmation(
    sessionId: string,
    appId: string,
    pending: ConversationMemory["pendingConfirmation"],
  ): void {
    const memory = this.get(sessionId, appId);
    memory.pendingConfirmation = pending;
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
    } else {
      this.sessions.clear();
    }
  }
}

export const defaultMemoryStore = new MemoryStore();
