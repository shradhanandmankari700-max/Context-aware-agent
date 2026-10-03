import type { LlmClient, LlmJsonRequest, LlmResult } from "@cab/contracts";
import {
  LlmError,
  type LlmClientOptions,
  type LlmConfig,
  type SupportedLlmProvider,
} from "./types";
import { computeCacheKey, readDiskCache, resolveCacheDir, writeDiskCache } from "./cache";
import { tryExtractJson } from "./cleanJson";
import { callGeminiEmbeddings, callProviderRest, type ProviderCallResponse } from "./providers";
import crypto from "node:crypto";

function defaultModelForProvider(provider: SupportedLlmProvider): string {
  switch (provider) {
    case "gemini":
      return "gemini-1.5-flash";
    case "groq":
      return "llama-3.3-70b-versatile";
    case "openrouter":
      return "google/gemini-flash-1.5";
    case "ollama":
      return "llama3.1";
  }
}

export function parseConfigFromEnv(env: Record<string, string | undefined>): LlmConfig {
  const provider = (env.LLM_PROVIDER || "gemini").toLowerCase() as SupportedLlmProvider;
  const apiKey = env.LLM_API_KEY || "";
  const apiKeysExtra = (env.LLM_API_KEYS_EXTRA || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const model = env.LLM_MODEL || defaultModelForProvider(provider);

  const fallbackProvider = env.LLM_FALLBACK_PROVIDER
    ? (env.LLM_FALLBACK_PROVIDER.toLowerCase() as SupportedLlmProvider)
    : undefined;
  const fallbackApiKey = env.LLM_FALLBACK_API_KEY;
  const fallbackModel =
    env.LLM_FALLBACK_MODEL || (fallbackProvider ? defaultModelForProvider(fallbackProvider) : undefined);

  const cacheEnabled = env.LLM_CACHE !== "off";
  const embeddingProvider = (env.EMBEDDING_PROVIDER === "gemini" ? "gemini" : "local") as "local" | "gemini";
  const embeddingDim = Number(env.EMBEDDING_DIM || 384);

  return {
    provider,
    apiKey,
    apiKeysExtra,
    model,
    fallbackProvider,
    fallbackApiKey,
    fallbackModel,
    cacheEnabled,
    embeddingProvider,
    embeddingDim,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
  };
}

/**
 * Deterministic local embedding fallback producing normalized float vector of dimension N.
 */
function deterministicLocalEmbed(text: string, dim: number): number[] {
  const vec = new Float64Array(dim);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) words.push("");

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const hash = crypto.createHash("sha256").update(word).digest();
    for (let j = 0; j < dim; j++) {
      const byte = hash[j % hash.length]!;
      const sign = (byte & 1) === 0 ? 1 : -1;
      vec[j]! += sign * (byte / 255.0);
    }
  }

  // L2 normalize
  let norm = 0;
  for (let j = 0; j < dim; j++) {
    norm += vec[j]! * vec[j]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let j = 0; j < dim; j++) {
      vec[j] = vec[j]! / norm;
    }
  }

  return Array.from(vec);
}

export function createLlmClient(
  env: Record<string, string | undefined> = process.env,
  options: LlmClientOptions = {},
): LlmClient {
  const config = parseConfigFromEnv(env);
  const cacheDir = resolveCacheDir(options.cacheDir);
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  // Key pool for primary provider: primary key + extras
  const primaryKeys = [config.apiKey, ...config.apiKeysExtra].filter(Boolean);
  let currentKeyIdx = 0;

  async function executeWithRetryAndFallback(params: {
    system: string;
    user: string;
    isJson: boolean;
    temperature?: number;
  }): Promise<{ response: ProviderCallResponse; provider: string; model: string }> {
    const maxPrimaryAttempts = Math.max(1, primaryKeys.length);
    let lastError: Error | null = null;

    // 1. Try primary provider with key rotation and backoff
    for (let attempt = 0; attempt < maxPrimaryAttempts; attempt++) {
      const activeKey = primaryKeys[currentKeyIdx] ?? config.apiKey;
      try {
        const response = await callProviderRest({
          provider: config.provider,
          apiKey: activeKey,
          model: config.model,
          system: params.system,
          user: params.user,
          isJson: params.isJson,
          temperature: params.temperature,
          ollamaBaseUrl: config.ollamaBaseUrl,
          fetchFn,
        });
        return { response, provider: config.provider, model: config.model };
      } catch (err: any) {
        lastError = err;
        const isRateLimit = err instanceof LlmError && err.status === 429;
        const isServerError = err instanceof LlmError && err.status && err.status >= 500;

        if (isRateLimit && primaryKeys.length > 1) {
          // Rotate to next key
          currentKeyIdx = (currentKeyIdx + 1) % primaryKeys.length;
          continue;
        }

        if (isRateLimit || isServerError) {
          // Exponential backoff before retry if we have more attempts
          if (attempt < maxPrimaryAttempts - 1) {
            await sleepFn(100 * Math.pow(2, attempt));
            continue;
          }
        } else {
          // Other non-retriable error
          break;
        }
      }
    }

    // 2. Try fallback provider if configured
    if (config.fallbackProvider && (config.fallbackApiKey || config.fallbackProvider === "ollama")) {
      try {
        const response = await callProviderRest({
          provider: config.fallbackProvider,
          apiKey: config.fallbackApiKey ?? "",
          model: config.fallbackModel ?? defaultModelForProvider(config.fallbackProvider),
          system: params.system,
          user: params.user,
          isJson: params.isJson,
          temperature: params.temperature,
          ollamaBaseUrl: config.ollamaBaseUrl,
          fetchFn,
        });
        return {
          response,
          provider: config.fallbackProvider,
          model: config.fallbackModel ?? defaultModelForProvider(config.fallbackProvider),
        };
      } catch (fallbackErr: any) {
        throw new LlmError(
          `Primary provider (${config.provider}) and fallback provider (${config.fallbackProvider}) both failed. Primary error: ${lastError?.message}. Fallback error: ${fallbackErr.message}`,
          { code: "ALL_PROVIDERS_FAILED", details: { primary: lastError, fallback: fallbackErr } },
        );
      }
    }

    throw (
      lastError ||
      new LlmError(`Failed to call LLM provider ${config.provider}`, { code: "PROVIDER_CALL_FAILED" })
    );
  }

  const client: LlmClient = {
    async json<T>(req: LlmJsonRequest, parse: (raw: unknown) => T): Promise<LlmResult<T>> {
      const temperature = req.temperature ?? 0;
      const cacheKey = computeCacheKey({
        provider: config.provider,
        model: config.model,
        system: req.system,
        user: req.user,
        schemaName: req.schemaName,
      });

      // Check disk cache first
      if (config.cacheEnabled) {
        const cached = readDiskCache(cacheDir, cacheKey);
        if (cached) {
          try {
            const extracted = tryExtractJson(cached.rawText);
            const parsedObj = JSON.parse(extracted);
            const data = parse(parsedObj);
            return {
              data,
              cached: true,
              usage: cached.usage,
              latencyMs: 0,
            };
          } catch {
            // Invalid cache entry, continue to query provider
          }
        }
      }

      const startTime = Date.now();
      const { response, provider, model } = await executeWithRetryAndFallback({
        system: req.system,
        user: req.user,
        isJson: true,
        temperature,
      });
      const latencyMs = Date.now() - startTime;

      let extractedJson = tryExtractJson(response.rawText);
      let parsedData: T;

      try {
        const rawJsonObj = JSON.parse(extractedJson);
        parsedData = parse(rawJsonObj);
      } catch (err: any) {
        // ONE REPAIR RETRY
        const validationErrorMsg = err instanceof Error ? err.message : String(err);
        const repairSystem =
          "You are a strict JSON repair engine. Output ONLY valid JSON matching the requested schema. No conversational filler or commentary.";
        const repairUser = [
          `The previous response failed validation for schema "${req.schemaName}".`,
          `Validation error: ${validationErrorMsg}`,
          `Previous response was:`,
          response.rawText,
          `Please fix the issue and return ONLY the corrected valid JSON matching schema "${req.schemaName}".`,
        ].join("\n\n");

        try {
          const repairRes = await executeWithRetryAndFallback({
            system: repairSystem,
            user: repairUser,
            isJson: true,
            temperature: 0,
          });

          extractedJson = tryExtractJson(repairRes.response.rawText);
          const rawRepairedObj = JSON.parse(extractedJson);
          parsedData = parse(rawRepairedObj);

          // Update response text with repaired version for cache storage
          response.rawText = repairRes.response.rawText;
        } catch (repairErr: any) {
          throw new LlmError(
            `Failed to parse and validate JSON for ${req.schemaName} after repair attempt: ${repairErr.message}`,
            {
              code: "JSON_PARSE_ERROR",
              details: { initialError: validationErrorMsg, repairError: repairErr.message },
            },
          );
        }
      }

      // Write to disk cache if caching is on
      if (config.cacheEnabled) {
        writeDiskCache(cacheDir, cacheKey, {
          rawText: response.rawText,
          usage: response.usage,
          createdAt: new Date().toISOString(),
        });
      }

      return {
        data: parsedData,
        cached: false,
        usage: response.usage,
        latencyMs,
      };
    },

    async text(req: { system: string; user: string; temperature?: number }): Promise<LlmResult<string>> {
      const temperature = req.temperature ?? 0;
      const cacheKey = computeCacheKey({
        provider: config.provider,
        model: config.model,
        system: req.system,
        user: req.user,
        schemaName: "__text__",
      });

      if (config.cacheEnabled) {
        const cached = readDiskCache(cacheDir, cacheKey);
        if (cached) {
          return {
            data: cached.rawText,
            cached: true,
            usage: cached.usage,
            latencyMs: 0,
          };
        }
      }

      const startTime = Date.now();
      const { response } = await executeWithRetryAndFallback({
        system: req.system,
        user: req.user,
        isJson: false,
        temperature,
      });
      const latencyMs = Date.now() - startTime;

      if (config.cacheEnabled) {
        writeDiskCache(cacheDir, cacheKey, {
          rawText: response.rawText,
          usage: response.usage,
          createdAt: new Date().toISOString(),
        });
      }

      return {
        data: response.rawText,
        cached: false,
        usage: response.usage,
        latencyMs,
      };
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      if (config.embeddingProvider === "local") {
        if (options.localEmbedder) {
          return options.localEmbedder(texts);
        }
        return texts.map((t) => deterministicLocalEmbed(t, config.embeddingDim));
      }

      if (config.embeddingProvider === "gemini" && config.apiKey) {
        return callGeminiEmbeddings(config.apiKey, config.model, texts, fetchFn);
      }

      // Fallback to local deterministic embedding
      return texts.map((t) => deterministicLocalEmbed(t, config.embeddingDim));
    },
  };

  return client;
}
