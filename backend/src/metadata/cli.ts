import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppMetadata, ImportBundle } from "@cab/contracts";
import { Pool } from "pg";
import { createLlmClient } from "../llm";
import { loadBackendEnvironment } from "../loadEnv";
import { createMetadataStore } from "./index";

loadBackendEnvironment();

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const metadataFile = args.find((arg) => !arg.startsWith("--"));
  if (!metadataFile) throw new Error("Usage: npm run import:app -- <metadata.json> [--tenant <tenant-id>]");

  const tenantId = argumentValue(args, "--tenant") ?? process.env.TENANT_ID;
  if (!tenantId) throw new Error("Set TENANT_ID or provide --tenant <tenant-id> for the import.");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set to import metadata.");

  const filePath = path.resolve(process.env.INIT_CWD ?? process.cwd(), metadataFile);
  const parsedJson: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const bundleParse = ImportBundle.safeParse(parsedJson);
  let bundle = bundleParse.success
    ? bundleParse.data
    : { metadata: AppMetadata.parse(parsedJson) };

  const dataFile = argumentValue(args, "--data");
  if (dataFile) {
    const dataPath = path.resolve(process.env.INIT_CWD ?? process.cwd(), dataFile);
    const dataJson: unknown = JSON.parse(await readFile(dataPath, "utf8"));
    if (dataJson && typeof dataJson === "object" && !Array.isArray(dataJson)) {
      bundle = { ...bundle, data: dataJson as Record<string, Record<string, unknown>[]> };
    }
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const store = createMetadataStore({ pool, llm: createLlmClient(process.env) });
    const result = await store.importApp(tenantId, bundle);
    console.log(`Imported ${result.appId} for tenant ${tenantId}:`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
    console.error(`[metadata import] ${error.name}${code}: ${error.message || "No additional error details"}`);
  } else {
    console.error("[metadata import]", String(error));
  }
  process.exitCode = 1;
});
