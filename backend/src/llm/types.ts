export class LlmError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly provider?: string;
  public readonly details?: unknown;
  public readonly retryDelayMs?: number;

  constructor(
    message: string,
    opts?: { code?: string; status?: number; provider?: string; details?: unknown; retryDelayMs?: number },
  ) {
    super(message);
    this.name = "LlmError";
    this.code = opts?.code ?? "LLM_ERROR";
    this.status = opts?.status;
    this.provider = opts?.provider;
    this.details = opts?.details;
    this.retryDelayMs = opts?.retryDelayMs;
  }
}

export type SupportedLlmProvider = "gemini" | "groq" | "openrouter" | "ollama";

export interface LlmConfig {
  provider: SupportedLlmProvider;
  apiKey: string;
  apiKeysExtra: string[];
  model: string;
  fallbackProvider?: SupportedLlmProvider;
  fallbackApiKey?: string;
  fallbackModel?: string;
  cacheEnabled: boolean;
  cacheDir?: string;
  embeddingProvider: "local" | "gemini";
  embeddingDim: number;
  ollamaBaseUrl?: string;
}

export interface LlmClientOptions {
  fetchFn?: typeof fetch;
  localEmbedder?: (texts: string[]) => Promise<number[][]>;
  cacheDir?: string;
  sleepFn?: (ms: number) => Promise<void>;
}
