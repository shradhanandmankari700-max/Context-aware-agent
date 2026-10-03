import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const EMBEDDING_DIMENSION = 384;
export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const BATCH_SIZE = 32;
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_CACHE_DIR = path.join(BACKEND_ROOT, ".model-cache");

const VectorSchema = z.array(z.number().finite()).length(EMBEDDING_DIMENSION);
const BatchSchema = z.array(VectorSchema);

export type TextEmbedder = (texts: string[]) => Promise<number[][]>;
type ExtractionRunner = (texts: string[]) => Promise<unknown>;

export interface LocalEmbedderOptions {
  model?: string;
  cacheDir?: string;
  batchSize?: number;
  loadPipeline?: (model: string, cacheDir: string) => Promise<ExtractionRunner>;
}

async function loadTransformersPipeline(model: string, cacheDir: string): Promise<ExtractionRunner> {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", model, {
    cache_dir: cacheDir,
    dtype: "fp32",
  });
  return async (texts) => {
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  };
}

export function normalizeEmbedding(vector: number[], label = "Embedding"): number[] {
  const parsed = VectorSchema.safeParse(vector);
  if (!parsed.success) {
    throw new Error(`${label} must contain exactly ${EMBEDDING_DIMENSION} finite numbers`);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error(`${label} must not be a zero or non-finite vector`);
  return vector.map((value) => value / norm);
}

export function createLocalEmbedder(options: LocalEmbedderOptions = {}): TextEmbedder {
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const cacheDir = path.resolve(options.cacheDir ?? DEFAULT_CACHE_DIR);
  const batchSize = options.batchSize ?? BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Embedding batchSize must be a positive integer");

  const loader = options.loadPipeline ?? loadTransformersPipeline;
  let pipelinePromise: Promise<ExtractionRunner> | undefined;

  return async (texts) => {
    if (!texts.length) return [];
    const run = pipelinePromise ?? (pipelinePromise = loader(model, cacheDir));
    const extractor = await run;
    const output: number[][] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const rawVectors = BatchSchema.safeParse(await extractor(batch));
      if (!rawVectors.success) {
        throw new Error(
          `Embedding model returned an invalid batch: ${rawVectors.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      if (rawVectors.data.length !== batch.length) {
        throw new Error(`Embedding model returned ${rawVectors.data.length} vectors for ${batch.length} texts`);
      }
      output.push(...rawVectors.data.map((vector, index) => normalizeEmbedding(vector, `Embedding ${start + index + 1}`)));
    }
    return output;
  };
}

const defaultEmbedder = createLocalEmbedder();

export function embed(texts: string[]): Promise<number[][]> {
  return defaultEmbedder(texts);
}
