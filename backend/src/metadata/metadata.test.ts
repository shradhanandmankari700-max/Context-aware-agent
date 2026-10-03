import { createServer, type Server } from "node:http";
import express from "express";
import { AppMetadata, type RequestContext } from "@cab/contracts";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import hospitalFixture from "../../../metadata/hospital.json";
import { createFakeLlmClient } from "../llm/fake";
import { buildMetadataContext, buildMetadataDocuments } from "./documents";
import { createFakeMetadataStore } from "./fake";
import { createMetadataRouter, MetadataAuthenticationError } from "./routes";
import { createMetadataStore, MetadataImportValidationError, MetadataStoreError } from "./store";

const hospital = AppMetadata.parse(hospitalFixture);
const context = (tenantId: string, appId = hospital.appId): RequestContext => ({
  tenantId,
  appId,
  userId: "user-1",
  role: "admin",
  sessionId: "session-123",
  traceId: "trace-123",
  now: "2026-10-07",
});

type DbResult = { rows: Array<Record<string, unknown>>; rowCount: number };
type QueryHandler = (sql: string, values: unknown[]) => Promise<DbResult>;

function mockPool(handler: QueryHandler) {
  const query = vi.fn((sql: string, values: unknown[] = []) => handler(sql, values));
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, client };
}

describe("metadata documents and context", () => {
  it("includes filter synonyms, option vocabulary, and breadcrumb paths", () => {
    const docs = buildMetadataDocuments(hospital);
    const lowStock = docs.find((doc) => doc.kind === "filter" && doc.id === "stockLevel");
    expect(lowStock?.doc.toLowerCase()).toContain("running low");
    expect(lowStock?.doc.toLowerCase()).toContain("low stock");
    expect(lowStock?.doc.toLowerCase()).toContain("shortage");
    expect(lowStock?.path).toBe("Inventory > Medicines > Stock level");
  });

  it("keeps the full navigation tree and only includes implicated cards and datasets", () => {
    const fieldHit = {
      kind: "field" as const,
      id: "medicines.days_remaining",
      name: "Days remaining",
      path: "Medicines > Days remaining",
      description: "",
      score: 1,
    };
    const result = buildMetadataContext(hospital, [fieldHit], "patients");
    expect(result.navTree).toHaveLength(hospital.pages.length);
    expect(result.pages.map((page) => page.id)).toEqual(["dashboard", "patients", "medicines"]);
    expect(result.datasets.map((dataset) => dataset.name)).toEqual(["medicines", "medicine_usage", "patients"]);
    expect(result.datasets.find((dataset) => dataset.name === "medicines")?.fields.find((field) => field.name === "days_remaining")?.derived).toBe(true);
  });
});

describe("MetadataStore", () => {
  it("caches validated metadata by tenant and app, never by app id alone", async () => {
    const { pool, query } = mockPool(async (_sql, values) => values[1] === "tenant-a"
      ? { rows: [{ metadata: hospital }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const store = createMetadataStore({ pool, llm: createFakeLlmClient() });

    expect((await store.getApp(context("tenant-a"))).appId).toBe("hospital");
    expect((await store.getApp(context("tenant-a"))).appId).toBe("hospital");
    await expect(store.getApp(context("tenant-b"))).rejects.toMatchObject({ code: "TENANT_MISMATCH" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual(["hospital", "tenant-a"]);
    expect(query.mock.calls[1]?.[1]).toEqual(["hospital", "tenant-b"]);
  });

  it("rejects invalid metadata before opening a transaction and exposes all cross-reference errors", async () => {
    const { pool } = mockPool(async () => ({ rows: [], rowCount: 0 }));
    const store = createMetadataStore({ pool, llm: createFakeLlmClient() });
    const bad = AppMetadata.parse(hospital);
    bad.pages[0]!.widgets[0]!.dataset = "missing_dataset";

    await expect(store.importApp("tenant-a", { metadata: bad })).rejects.toMatchObject({
      name: "MetadataImportValidationError",
      errors: [expect.stringContaining("unknown")],
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("imports normalized metadata, derived-free business tables, rows, and normalized embeddings in one transaction", async () => {
    const statements: string[] = [];
    const { pool, client } = mockPool(async (sql) => {
      statements.push(sql);
      if (sql.includes("FROM tenants")) return { rows: [{ id: "tenant-a" }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO applications")) return { rows: [{ id: hospital.appId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const llm = createFakeLlmClient();
    const store = createMetadataStore({ pool, llm, embed: (texts) => llm.embed(texts) });
    const result = await store.importApp("tenant-a", {
      metadata: hospital,
      data: { medicines: [{ medicine: "Example", category: "Painkiller", stock: 12, daily_usage: 2, expiry_date: "2027-01-01" }] },
    });

    expect(result.appId).toBe("hospital");
    expect(result.rowsLoaded).toBe(1);
    expect(result.embedded).toBe(buildMetadataDocuments(hospital).length);
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some((sql) => sql.includes('"app_hospital"."medicines"') && sql.includes('"stock" numeric'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('TRUNCATE TABLE "app_hospital"."medicines"'))).toBe(true);
    expect(statements.some((sql) => sql.includes("DROP SCHEMA"))).toBe(false);
    const medicineTable = statements.find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS "app_hospital"."medicines"'));
    expect(medicineTable).toBeDefined();
    expect(medicineTable).not.toContain('"days_remaining"');
    expect(statements.some((sql) => sql.includes("::vector"))).toBe(true);
    expect(llm.getRecordedCalls().filter((call) => call.type === "embed")).toHaveLength(1);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("preserves existing business rows on a metadata-only re-import", async () => {
    const statements: string[] = [];
    const { pool } = mockPool(async (sql) => {
      statements.push(sql);
      if (sql.includes("FROM tenants")) return { rows: [{ id: "tenant-a" }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO applications")) return { rows: [{ id: hospital.appId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const llm = createFakeLlmClient();
    const store = createMetadataStore({ pool, llm, embed: (texts) => llm.embed(texts) });

    await store.importApp("tenant-a", { metadata: hospital });
    expect(statements.some((sql) => sql.startsWith("TRUNCATE TABLE"))).toBe(false);
    expect(statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true);
    expect(statements.some((sql) => sql.includes("ADD COLUMN IF NOT EXISTS"))).toBe(true);
  });

  it("rolls back the transaction if embedding generation fails validation", async () => {
    const statements: string[] = [];
    const { pool } = mockPool(async (sql) => {
      statements.push(sql);
      if (sql.includes("FROM tenants")) return { rows: [{ id: "tenant-a" }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO applications")) return { rows: [{ id: hospital.appId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const invalidVectors = buildMetadataDocuments(hospital).map((_, index) =>
      index === 0 ? [1, 0] : new Array(384).fill(1));
    const llm = createFakeLlmClient({ embedQueue: [invalidVectors] });
    const store = createMetadataStore({ pool, llm, embed: (texts) => llm.embed(texts) });

    await expect(store.importApp("tenant-a", { metadata: hospital })).rejects.toThrow("exactly 384");
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("uses RRF results plus graph expansion and current-page context", async () => {
    const filter = buildMetadataDocuments(hospital).find((doc) => doc.kind === "filter" && doc.id === "stockLevel")!;
    const { pool } = mockPool(async (sql) => {
      if (sql.includes("FROM applications")) return { rows: [{ metadata: hospital }], rowCount: 1 };
      if (sql.includes("ORDER BY embedding")) {
        return {
          rows: [{
            kind: filter.kind,
            id: filter.id,
            page_id: filter.pageId,
            widget_id: null,
            name: filter.name,
            path: filter.path,
            description: filter.description,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM graph_edges")) {
        return {
          rows: [
            { src_kind: "filter", src_id: "stockLevel", rel: "filters", dst_kind: "widget", dst_id: "medicineStock" },
            { src_kind: "page", src_id: "medicines", rel: "contains", dst_kind: "filter", dst_id: "stockLevel" },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const llm = createFakeLlmClient();
    const store = createMetadataStore({ pool, llm, embed: (texts) => llm.embed(texts) });

    const hits = await store.search(context("tenant-a"), "running low", { k: 3, currentPageId: "medicines" });
    expect(hits.map((hit) => hit.id)).toContain("stockLevel");
    expect(hits.map((hit) => hit.id)).toContain("medicineStock");
    expect(hits.some((hit) => hit.kind === "page" && hit.id === "medicines")).toBe(true);
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });

  it("lists apps through a tenant-scoped query", async () => {
    const { pool, query } = mockPool(async () => ({
      rows: [{ id: "hospital", name: "Hospital Management", description: "Healthcare" }],
      rowCount: 1,
    }));
    const store = createMetadataStore({ pool, llm: createFakeLlmClient() });

    await expect(store.listApps("tenant-a")).resolves.toEqual([
      { appId: "hospital", name: "Hospital Management", description: "Healthcare" },
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual(["tenant-a"]);
  });
});

describe("metadata routes", () => {
  let activeServer: Server | undefined;

  afterEach(async () => {
    if (activeServer?.listening) {
      await new Promise<void>((resolve, reject) => activeServer!.close((error) => error ? reject(error) : resolve()));
    }
    activeServer = undefined;
  });

  it("requires admin role for import and scopes list requests to the authenticated tenant", async () => {
    const metadata = createFakeMetadataStore([{ tenantId: "tenant-a", metadata: hospital }]);
    const importSpy = vi.spyOn(metadata, "importApp");
    const router = createMetadataRouter({
      metadata,
      resolveTenantId: () => "tenant-a",
      resolveContext: (_request, appId) => ({ ...context("tenant-a", appId), role: "staff" }),
    });
    const app = express();
    app.use(express.json());
    app.use("/api/apps", router);
    activeServer = createServer(app);
    await new Promise<void>((resolve) => activeServer!.listen(0, "127.0.0.1", resolve));
    const address = activeServer.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}/api/apps`;

    const list = await fetch(baseUrl);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([{ appId: "hospital", name: hospital.name, description: hospital.description }]);

    const response = await fetch(`${baseUrl}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: hospital }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(importSpy).not.toHaveBeenCalled();
  });

  it("returns unauthorized when the server has no authenticated user", async () => {
    const metadata = createFakeMetadataStore();
    const router = createMetadataRouter({
      metadata,
      resolveTenantId: () => { throw new MetadataAuthenticationError(); },
      resolveContext: () => { throw new MetadataAuthenticationError(); },
    });
    const app = express();
    app.use("/api/apps", router);
    activeServer = createServer(app);
    await new Promise<void>((resolve) => activeServer!.listen(0, "127.0.0.1", resolve));
    const address = activeServer.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/apps`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});

describe("fake metadata store", () => {
  it("searches fixture vocabulary and returns compact context using the same contract shape", async () => {
    const store = createFakeMetadataStore([{ tenantId: "tenant-a", metadata: hospital }]);
    const hits = await store.search(context("tenant-a"), "running low", { k: 5 });
    expect(hits.some((hit) => hit.kind === "filter" && hit.id === "stockLevel")).toBe(true);
    const retrievalContext = await store.buildContext(context("tenant-a"), hits, "medicines");
    expect(retrievalContext.navTree).toHaveLength(hospital.pages.length);
    expect(retrievalContext.pages.some((page) => page.id === "medicines")).toBe(true);
  });

  it("reports tenant mismatches instead of exposing another tenant's app", async () => {
    const store = createFakeMetadataStore([{ tenantId: "tenant-a", metadata: hospital }]);
    await expect(store.getApp(context("tenant-b"))).rejects.toBeInstanceOf(MetadataStoreError);
  });
});
