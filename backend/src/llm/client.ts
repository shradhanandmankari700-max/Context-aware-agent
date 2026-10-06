import type { LlmClient, LlmJsonRequest, LlmResult } from "@cab/contracts";
import {
  LlmError,
  type LlmClientOptions,
  type LlmConfig,
  type SupportedLlmProvider,
} from "./types";
import { computeCacheKey, readDiskCache, resolveCacheDir, writeDiskCache } from "./cache";
import { tryExtractJson } from "./cleanJson";
import {
  callGeminiEmbeddings,
  callProviderRest,
  DEFAULT_NVIDIA_BASE_URL,
  type ProviderCallResponse,
} from "./providers";
import crypto from "node:crypto";

function hasMalformedAgentTurnClarification(schemaName: string | undefined, candidate: unknown): boolean {
  if (schemaName !== "AgentTurn" || !candidate || typeof candidate !== "object") return false;

  const turn = candidate as Record<string, unknown>;
  if (!("clarification" in turn)) return false;

  const clarification = turn.clarification;
  if (!clarification || typeof clarification !== "object") return true;

  const question = (clarification as Record<string, unknown>).question;
  return typeof question !== "string" || question.trim().length === 0;
}

function readEnvValue(env: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = env[key];
    if (direct && direct.trim()) {
      return direct.trim();
    }

    const lowerKey = key.toLowerCase();
    for (const [candidateKey, candidateValue] of Object.entries(env)) {
      if (candidateKey.toLowerCase() === lowerKey && candidateValue && candidateValue.trim()) {
        return candidateValue.trim();
      }
    }
  }

  return undefined;
}

function defaultModelForProvider(provider: SupportedLlmProvider): string {
  switch (provider) {
    case "gemini":
      return "gemini-3.5-flash-lite";
    case "groq":
      return "qwen/qwen3.8-27b";
    case "openrouter":
      return "google/gemini-2.5-flash";
    case "ollama":
      return "llama3.1";
    case "nvidia":
      return "nvidia/nemotron-3-super-120b-a12b";
  }
}

export function parseConfigFromEnv(env: Record<string, string | undefined>): LlmConfig {
  const providerValue = readEnvValue(env, "LLM_PROVIDER", "llm_provider") ?? "nvidia";
  const provider = providerValue.toLowerCase() as SupportedLlmProvider;
  const apiKey =
    provider === "nvidia"
      ? readEnvValue(env, "NVIDIA_API_KEY", "nvidiaapikey", "LLM_API_KEY", "llm_api_key") ?? ""
      : readEnvValue(env, "LLM_API_KEY", "llm_api_key") ?? "";
  const apiKeysExtra = (readEnvValue(env, "LLM_API_KEYS_EXTRA", "llm_api_keys_extra") ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const explicitModel = readEnvValue(env, "LLM_MODEL", "llm_model") ?? defaultModelForProvider(provider);
  const modelCandidates = readEnvValue(env, "LLM_MODELS", "llm_models")
    ? readEnvValue(env, "LLM_MODELS", "llm_models")!.split(",").map((m) => m.trim()).filter(Boolean)
    : [explicitModel];
  const model = modelCandidates[0] || explicitModel;
  const models = modelCandidates.length ? modelCandidates : [model];

  const fallbackProvider = provider === "nvidia" ? undefined : readEnvValue(env, "LLM_FALLBACK_PROVIDER", "llm_fallback_provider")
    ? (readEnvValue(env, "LLM_FALLBACK_PROVIDER", "llm_fallback_provider")!.toLowerCase() as SupportedLlmProvider)
    : undefined;
  const fallbackApiKey = provider === "nvidia" ? undefined : readEnvValue(env, "LLM_FALLBACK_API_KEY", "llm_fallback_api_key");
  const fallbackModel =
    provider === "nvidia"
      ? undefined
      : readEnvValue(env, "LLM_FALLBACK_MODEL", "llm_fallback_model") ||
        (fallbackProvider ? defaultModelForProvider(fallbackProvider) : undefined);

  const cacheEnabled = readEnvValue(env, "LLM_CACHE", "llm_cache") !== "off";
  const embeddingProvider = (env.EMBEDDING_PROVIDER === "gemini" ? "gemini" : "local") as "local" | "gemini";
  const embeddingDim = Number(env.EMBEDDING_DIM || 384);
  const nvidiaBaseUrl = readEnvValue(env, "NVIDIA_BASE_URL", "nvidia_base_url") ?? DEFAULT_NVIDIA_BASE_URL;

  return {
    provider,
    apiKey,
    apiKeysExtra,
    model,
    models,
    fallbackProvider,
    fallbackApiKey,
    fallbackModel,
    cacheEnabled,
    embeddingProvider,
    embeddingDim,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    nvidiaBaseUrl,
  };
}

export function getConfiguredLlmIdentity(
  env: Record<string, string | undefined> = process.env,
): { provider: string; model: string } {
  const config = parseConfigFromEnv(env);
  return { provider: config.provider, model: config.model };
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

  const primaryKeys = [config.apiKey, ...config.apiKeysExtra].filter(Boolean);
  let currentKeyIdx = 0;
  const exhaustedKeys = new Set<string>();

  console.info(
    `[llm] provider=${config.provider} model=${config.model} models=${config.models.join("|")} fallbackProvider=${config.fallbackProvider ?? "none"} fallbackModel=${config.fallbackModel ?? "none"} cache=${config.cacheEnabled ? "on" : "off"} keys=${primaryKeys.length}`,
  );

  async function executeWithRetryAndFallback(params: {
    system: string;
    user: string;
    isJson: boolean;
    temperature?: number;
  }): Promise<{ response: ProviderCallResponse; provider: string; model: string }> {
    const primaryModels = config.models.length ? config.models : [config.model];
    const totalPrimaryAttempts = Math.max(1, primaryModels.length * Math.max(1, primaryKeys.length || 1));
    let lastError: Error | null = null;

    // 1. Try primary provider with model/key rotation and backoff
    for (let attempt = 0; attempt < totalPrimaryAttempts; attempt++) {
      const modelIndex = attempt % primaryModels.length;
      const activeModel = primaryModels[modelIndex] ?? config.model;
      const activeKey = primaryKeys[currentKeyIdx] ?? config.apiKey;
      const keyMarker = `${config.provider}:${activeModel}:${activeKey}`;
      if (exhaustedKeys.has(keyMarker)) {
        currentKeyIdx = (currentKeyIdx + 1) % Math.max(1, primaryKeys.length || 1);
        continue;
      }
      try {
        const response = await callProviderRest({
          provider: config.provider,
          apiKey: activeKey,
          model: activeModel,
          system: params.system,
          user: params.user,
          isJson: params.isJson,
          temperature: params.temperature,
          ollamaBaseUrl: config.ollamaBaseUrl,
          nvidiaBaseUrl: config.nvidiaBaseUrl,
          fetchFn,
        });
        return { response, provider: config.provider, model: activeModel };
      } catch (err: any) {
        lastError = err;
        const isRateLimit = err instanceof LlmError && err.status === 429;
        const isServerError = err instanceof LlmError && err.status && err.status >= 500;

        if (isRateLimit) {
          const retryDelayMs = err.retryDelayMs ?? 1000;
          exhaustedKeys.add(keyMarker);
          currentKeyIdx = (currentKeyIdx + 1) % Math.max(1, primaryKeys.length || 1);

          if (retryDelayMs < 20000 && primaryKeys.length > 1) {
            await sleepFn(Math.min(retryDelayMs, 20000));
            continue;
          }
        }

        if (isRateLimit || isServerError) {
          if (attempt < totalPrimaryAttempts - 1) {
            await sleepFn(100 * Math.pow(2, Math.min(attempt, 4)));
            continue;
          }
        } else {
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
          nvidiaBaseUrl: config.nvidiaBaseUrl,
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
        model: "__model_ignored__",
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
      let initialJsonObj: unknown;

      try {
        initialJsonObj = JSON.parse(extractedJson);
        parsedData = parse(initialJsonObj);
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
          ...(req.schemaName === "AgentTurn"
            ? [
                "Do not invent or infer a clarification question. If the previous clarification has no non-empty question, do not return a clarification unless its question is explicitly recoverable from the previous response. A directly actionable request must instead receive a normal plan without clarification. If no valid correction can be made without inventing information, return the malformed candidate so validation rejects it.",
              ]
            : []),
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
          if (
            hasMalformedAgentTurnClarification(req.schemaName, initialJsonObj) &&
            rawRepairedObj &&
            typeof rawRepairedObj === "object" &&
            "clarification" in rawRepairedObj
          ) {
            throw new Error("Cannot repair malformed AgentTurn clarification without a recoverable question");
          }
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
        model: "__model_ignored__",
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
