import {
  AppMetadata,
  DbName,
  ImportBundle,
  validateAppMetadata,
  type Dataset,
  type RequestContext,
  type MetadataStore,
  type LlmClient,
} from "@cab/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { buildMetadataContext, buildMetadataDocuments, type MetadataDocument } from "./documents";
import { embed as localEmbed, normalizeEmbedding, searchMetadata, type TextEmbedder } from "../retrieval";

const MAX_IDENTIFIER_BYTES = 63;
const CACHE_SEPARATOR = "\u0000";

export class MetadataStoreError extends Error {
  constructor(
    message: string,
    readonly code: "APP_NOT_FOUND" | "TENANT_MISMATCH" | "INVALID_METADATA" | "DATABASE_ERROR",
  ) {
    super(message);
    this.name = "MetadataStoreError";
  }
}

export class MetadataImportValidationError extends MetadataStoreError {
  constructor(readonly errors: string[]) {
    super(`Metadata import rejected: ${errors.join("; ")}`, "INVALID_METADATA");
    this.name = "MetadataImportValidationError";
  }
}

interface AppRow extends QueryResultRow {
  metadata: unknown;
}

interface AppListRow extends QueryResultRow {
  id: string;
  name: string;
  description: string;
}

function quoteIdentifier(identifier: string): string {
  if (!DbName.safeParse(identifier).success || Buffer.byteLength(identifier, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new MetadataImportValidationError([`Unsafe or overlong database identifier: ${identifier}`]);
  }
  return `"${identifier}"`;
}

function appSchemaName(appId: string): string {
  const schema = `app_${appId}`;
  quoteIdentifier(schema);
  return schema;
}

function postgresType(type: Dataset["fields"][number]["type"]): string {
  switch (type) {
    case "string": return "text";
    case "number": return "numeric";
    case "date": return "date";
    case "boolean": return "boolean";
  }
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => (Object.is(value, -0) ? "0" : String(value))).join(",")}]`;
}

async function insertEmbeddings(
  client: PoolClient,
  appId: string,
  documents: MetadataDocument[],
  vectors: number[][],
): Promise<void> {
  for (let start = 0; start < documents.length; start += 200) {
    const values: unknown[] = [];
    const tuples = documents.slice(start, start + 200).map((document, index) => {
      const vector = vectors[start + index]!;
      const row = [
        appId,
        document.kind,
        document.id,
        document.pageId ?? null,
        document.widgetId ?? null,
        document.name,
        document.path,
        document.description,
        document.doc,
        vectorLiteral(vector),
      ];
      const marks = row.map((value, valueIndex) => {
        values.push(value);
        const marker = `$${values.length}`;
        return valueIndex === 9 ? `${marker}::vector` : marker;
      });
      return `(${marks.join(", ")})`;
    });
    await client.query(
      `INSERT INTO metadata_embeddings (app_id, kind, id, page_id, widget_id, name, path, description, doc, embedding)
       VALUES ${tuples.join(", ")}`,
      values,
    );
  }
}

export function validateImportBundle(bundleValue: ImportBundle): ImportBundle {
  const parsed = ImportBundle.safeParse(bundleValue);
  if (!parsed.success) {
    throw new MetadataImportValidationError(parsed.error.issues.map((issue) => {
      const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    }));
  }

  const errors = validateAppMetadata(parsed.data.metadata);
  const tableNames = new Set<string>();
  const actionIds = new Set<string>();
  for (const dataset of parsed.data.metadata.datasets) {
    if (tableNames.has(dataset.table)) errors.push(`duplicate dataset table: ${dataset.table}`);
    tableNames.add(dataset.table);
    if (!dataset.fields.some((field) => field.derived === undefined)) {
      errors.push(`dataset ${dataset.name} must have at least one non-derived field`);
    }
  }
  for (const action of parsed.data.metadata.actions) {
    if (actionIds.has(action.id)) errors.push(`duplicate action id: ${action.id}`);
    actionIds.add(action.id);
  }

  const datasetNames = new Set(parsed.data.metadata.datasets.map((dataset) => dataset.name));
  for (const dataName of Object.keys(parsed.data.data ?? {})) {
    if (!datasetNames.has(dataName)) errors.push(`data provided for unknown dataset: ${dataName}`);
  }
  for (const dataset of parsed.data.metadata.datasets) {
    const rows = parsed.data.data?.[dataset.name] ?? [];
    const storedFields = new Map(dataset.fields.filter((field) => field.derived === undefined).map((field) => [field.name, field]));
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      for (const [fieldName, value] of Object.entries(row)) {
        const field = storedFields.get(fieldName);
        if (!field) {
          errors.push(`${dataset.name} row ${rowIndex + 1}: unknown or derived field ${fieldName}`);
          continue;
        }
        if (value === null || value === undefined) continue;
        const valid = field.type === "string"
          ? typeof value === "string"
          : field.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : field.type === "boolean"
              ? typeof value === "boolean"
              : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
                !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
                new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
        if (!valid) errors.push(`${dataset.name} row ${rowIndex + 1}: ${fieldName} is not a valid ${field.type}`);
      }
    }
  }
  appSchemaName(parsed.data.metadata.appId);
  if (errors.length) throw new MetadataImportValidationError(errors);
  return parsed.data;
}

function filterNodeId(app: AppMetadata, pageId: string, filterId: string): string {
  const matches = app.pages.flatMap((page) => page.filters.filter((filter) => filter.id === filterId));
  return matches.length > 1 ? `${pageId}.${filterId}` : filterId;
}

function buildGraphEdges(app: AppMetadata): Array<[string, string, string, string, string]> {
  const edges: Array<[string, string, string, string, string]> = [];
  const add = (srcKind: string, srcId: string, relation: string, dstKind: string, dstId: string) => {
    edges.push([srcKind, srcId, relation, dstKind, dstId]);
  };

  for (const page of app.pages) {
    add("app", app.appId, "contains", "page", page.id);
    if (page.parent) add("page", page.parent, "parent_of", "page", page.id);

    for (const widget of page.widgets) {
      add("page", page.id, "contains", "widget", widget.id);
      add("widget", widget.id, "reads", "dataset", widget.dataset);
    }

    for (const filter of page.filters) {
      const id = filterNodeId(app, page.id, filter.id);
      add("page", page.id, "contains", "filter", id);
      for (const dataset of app.datasets) {
        if (!dataset.fields.some((field) => field.name === filter.field)) continue;
        const fieldId = `${dataset.name}.${filter.field}`;
        add("field", fieldId, "supports", "filter", id);
        for (const widget of page.widgets) {
          if (widget.dataset === dataset.name) add("filter", id, "filters", "widget", widget.id);
        }
      }
    }
  }

  for (const dataset of app.datasets) {
    for (const field of dataset.fields) add("dataset", dataset.name, "contains", "field", `${dataset.name}.${field.name}`);
    for (const relation of dataset.relations) {
      add("dataset", dataset.name, "relates_to", "dataset", relation.toDataset);
      add("field", `${dataset.name}.${relation.field}`, "relates_to", "field", `${relation.toDataset}.${relation.toField}`);
    }
  }

  return edges;
}

function insertValues(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<unknown> {
  if (!rows.length) return Promise.resolve();
  const quotedColumns = columns.map(quoteIdentifier).join(", ");
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const marks = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${marks.join(", ")})`;
  });
  return client.query(`INSERT INTO ${table} (${quotedColumns}) VALUES ${tuples.join(", ")}`, values);
}

async function loadRows(client: PoolClient, schema: string, dataset: Dataset, rows: Array<Record<string, unknown>>): Promise<number> {
  if (!rows.length) return 0;
  const fields = dataset.fields.filter((field) => field.derived === undefined);
  const table = `${quoteIdentifier(schema)}.${quoteIdentifier(dataset.table)}`;
  const batchSize = Math.max(1, Math.floor(30_000 / fields.length));
  for (let start = 0; start < rows.length; start += batchSize) {
    const chunk = rows.slice(start, start + batchSize);
    const values = chunk.map((row) => fields.map((field) => row[field.name] ?? null));
    await insertValues(client, table, fields.map((field) => field.name), values);
  }
  return rows.length;
}

async function replaceNormalizedMetadata(client: PoolClient, tenantId: string, app: AppMetadata): Promise<void> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO applications (id, tenant_id, name, description, db_schema, reference_date, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description, db_schema = EXCLUDED.db_schema,
       reference_date = EXCLUDED.reference_date, metadata = EXCLUDED.metadata
     WHERE applications.tenant_id = EXCLUDED.tenant_id
     RETURNING id`,
    [app.appId, tenantId, app.name, app.description, appSchemaName(app.appId), app.referenceDate ?? null, JSON.stringify(app)],
  );
  if (result.rowCount !== 1) {
    throw new MetadataStoreError(`Application ${app.appId} belongs to another tenant`, "TENANT_MISMATCH");
  }

  await client.query("DELETE FROM metadata_embeddings WHERE app_id = $1", [app.appId]);
  await client.query("DELETE FROM graph_edges WHERE app_id = $1", [app.appId]);
  await client.query("DELETE FROM actions WHERE app_id = $1", [app.appId]);
  await client.query("DELETE FROM pages WHERE app_id = $1", [app.appId]);
  await client.query("DELETE FROM datasets WHERE app_id = $1", [app.appId]);

  for (const dataset of app.datasets) {
    await client.query(
      `INSERT INTO datasets (app_id, name, label, description, table_name, time_field)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [app.appId, dataset.name, dataset.label, dataset.description, dataset.table, dataset.timeField ?? null],
    );
    for (const field of dataset.fields) {
      await client.query(
        `INSERT INTO columns (app_id, dataset, name, label, type, description, derived, enum_values, roles, synonyms)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
        [
          app.appId, dataset.name, field.name, field.label, field.type, field.description,
          field.derived === undefined ? null : JSON.stringify(field.derived),
          field.enumValues === undefined ? null : JSON.stringify(field.enumValues),
          field.roles, field.synonyms,
        ],
      );
    }
  }

  for (const page of app.pages) {
    await client.query(
      `INSERT INTO pages (app_id, id, name, route, parent, description, icon, allowed_roles)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [app.appId, page.id, page.name, page.route, page.parent, page.description, page.icon ?? null, page.allowedRoles ?? null],
    );
    await client.query("INSERT INTO routes (app_id, route, page_id) VALUES ($1, $2, $3)", [app.appId, page.route, page.id]);

    for (const widget of page.widgets) {
      await client.query(
        `INSERT INTO widgets (app_id, page_id, id, name, type, description, dataset, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [app.appId, page.id, widget.id, widget.name, widget.type, widget.description, widget.dataset, JSON.stringify(widget)],
      );
      await client.query("INSERT INTO data_views (app_id, widget_id, dataset) VALUES ($1, $2, $3)", [app.appId, widget.id, widget.dataset]);
    }

    for (const filter of page.filters) {
      await client.query(
        `INSERT INTO filters (app_id, page_id, id, label, description, type, field, operators, options, synonyms, default_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)`,
        [
          app.appId, page.id, filter.id, filter.label, filter.description, filter.type, filter.field,
          filter.operators ?? null, JSON.stringify(filter.options ?? []), filter.synonyms,
          filter.defaultValue === undefined ? null : JSON.stringify(filter.defaultValue),
        ],
      );
    }
  }

  for (const action of app.actions) {
    await client.query(
      `INSERT INTO actions (app_id, id, label, description, page_id, destructive, required_role, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [app.appId, action.id, action.label, action.description, action.pageId ?? null, action.destructive, action.requiredRole, JSON.stringify(action.params)],
    );
  }

  const edges = buildGraphEdges(app);
  const edgeRows = edges.map(([srcKind, srcId, relation, dstKind, dstId]) => [
    app.appId, srcKind, srcId, relation, dstKind, dstId,
  ]);
  for (let start = 0; start < edgeRows.length; start += 1000) {
    await insertValues(
      client,
      "graph_edges",
      ["app_id", "src_kind", "src_id", "rel", "dst_kind", "dst_id"],
      edgeRows.slice(start, start + 1000),
    );
  }
}

function safeRows(bundle: ImportBundle, dataset: Dataset): Array<Record<string, unknown>> {
  return bundle.data?.[dataset.name] ?? [];
}

export interface MetadataStoreOptions {
  pool: Pool;
  llm: LlmClient;
  embed?: TextEmbedder;
}

export function createMetadataStore({ pool, embed: embedTexts = localEmbed }: MetadataStoreOptions): MetadataStore {
  const cache = new Map<string, AppMetadata>();
  const cacheKey = (tenantId: string, appId: string) => `${tenantId}${CACHE_SEPARATOR}${appId}`;

  async function loadApp(ctx: RequestContext): Promise<AppMetadata> {
    const key = cacheKey(ctx.tenantId, ctx.appId);
    const cached = cache.get(key);
    if (cached) return AppMetadata.parse(cached);

    const result = await pool.query<AppRow>(
      "SELECT metadata FROM applications WHERE id = $1 AND tenant_id = $2",
      [ctx.appId, ctx.tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new MetadataStoreError(`Application ${ctx.appId} is not available to this tenant`, "TENANT_MISMATCH");
    const raw = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
    const app = AppMetadata.parse(raw);
    if (app.appId !== ctx.appId) {
      throw new MetadataStoreError(`Stored metadata appId does not match ${ctx.appId}`, "INVALID_METADATA");
    }
    const errors = validateAppMetadata(app);
    if (errors.length) throw new MetadataImportValidationError(errors);
    cache.set(key, app);
    return AppMetadata.parse(app);
  }

  return {
    async getApp(ctx) {
      return loadApp(ctx);
    },

    async listApps(tenantId) {
      const result = await pool.query<AppListRow>(
        "SELECT id, name, description FROM applications WHERE tenant_id = $1 ORDER BY name, id",
        [tenantId],
      );
      return result.rows.map((row) => ({ appId: row.id, name: row.name, description: row.description }));
    },

    async importApp(tenantId, bundleValue) {
      const bundle = validateImportBundle(bundleValue);
      const app = AppMetadata.parse(bundle.metadata);
      const schema = appSchemaName(app.appId);
      const documents = buildMetadataDocuments(app);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tenant = await client.query<{ id: string }>("SELECT id FROM tenants WHERE id = $1 FOR KEY SHARE", [tenantId]);
        if (!tenant.rowCount) throw new MetadataStoreError(`Tenant ${tenantId} does not exist`, "TENANT_MISMATCH");

        await replaceNormalizedMetadata(client, tenantId, app);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);

        for (const dataset of app.datasets) {
          const storedFields = dataset.fields.filter((field) => field.derived === undefined);
          const definitions = storedFields.map((field) => `${quoteIdentifier(field.name)} ${postgresType(field.type)}`);
          const table = `${quoteIdentifier(schema)}.${quoteIdentifier(dataset.table)}`;
          await client.query(
            `CREATE TABLE IF NOT EXISTS ${table} (${definitions.join(", ")})`,
          );
          for (const field of storedFields) {
            const column = quoteIdentifier(field.name);
            const sqlType = postgresType(field.type);
            await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${sqlType}`);
            await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${sqlType} USING ${column}::${sqlType}`);
          }
        }

        let rowsLoaded = 0;
        for (const dataset of app.datasets) {
          if (bundle.data && Object.hasOwn(bundle.data, dataset.name)) {
            await client.query(`TRUNCATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(dataset.table)}`);
            rowsLoaded += await loadRows(client, schema, dataset, safeRows(bundle, dataset));
          }
        }

        const vectors = await embedTexts(documents.map((document) => document.doc));
        if (vectors.length !== documents.length) {
          throw new Error(`Embedding provider returned ${vectors.length} vectors for ${documents.length} metadata documents`);
        }
        const normalizedVectors = vectors.map((vector, index) => normalizeEmbedding(vector, `Embedding ${index + 1}`));
        await insertEmbeddings(client, app.appId, documents, normalizedVectors);

        await client.query("COMMIT");
        cache.delete(cacheKey(tenantId, app.appId));
        return {
          appId: app.appId,
          pages: app.pages.length,
          widgets: app.pages.reduce((count, page) => count + page.widgets.length, 0),
          filters: app.pages.reduce((count, page) => count + page.filters.length, 0),
          datasets: app.datasets.length,
          embedded: documents.length,
          rowsLoaded,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async search(ctx, query, opts = {}) {
      const app = await loadApp(ctx);
      return searchMetadata(pool, embedTexts, ctx, app, query, opts);
    },

    async buildContext(ctx, hits, currentPageId) {
      const app = await loadApp(ctx);
      return buildMetadataContext(app, hits, currentPageId);
    },
  };
}
