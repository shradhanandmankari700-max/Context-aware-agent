import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLlmClient } from "./client";
import { createFakeLlmClient } from "./fake";
import { LlmError } from "./types";

describe("LlmClient", () => {
  let tempCacheDir: string;

  beforeEach(() => {
    tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-cache-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempCacheDir, { recursive: true, force: true });
    } catch {}
  });

  const SampleSchema = z.object({
    status: z.string(),
    items: z.array(z.string()),
  });

  it("calls Gemini REST API and strips code fences", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "```json\n{\n  \"status\": \"success\",\n  \"items\": [\"item1\", \"item2\"]\n}\n```",
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 25 },
      }),
    });

    const client = createLlmClient(
      {
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: "test-gemini-key",
        LLM_MODEL: "gemini-1.5-flash",
        LLM_CACHE: "off",
      },
      { fetchFn: mockFetch as any },
    );

    const result = await client.json(
      {
        system: "You are a test assistant.",
        user: "Get items",
        schemaName: "SampleSchema",
      },
      (raw) => SampleSchema.parse(raw),
    );

    expect(result.data).toEqual({ status: "success", items: ["item1", "item2"] });
    expect(result.cached).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 25 });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callUrl = mockFetch.mock.calls[0][0];
    expect(callUrl).toContain("key=test-gemini-key");
  });

  it("calls OpenAI-compatible provider (Groq) with auth header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "ok", items: ["groq-1"] }),
            },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 40 },
      }),
    });

    const client = createLlmClient(
      {
        LLM_PROVIDER: "groq",
        LLM_API_KEY: "gsk-test-key",
        LLM_MODEL: "llama-3.3-70b-versatile",
        LLM_CACHE: "off",
      },
      { fetchFn: mockFetch as any },
    );

    const result = await client.json(
      {
        system: "sys",
        user: "usr",
        schemaName: "SampleSchema",
      },
      (raw) => SampleSchema.parse(raw),
    );

    expect(result.data).toEqual({ status: "ok", items: ["groq-1"] });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gsk-test-key",
        }),
      }),
    );
  });

  it("performs ONE repair retry on schema validation failure", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First attempt returns invalid data (items as a string instead of array)
        return {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ status: "error", items: "invalid-string" }) }],
                },
              },
            ],
          }),
        };
      }
      // Second attempt (repair) returns valid data
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ status: "repaired", items: ["fixed1"] }) }],
              },
            },
          ],
        }),
      };
    });

    const client = createLlmClient(
      {
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: "test-gemini-key",
        LLM_CACHE: "off",
      },
      { fetchFn: mockFetch as any },
    );

    const result = await client.json(
      {
        system: "sys",
        user: "get items",
        schemaName: "SampleSchema",
      },
      (raw) => SampleSchema.parse(raw),
    );

    expect(result.data).toEqual({ status: "repaired", items: ["fixed1"] });
    expect(callCount).toBe(2);
  });

  it("throws LlmError if repair attempt also fails validation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ invalid: "data" }) }],
            },
          },
        ],
      }),
    });

    const client = createLlmClient(
      {
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: "test-gemini-key",
        LLM_CACHE: "off",
      },
      { fetchFn: mockFetch as any },
    );

    await expect(
      client.json(
        {
          system: "sys",
          user: "get items",
          schemaName: "SampleSchema",
        },
        (raw) => SampleSchema.parse(raw),
      ),
    ).rejects.toThrow(LlmError);
  });

  it("rotates keys on 429 rate limit", async () => {
    let callIndex = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callIndex++;
      if (url.includes("key1")) {
        return {
          ok: false,
          status: 429,
          text: async () => "Rate limit exceeded",
        };
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ status: "success", items: ["from-key2"] }) }],
              },
            },
          ],
        }),
      };
    });

    const client = createLlmClient(
      {
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: "key1",
        LLM_API_KEYS_EXTRA: "key2,key3",
        LLM_CACHE: "off",
      },
      { fetchFn: mockFetch as any, sleepFn: async () => {} },
    );

    const result = await client.json(
      {
        system: "sys",
        user: "usr",
        schemaName: "SampleSchema",
      },
      (raw) => SampleSchema.parse(raw),
    );

    expect(result.data.items).toEqual(["from-key2"]);
    expect(callIndex).toBe(2);
  });

  it("falls back to fallback provider when primary provider is exhausted", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return {
          ok: false,
          status: 500,
          text: async () => "Gemini server error",
        };
      }
      if (url.includes("api.groq.com")) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({ status: "fallback_ok", items: ["fallback-item"] }),
                },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const client = createLlmClient(
      {
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: "gemini-key",
        LLM_FALLBACK_PROVIDER: "groq",
        LLM_FALLBACK_API_KEY: "groq-key",
        LLM_CACHE: "off",
      },
      { fetchFn: mockFetch as any, sleepFn: async () => {} },
    );

    const result = await client.json(
      {
        system: "sys",
        user: "usr",
        schemaName: "SampleSchema",
      },
      (raw) => SampleSchema.parse(raw),
    );

    expect(result.data.status).toBe("fallback_ok");
  });

  it("serves cached responses from disk on subsequent calls", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ status: "cached-test", items: ["c1"] }) }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
      }),
    });

    const client = createLlmClient(
      {
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: "gemini-key",
        LLM_CACHE: "on",
      },
      { fetchFn: mockFetch as any, cacheDir: tempCacheDir },
    );

    // Call 1: should fetch and cache
    const res1 = await client.json(
      {
        system: "sys",
        user: "unique-user-prompt-1",
        schemaName: "SampleSchema",
      },
      (raw) => SampleSchema.parse(raw),
    );
    expect(res1.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Call 2: identical input, should hit cache without calling fetch
    const res2 = await client.json(
      {
        system: "sys",
        user: "unique-user-prompt-1",
        schemaName: "SampleSchema",
      },
      (raw) => SampleSchema.parse(raw),
    );
    expect(res2.cached).toBe(true);
    expect(res2.latencyMs).toBe(0);
    expect(res2.data).toEqual(res1.data);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("computes deterministic embeddings", async () => {
    const client = createLlmClient({
      EMBEDDING_PROVIDER: "local",
      EMBEDDING_DIM: "384",
    });

    const vectors = await client.embed(["test medicine stock", "hospital inventory"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
    expect(vectors[1]).toHaveLength(384);

    // Identical text produces identical vector
    const repeat = await client.embed(["test medicine stock"]);
    expect(repeat[0]).toEqual(vectors[0]);
  });
});

describe("FakeLlmClient", () => {
  it("returns queued responses and validates schemas", async () => {
    const fake = createFakeLlmClient();
    const TestSchema = z.object({ value: z.number() });

    fake.enqueueJson({ value: 42 });
    fake.enqueueText("hello fake");

    const jsonRes = await fake.json(
      { system: "", user: "", schemaName: "TestSchema" },
      (r) => TestSchema.parse(r),
    );
    expect(jsonRes.data).toEqual({ value: 42 });

    const textRes = await fake.text({ system: "", user: "" });
    expect(textRes.data).toBe("hello fake");

    expect(fake.getRecordedCalls()).toHaveLength(2);
  });
});
