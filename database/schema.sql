-- Platform schema (metadata + sessions + traces). Business data lives in per-app schemas: app_hospital, app_hotel, ...
-- Owner: P2 (metadata + vectors), P6 (users/sessions/traces). NOT yet executed in CI: first person to run `npm run db:up` fixes any typos.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY, name text NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','staff','viewer'))
);

-- One row per application. `metadata` keeps the full validated AppMetadata JSON (fast load);
-- the normalized tables below mirror it for relational queries / the knowledge graph.
CREATE TABLE IF NOT EXISTS applications (
  id text PRIMARY KEY,                       -- appId, e.g. 'hospital'
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  db_schema text NOT NULL,                   -- e.g. 'app_hospital'
  reference_date date,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS datasets (
  app_id text REFERENCES applications(id) ON DELETE CASCADE,
  name text, label text, description text, table_name text, time_field text,
  PRIMARY KEY (app_id, name)
);
CREATE TABLE IF NOT EXISTS columns (            -- dataset fields
  app_id text, dataset text, name text, label text, type text, description text,
  derived jsonb, enum_values jsonb, roles text[], synonyms text[],
  PRIMARY KEY (app_id, dataset, name),
  FOREIGN KEY (app_id, dataset) REFERENCES datasets(app_id, name) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pages (
  app_id text REFERENCES applications(id) ON DELETE CASCADE,
  id text, name text, route text, parent text, description text, icon text, allowed_roles text[],
  PRIMARY KEY (app_id, id), UNIQUE (app_id, route)
);
CREATE TABLE IF NOT EXISTS routes (             -- deep-link map; route -> page
  app_id text, route text, page_id text,
  PRIMARY KEY (app_id, route),
  FOREIGN KEY (app_id, page_id) REFERENCES pages(app_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS widgets (
  app_id text, page_id text, id text, name text, type text, description text, dataset text,
  config jsonb NOT NULL,                        -- columns, sortable, defaultSort, chart, kpi
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, page_id) REFERENCES pages(app_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS data_views (         -- widget -> dataset binding (graph edge widget -> dataset)
  app_id text, widget_id text, dataset text,
  PRIMARY KEY (app_id, widget_id),
  FOREIGN KEY (app_id, widget_id) REFERENCES widgets(app_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS filters (
  app_id text, page_id text, id text, label text, description text, type text, field text,
  operators text[], options jsonb, synonyms text[], default_value jsonb,
  PRIMARY KEY (app_id, page_id, id),
  FOREIGN KEY (app_id, page_id) REFERENCES pages(app_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS actions (
  app_id text, id text, label text, description text, page_id text, destructive boolean, required_role text, params jsonb,
  PRIMARY KEY (app_id, id)
);

-- Knowledge-graph edges (contains / supports / reads / relates_to). Loaded into NetworkX-style structures in memory if needed.
CREATE TABLE IF NOT EXISTS graph_edges (
  app_id text NOT NULL, src_kind text NOT NULL, src_id text NOT NULL,
  rel text NOT NULL, dst_kind text NOT NULL, dst_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_edges_app ON graph_edges(app_id, src_id);

-- Semantic index over metadata. 384 dims = all-MiniLM-L6-v2 (default local embeddings).
-- If you switch embedding provider, change the dimension AND re-embed everything.
CREATE TABLE IF NOT EXISTS metadata_embeddings (
  app_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind text NOT NULL,                           -- page|widget|filter|field|dataset|action
  id text NOT NULL,
  page_id text, widget_id text,
  name text NOT NULL, path text NOT NULL, description text NOT NULL,
  doc text NOT NULL,                            -- text that was embedded
  embedding vector(384) NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', doc)) STORED,
  PRIMARY KEY (app_id, kind, id)
);
CREATE INDEX IF NOT EXISTS metadata_embeddings_tsv ON metadata_embeddings USING gin(tsv);
CREATE INDEX IF NOT EXISTS metadata_embeddings_vec ON metadata_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY, user_id uuid REFERENCES users(id), app_id text REFERENCES applications(id),
  memory jsonb NOT NULL DEFAULT '{}'::jsonb, ui_state jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_traces (
  trace_id text PRIMARY KEY, session_id text, app_id text, user_id text,
  created_at timestamptz DEFAULT now(), status text, latency_ms int, trace jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_traces_app ON agent_traces(app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_runs (
  run_id text PRIMARY KEY, created_at timestamptz DEFAULT now(), report jsonb NOT NULL
);

-- Dev-only demo tenants and seeded user accounts. These are intentionally safe, local-only defaults for the hackathon demo.
INSERT INTO tenants (id, name) VALUES
  ('tenant-a', 'Hospital Demo'),
  ('tenant-b', 'Hotel Demo')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO users (tenant_id, email, password_hash, role) VALUES
  ('tenant-a', 'admin@hospital.demo', '$2a$10$Qfj50DEVqxGEdfpgZXr9MuVeDHS5Kl8Yp8pkcEDjoJTybOBHhQU1W', 'admin'),
  ('tenant-a', 'staff@hospital.demo', '$2a$10$y.i4SWH6ExibMt4hfgUh/ugzyJmXJl8t5XvnXHJYG1QfVvB0KUQQ.', 'staff'),
  ('tenant-a', 'viewer@hospital.demo', '$2a$10$OGN7NXRxjBI2Wq2ZuAnqjOqC3k3.IPSLcNPT/qsfEYuSl2RgxYqUa', 'viewer'),
  ('tenant-b', 'admin@hotel.demo', '$2a$10$LUOtDg0hQOJjofxGrICBSu.ddicoL7sz6glN/LsRXeVL1Y3z.fiaO', 'admin'),
  ('tenant-b', 'staff@hotel.demo', '$2a$10$nh7NIv0Z9nR/oRqj/k9wOeF8NXYJwZlHArebeSFB70Nk.ta8fHFVG', 'staff'),
  ('tenant-b', 'viewer@hotel.demo', '$2a$10$/uDMYLrL945yhb66Tli9Ku5ZB56kQEiU3uNlpZKzYsYCmdA8ipP3K', 'viewer')
ON CONFLICT (email) DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  password_hash = EXCLUDED.password_hash,
  role = EXCLUDED.role;
