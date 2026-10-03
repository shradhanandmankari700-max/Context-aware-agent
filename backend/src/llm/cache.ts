import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface CachedLlmPayload {
  rawText: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  createdAt: string;
}

export function computeCacheKey(params: {
  provider: string;
  model: string;
  system: string;
  user: string;
  schemaName?: string;
}): string {
  const payload = [
    params.provider,
    params.model,
    params.system,
    params.user,
    params.schemaName ?? "",
  ].join("\0");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function resolveCacheDir(customDir?: string): string {
  if (customDir) return customDir;
  // If running from root of repo:
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "backend"))) {
    return path.join(cwd, "backend", ".llm-cache");
  }
  return path.join(cwd, ".llm-cache");
}

export function readDiskCache(cacheDir: string, key: string): CachedLlmPayload | null {
  try {
    const filePath = path.join(cacheDir, `${key}.json`);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as CachedLlmPayload;
  } catch {
    return null;
  }
}

export function writeDiskCache(cacheDir: string, key: string, payload: CachedLlmPayload): void {
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const filePath = path.join(cacheDir, `${key}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    // Cache write error shouldn't crash the application
    console.warn(`[LlmCache] Failed to write cache key ${key}:`, err);
  }
}
