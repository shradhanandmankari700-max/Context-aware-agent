import type { LlmClient, LlmJsonRequest, LlmResult } from "@cab/contracts";

export interface FakeRecordedCall {
  type: "json" | "text" | "embed";
  request: unknown;
  timestamp: number;
}

export interface FakeLlmClient extends LlmClient {
  enqueueJson(value: unknown): void;
  enqueueText(text: string): void;
  enqueueEmbed(vectors: number[][]): void;
  getRecordedCalls(): FakeRecordedCall[];
  clear(): void;
}

export function createFakeLlmClient(initial?: {
  jsonQueue?: unknown[];
  textQueue?: string[];
  embedQueue?: number[][][];
}): FakeLlmClient {
  const jsonQueue: unknown[] = [...(initial?.jsonQueue ?? [])];
  const textQueue: string[] = [...(initial?.textQueue ?? [])];
  const embedQueue: number[][][] = [...(initial?.embedQueue ?? [])];
  const recordedCalls: FakeRecordedCall[] = [];

  const client: FakeLlmClient = {
    async json<T>(req: LlmJsonRequest, parse: (raw: unknown) => T): Promise<LlmResult<T>> {
      recordedCalls.push({
        type: "json",
        request: req,
        timestamp: Date.now(),
      });

      if (jsonQueue.length === 0) {
        throw new Error(
          `FakeLlmClient: jsonQueue is empty! Call was made for schema "${req.schemaName}" with user prompt: "${req.user.slice(0, 100)}..."`,
        );
      }

      const item = jsonQueue.shift();
      let rawObj: unknown = item;
      if (typeof item === "string") {
        try {
          rawObj = JSON.parse(item);
        } catch (e: any) {
          throw new Error(`FakeLlmClient: Failed to parse queued JSON string: ${e.message}`);
        }
      }

      const parsed = parse(rawObj);
      return {
        data: parsed,
        cached: false,
        usage: { inputTokens: 25, outputTokens: 25 },
        latencyMs: 1,
      };
    },

    async text(req: { system: string; user: string; temperature?: number }): Promise<LlmResult<string>> {
      recordedCalls.push({
        type: "text",
        request: req,
        timestamp: Date.now(),
      });

      if (textQueue.length === 0) {
        return {
          data: "Fake LLM response text",
          cached: false,
          usage: { inputTokens: 10, outputTokens: 10 },
          latencyMs: 1,
        };
      }

      const txt = textQueue.shift()!;
      return {
        data: txt,
        cached: false,
        usage: { inputTokens: 10, outputTokens: 10 },
        latencyMs: 1,
      };
    },

    async embed(texts: string[]): Promise<number[][]> {
      recordedCalls.push({
        type: "embed",
        request: texts,
        timestamp: Date.now(),
      });

      if (embedQueue.length > 0) {
        return embedQueue.shift()!;
      }

      // Default deterministic 384-dimensional vectors
      return texts.map((_, idx) => {
        const vec = new Array(384).fill(0);
        vec[idx % 384] = 1.0;
        return vec;
      });
    },

    enqueueJson(value: unknown): void {
      jsonQueue.push(value);
    },

    enqueueText(text: string): void {
      textQueue.push(text);
    },

    enqueueEmbed(vectors: number[][]): void {
      embedQueue.push(vectors);
    },

    getRecordedCalls(): FakeRecordedCall[] {
      return [...recordedCalls];
    },

    clear(): void {
      jsonQueue.length = 0;
      textQueue.length = 0;
      embedQueue.length = 0;
      recordedCalls.length = 0;
    },
  };

  return client;
}
