import { LlmError, type SupportedLlmProvider } from "./types";

export interface ProviderCallRequest {
  provider: SupportedLlmProvider;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  isJson: boolean;
  temperature?: number;
  ollamaBaseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface ProviderCallResponse {
  rawText: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export async function callProviderRest(req: ProviderCallRequest): Promise<ProviderCallResponse> {
  const fetchFn = req.fetchFn ?? fetch;

  if (req.provider === "gemini") {
    return callGemini(req, fetchFn);
  } else if (req.provider === "groq" || req.provider === "openrouter" || req.provider === "ollama") {
    return callOpenAiCompatible(req, fetchFn);
  }

  throw new LlmError(`Unsupported provider: ${req.provider}`, { code: "UNSUPPORTED_PROVIDER" });
}

async function callGemini(req: ProviderCallRequest, fetchFn: typeof fetch): Promise<ProviderCallResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(req.apiKey)}`;

  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [{ text: req.user }],
      },
    ],
    generationConfig: {
      temperature: req.temperature ?? 0,
      responseMimeType: req.isJson ? "application/json" : "text/plain",
    },
  };

  if (req.system) {
    body.systemInstruction = {
      parts: [{ text: req.system }],
    };
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    throw new LlmError(`Network error contacting Gemini: ${err.message}`, {
      code: "NETWORK_ERROR",
      provider: "gemini",
      details: err,
    });
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    const retryAfterHeader = res.headers.get("retry-after");
    const retryDelayMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    throw new LlmError(`Gemini API error (status ${res.status}): ${errorText}`, {
      code: res.status === 429 ? "RATE_LIMIT" : "PROVIDER_ERROR",
      status: res.status,
      provider: "gemini",
      details: errorText,
      retryDelayMs: retryDelayMs && Number.isFinite(retryDelayMs) ? retryDelayMs : undefined,
    });
  }

  const data = (await res.json()) as any;
  const rawText = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";

  const usage = data?.usageMetadata
    ? {
        inputTokens: data.usageMetadata.promptTokenCount,
        outputTokens: data.usageMetadata.candidatesTokenCount,
      }
    : undefined;

  return { rawText, usage };
}

async function callOpenAiCompatible(req: ProviderCallRequest, fetchFn: typeof fetch): Promise<ProviderCallResponse> {
  let endpoint = "";
  if (req.provider === "groq") {
    endpoint = "https://api.groq.com/openai/v1/chat/completions";
  } else if (req.provider === "openrouter") {
    endpoint = "https://openrouter.ai/api/v1/chat/completions";
  } else if (req.provider === "ollama") {
    const base = req.ollamaBaseUrl?.replace(/\/+$/, "") || "http://localhost:11434";
    endpoint = `${base}/v1/chat/completions`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (req.apiKey) {
    headers["Authorization"] = `Bearer ${req.apiKey}`;
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) {
    messages.push({ role: "system", content: req.system });
  }
  messages.push({ role: "user", content: req.user });

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    temperature: req.temperature ?? 0,
  };

  if (req.isJson) {
    body.response_format = { type: "json_object" };
  }

  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    throw new LlmError(`Network error contacting ${req.provider}: ${err.message}`, {
      code: "NETWORK_ERROR",
      provider: req.provider,
      details: err,
    });
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    const retryAfterHeader = res.headers.get("retry-after");
    const retryDelayMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    throw new LlmError(`${req.provider} API error (status ${res.status}): ${errorText}`, {
      code: res.status === 429 ? "RATE_LIMIT" : "PROVIDER_ERROR",
      status: res.status,
      provider: req.provider,
      details: errorText,
      retryDelayMs: retryDelayMs && Number.isFinite(retryDelayMs) ? retryDelayMs : undefined,
    });
  }

  const data = (await res.json()) as any;
  const rawText = data?.choices?.[0]?.message?.content ?? "";

  const usage = data?.usage
    ? {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      }
    : undefined;

  return { rawText, usage };
}

export async function callGeminiEmbeddings(
  apiKey: string,
  model: string,
  texts: string[],
  fetchFn: typeof fetch = fetch,
): Promise<number[][]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;

  const body = {
    requests: texts.map((t) => ({
      model: "models/text-embedding-004",
      content: { parts: [{ text: t }] },
    })),
  };

  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new LlmError(`Gemini Embeddings error (status ${res.status}): ${errorText}`, {
      code: "EMBEDDING_ERROR",
      status: res.status,
      provider: "gemini",
    });
  }

  const data = (await res.json()) as any;
  return data?.embeddings?.map((e: any) => e.values ?? []) ?? [];
}
