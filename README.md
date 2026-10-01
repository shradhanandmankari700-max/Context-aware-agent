# Context-Aware Application Agent

> A natural-language agent that **understands a no-code business app from its metadata**, **operates it** (navigate, filters, dates, sort), **queries and analyzes its data**, **verifies the result on screen**, and **works on an app it has never seen** — by importing metadata, not by changing code.

Hackathon demo: **Wed 7 Oct 2026**. Build window: **Wed 30 Sep → Tue 6 Oct** (7 days, 6 people).

---

## 0. Read this first (2 minutes)

1. Clone, `npm install`, `cp .env.example .env`, `npm run typecheck && npm test` must pass **before you write anything**.
2. Open `docs/AI_PROMPTS.md`, find **your** prompt (P1–P6), paste the shared preamble + your prompt into your AI assistant.
3. You only edit **your own folders** (section 9). The `contracts/` folder is shared law — never edit it alone.
4. Ship a `fake.ts` for your module by **end of Day 2**, so nobody is blocked waiting for you.

**What is verified in this kit (I ran these):** `npm install` from a clean checkout, `tsc` typecheck, 9 contract tests (metadata fixtures, deep-link round-trip, date tokens, UI-state diff, tool-call validation), the metadata CLI on both fixtures, and the backend booting and importing `@cab/contracts`.
**Scripts that exist as wiring but whose target file is yours to create:** `npm run seed` (P1 → `data/seed/index.ts`), `npm run import:app` (P2 → `backend/src/metadata/cli.ts`), `npm run eval` / `npm run smoke` (P6 → `evaluation/src/run.ts`, `smoke.ts`).
**What is NOT verified:** `database/schema.sql` and `docker-compose.yml` have not been executed (no Docker/Postgres in my sandbox). The first person to run `npm run db:up` should fix any typo and push. Everything else (agent, UI, retrieval, queries) is yours to build — this kit gives you the skeleton and the rules that stop it breaking.

---

## 1. Verdict on the Master Prompt

**The prompt is correct in intent and covers the challenge.** It is a good *product spec*. It was written as one instruction for one AI building sequentially, so for a 6-person, 7-day build it was missing the things that stop six people's code from colliding. What I changed or added:

| # | Gap / problem in the prompt | What this kit does about it |
|---|---|---|
| 1 | **No shared contracts.** Six people would each invent their own JSON shapes. | `contracts/` (zod schemas + TS types + interfaces), tested. One source of truth. |
| 2 | **Who owns UI state is undefined.** "Read current UI state" and "verify" need a real answer. | **UI state = the URL.** Backend pushes `ui_action` over SSE; frontend applies and **reports back its actual state**; verification compares expected vs reported (section 5). |
| 3 | **Generality needs a metadata-driven frontend.** The prompt describes Hospital pages in the UI, which would hard-code them. | Frontend is a **generic renderer** (nav, tables, charts, KPIs, filters all from metadata). Hospital and Hotel are just two JSON files. |
| 4 | "Low stock", "run out in 2 days", "available tomorrow" need **derived fields and filter presets** in metadata. | `derived` expressions (e.g. `days_remaining = stock / daily_usage`), `FilterOption.where` presets, a numeric `daysRemaining` filter. No raw SQL in metadata. |
| 5 | **Unseen-app import** needs business data too, not just metadata. | `ImportBundle = metadata + optional rows`; importer creates `app_<id>` schema tables from dataset fields. |
| 6 | **Relative dates** ("tomorrow", "this month") are an LLM hallucination trap. | Closed `DateToken` set resolved **only by code** against a fixed demo clock `DEMO_NOW=2026-10-07`. |
| 7 | "Compare this month with last month" on 7 Oct compares **7 days vs 30 days** — misleading. | Token `last_month_to_date`, `periods.note` in `AnalysisResult`, narrator must mention partial periods. |
| 8 | **No eval without a browser.** KPIs must be measurable in CI. | `UiAdapter` has 3 implementations: `api` (real), `simulated` (eval/CI), `playwright` (fallback). |
| 9 | KPIs listed but **no data formats** for corpus/report. | `EvalCase`, `RetrievalCase`, `KpiReport` schemas + dashboard reads `KpiReport` directly. |
| 10 | LangGraph adds learning cost and risk in 7 days. | Plain bounded loop (max 4 iterations). Prompt allows "lightweight tool-calling". |
| 11 | Free LLM quotas can kill a demo. "No fake responses" conflicts with response caching. | Provider-agnostic `LlmClient`, fallback provider, **disk cache of real model outputs**, every trace records `cachedCalls`. Cache is real output, not fabricated; set `LLM_CACHE=off` for a live demo if internet is good, and say so honestly if asked. |
| 12 | **Faithfulness is a KPI but nothing enforces it.** | Narrator returns `resultId` references; **code fills the numbers**; a `checkFaithfulness` pass verifies every number in the text exists in evidence. |
| 13 | Failure demo is "make a filter unavailable" with no mechanism. | UI state carries `disabledFilters`; debug-panel toggle in the frontend simulates it; adapter returns `FILTER_UNAVAILABLE` → agent recovers (section 14). |
| 14 | Auth/multi-tenant/Playwright/Docker are all in scope and can eat the schedule. | **Priority tiers + cut order** (section 12). |
| 15 | Scale KPI ("hundreds of pages") needs data you don't have. | Scale generator (P2) produces 100/300/1000-page synthetic apps for the retrieval curve. |

---

## 2. What we're building (the pitch in 5 lines)

* **Compiled-from-schema agent.** The LLM can only emit tool calls that type-check against the app's own metadata. An invented page, filter or value is rejected *before* anything runs, and the agent re-plans. → near-zero action hallucination.
* **Numbers come from code, words come from the LLM.** Every number in an answer has a clickable provenance chip (widget + query).
* **Verified actions.** After acting, the agent reads back the *real* UI state and compares. It never claims success it didn't observe. It recovers when something fails.
* **Zero-code onboarding.** Upload another app's metadata (+ data) → graph, vector index and tools are live. Same agent code.
* **Self-measuring.** Eval harness produces the KPI dashboard from real runs, including a retrieval-at-scale curve.

---

## 3. Stack decisions (final — don't re-debate)

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript** strict, everywhere | Shared contracts between front and back |
| Backend | Node 20 + Express | Matches master prompt |
| DB | **Postgres 16 + pgvector** (`pgvector/pgvector:pg16` in Docker) | One DB for metadata, vectors, business data, traces |
| Orchestration | **Own bounded loop**, no LangGraph | Fewer moving parts |
| LLM | Wrapper `LlmClient`; **Gemini free tier** default; Groq/OpenRouter fallback; Ollama offline | Free; swap by env var |
| LLM output | JSON validated by zod (native function-calling optional) | Works on weaker free models |
| Embeddings | **Local** `all-MiniLM-L6-v2` via `@huggingface/transformers` (384-d) | No quota, deterministic |
| Retrieval | Hybrid: pgvector cosine + Postgres full-text, fused with RRF, then graph expansion (widget→page→filters) | Precision at scale |
| Frontend | React + Vite + Tailwind + Recharts + React Router | Matches master prompt |
| Live updates | SSE (backend→UI) + `POST /api/ui-state/report` (UI→backend) | Simplest two-way |
| Fallback exec | Playwright driving the real frontend via `data-testid` | Required by the challenge, secondary |
| Tests | vitest (+ eval harness) | Fast |

Docker note: only the **database** runs in Docker for dev. Backend and frontend run natively (`npm run dev:*`) — faster reload and far lighter on 8 GB laptops. If Docker is a problem on someone's laptop, use a free hosted Postgres with pgvector (Neon/Supabase) and set `DATABASE_URL`; schema is the same.

---

## 4. Architecture

```
 Browser (React)                                   Backend (Express)
┌─────────────────────────────┐   POST /api/agent/chat   ┌────────────────────────────────────────────┐
│ Generic app renderer        │ ───────────────────────► │ agent/  (P3)                               │
│  sidebar · tables · charts  │                          │  1 context   2 retrieve ──► metadata/ (P2) │
│  filters · KPI cards        │ ◄── SSE ui_action ────── │  3 plan (LLM→AgentTurn JSON)               │
│ Companion chat panel        │ ── POST ui-state/report ►│  4 validate vs metadata   5 policy gate    │
│ Debug panel · Eval page     │                          │  6 execute ─► tools/ (P4)                  │
└─────────────────────────────┘                          │       ├─ ui/ adapter (api|simulated|pw)    │
   URL = UI state                                        │       ├─ data/ query engine (P1)           │
                                                         │       └─ analytics/ (P1)                   │
                                                         │  7 verify UI   8 narrate   9 trace (P6)    │
                                                         └───────────────┬────────────────────────────┘
                                                                         ▼
                                      Postgres: platform tables + pgvector + app_hospital / app_hotel schemas
```

### Request lifecycle (the exact flow — Test 1: "Show low-stock medicines")

1. Frontend `POST /api/agent/chat {sessionId, appId, message, uiState}`.
2. **P3** loads session memory + app metadata (cached) + actual UI state. Emits SSE `agent_status: retrieving`.
3. **P2** `search(ctx, message + recent context, k=8)` → hits; `buildContext` → compact `RetrievalContext` (nav tree + only the relevant pages/filters/datasets).
4. **P3** planner LLM → `AgentTurn { steps:[navigate("medicines"), set_filter(stockLevel, eq, "low")], done:false }`.
5. **P3 validator** checks every step against metadata: page exists, filter exists on that page, op allowed for filter type, enum value in options, user role allowed. Invalid → error list back to the planner (max 2 retries). Counts `invalidActionsBlocked`.
6. **Policy gate:** `read`/`action` tools run; `destructive` tools stop with `needs_confirmation`.
7. **P4** `tools.execute` → `UiAdapter.dispatch` → SSE `ui_action` → frontend applies it → frontend `POST /ui-state/report {actionId, state}` → `awaitAck` resolves.
8. **Verify:** `diffUiState(expected, actual)`. Mismatch/rejected → recovery (section 14). Result recorded in `Verification`.
9. Planner iteration 2 (observations in prompt): `get_widget_data(medicineStock)` → rows via **P1** `widgetData` (same compile path the screen uses) → `done:true`.
10. **Narrator** LLM gets observations only → `NarratorOutput` with `resultId` refs → **P3 assembler** builds `AnswerBlock[]` with real numbers + provenance → `checkFaithfulness`.
11. **P6** persists the `Trace`. Response `AgentResponse` returned; frontend shows blocks, steps, deep link, undo.

---

## 5. UI state, sync protocol and verification (the part most likely to break — read twice)

* **UI state is the URL.** `/inventory/medicines?f.stockLevel=eq:low&f.daysRemaining=lte:2&sort=medicineStock:stock:asc`.
  Frontend derives `UiState` **only** from route + query string (`fromDeepLink`), and every UI change updates the URL (`toDeepLink`). Deep links, undo (browser back) and verification all fall out of this one rule.
* **Backend → frontend:** SSE `GET /api/events?sessionId=…&token=<jwt>` (EventSource can't set headers). Events: `hello`, `ui_action`, `agent_status`, `agent_step`.
* **Frontend → backend:** `POST /api/ui-state/report` with `{sessionId, actionId?, state, rejected?}`:
  * after **every** state change (user or agent), and
  * after applying/rejecting a `ui_action` (echo `actionId`).
* **Verification** = backend waits (`awaitAck`, 3 s) for the report carrying `actionId`, then `diffUiState(expected, report.state)`.
* **Simulated adapter** (`UI_ADAPTER=simulated`) implements the same interface in memory, applying actions to a state object. Eval/CI use it, so KPIs are measurable without a browser. **The real and simulated adapters must behave identically** — P4 owns that parity test.
* **Playwright adapter** drives the real frontend: needs stable `data-testid`s that P5 must emit from metadata: `nav-<pageId>`, `filter-<filterId>`, `filter-<filterId>-option-<value>`, `sort-<widgetId>-<field>`, `widget-<widgetId>`, `row-<widgetId>-<key>`, `chat-input`, `chat-send`.

---

## 6. Contracts (in `contracts/src/`, tested)

| File | Defines | Used by |
|---|---|---|
| `common.ts` | `Id`, `DbName`, `Op`, `Agg`, `Grain`, `DateToken`, `Condition`, `FilterValue` | all |
| `dates.ts` | `resolveDateToken`, `normalizeDateValue` (UTC, Monday weeks, demo clock) | P1, P3, P4 |
| `metadata.ts` | `AppMetadata`, `Dataset`, `DatasetField` (+`derived`), `Page`, `Widget`, `Filter` (+`options.where`), `AppAction`, `ImportBundle` | P1–P5 |
| `metadataCheck.ts` | `validateAppMetadata` (cross-reference checks) | P2 importer, CI |
| `helpers.ts` | `getPage/getWidget/getFilter/pagePath/defaultOps` | P2, P3, P4 |
| `uiState.ts` | `UiState`, `toDeepLink`, `fromDeepLink`, `diffUiState` | P3, P4, P5, P6 |
| `actions.ts` | `UiAction` (what reaches the frontend) | P4, P5 |
| `query.ts` | `QuerySpec/QueryResult`, `AnalysisSpec/AnalysisResult` | P1, P3, P4 |
| `retrieval.ts` | `RetrievalHit`, `RetrievalContext` | P2, P3 |
| `tools.ts` | `ToolCall` (the only LLM-emittable calls), `AgentTurn`, `ToolResult`, `ErrorCode`, `TOOL_KIND` | P3, P4 |
| `chat.ts` | `ChatRequest`, `AgentResponse`, `AnswerBlock`, `NarratorOutput`, `StepRecord`, `Verification`, `ConversationMemory`, `SseEvent`, `UiStateReport`, `Trace` | P3, P5, P6 |
| `services.ts` | Interfaces: `MetadataStore`, `DataService`, `AnalyticsService`, `UiAdapter`, `LlmClient`, `TraceStore`, `ToolRegistry`, `AgentService`, `Services` | everyone |
| `eval.ts` | `EvalCase`, `RetrievalCase`, `KpiReport` | P6, P2, P5 |

**Change protocol:** need a contract change → post in the group chat → one PR touching only `contracts/` → all 6 thumbs-up → merge → everyone `git pull` immediately. Additive changes (new optional field) are cheap; renames are expensive — avoid. **Freeze v1 tonight (Day 1).**

### Metadata model in one example

```jsonc
// field with derived value (no SQL):  days_remaining = round(stock / daily_usage, 1)
{ "name": "days_remaining", "type": "number", "derived": { "op": "round", "args": [{ "op": "div", "args": ["stock","daily_usage"] }, 1] } }

// filter with presets:  "low" means days_remaining < 5
{ "id": "stockLevel", "type": "enum", "field": "days_remaining",
  "options": [{ "value": "low", "synonyms": ["running low"], "where": [{ "field": "days_remaining", "op": "lt", "value": 5 }] }] }

// numeric filter so the agent can say "within two days" without any special code
{ "id": "daysRemaining", "type": "number", "field": "days_remaining", "operators": ["lt","lte","gt","gte","between"] }
```

`metadata/hospital.json` and `metadata/hotel.json` are complete, validated fixtures — everyone codes against them from minute 1. P2 extends them; run `npm run check:metadata -- ../metadata/hospital.json` after editing.

---

## 7. Demo data specification (P1 builds exactly this; the demo story depends on it)

All dates relative to `DEMO_NOW = 2026-10-07`. Generate **120 days** of history. Fixed random seed so data is identical on every laptop.

**Hospital — `medicines`** (keep the 4 given rows, add ~20 more):

| medicine | category | stock | daily_usage | days_remaining | stockLevel |
|---|---|---|---|---|---|
| Paracetamol | Painkiller | 120 | 20 | 6.0 | medium |
| Amoxicillin | Antibiotic | 12 | 15 | **0.8** | **low** |
| Insulin | Diabetes | 5 | 8 | **0.6** | **low** |
| Azithromycin | Antibiotic | 80 | 10 | 8.0 | medium |
| Metformin | Diabetes | 18 | 6 | **3.0** | **low** |
| Salbutamol | Respiratory | 30 | 8 | **3.8** | **low** |

Designed so the 3-step demo works: step 2 "low stock" → 4 medicines; step 4 "may run out within two days" (`days_remaining <= 2`) narrows to **Amoxicillin + Insulin** — the filter visibly changes the result. Add ≥ 16 more medicines with days_remaining ≥ 5 across all categories.

**Planted causes (so "why are these low?" has a truthful, data-backed answer):**
* **Amoxicillin:** daily usage ≈ 9/day until 2026-09-22, then ≈ 15/day (≈ +60% in the last 14 days vs the 14 before). `prescriptions` for Amoxicillin with diagnosis *Respiratory infection* rise in the same window. Last `purchases` row: 2026-08-28, qty 60 (usual orders: 150), status Delivered.
* **Insulin:** usage flat ≈ 8/day all 120 days. Last purchase 2026-08-20 (qty 100); **no order since** (48 days) → replenishment gap, not demand.
* **Metformin / Salbutamol:** small, unexplained dips; the agent must say evidence is insufficient for these.
* Include `stock_history` so stock decline is visible, and a few `Delayed` purchase orders for other medicines.

**Hospital also needs:** ~40 `patients`, `purchases` (~60), `prescriptions` (~600), `medicine_usage` (daily × medicine × 120 days).
**Test 3 ("compare this month's usage with last month"):** `this_month` = 1–7 Oct (7 days). Seed so month-to-date vs `last_month_to_date` (1–7 Sep) is a meaningful comparison.

**Hotel — `room_availability`** (one row per room per night, next 30 days + 120 days history): ~12 rooms; include the 4 given (101 Deluxe 2500, 102 Suite 4500, 103 Deluxe 2800, 104 Standard 1800) plus 105 Standard 2200 and others. **Designed so the date matters:** on 2026-10-07 rooms 101, 102, 104, 105 are Available; on **2026-10-08 (tomorrow) room 101 is Occupied**. Expected answer to *"available rooms under ₹3000 for tomorrow"*: **104, 105** (+ any other seeded Standard/Deluxe < 3000 that are free), **not 101**.
**Revenue story ("why did revenue decrease?"):** September total revenue ≈ −12% vs August; **Room Bookings ≈ −18%**, others roughly flat. In `bookings`, September has noticeably more `Cancelled` rows (especially channel `OTA`) and `occupancy_history` is lower on weekdays. Narrator may state only what the data shows.
Seed `revenue` daily by category for ≥ 120 days, `bookings` (~400).

---

## 8. HTTP API (owner in brackets). Auth: `Authorization: Bearer <jwt>` (SSE: `?token=`).

| Method & path | Body → Response | Owner |
|---|---|---|
| `POST /api/auth/login` | `{email,password}` → `{token,user:{id,tenantId,role}}` | P6 |
| `GET /api/health` | `{ok:true}` | P6 |
| `GET /api/apps` | → `[{appId,name,description}]` (tenant-scoped) | P2 |
| `GET /api/apps/:appId/metadata` | → `AppMetadata` | P2 |
| `POST /api/apps/import` (admin) | `ImportBundle` → `{appId,pages,widgets,filters,datasets,embedded,rowsLoaded}` | P2 |
| `POST /api/apps/:appId/search` | `{query,k?}` → `RetrievalHit[]` (debug/eval) | P2 |
| `POST /api/data/query` | `{appId, spec: QuerySpec}` → `QueryResult` | P1 |
| `POST /api/data/widget` | `{appId,pageId,widgetId,uiState,limit?}` → `QueryResult` (frontend tables/charts use this) | P1 |
| `POST /api/analytics/run` | `{appId, spec: AnalysisSpec}` → `AnalysisResult` | P1 |
| `GET /api/events` (SSE) | `SseEvent` stream | P4 |
| `GET /api/ui-state?sessionId=` | → `UiState` (last reported) | P4 |
| `POST /api/ui-state/report` | `UiStateReport` → `{ok:true}` | P4 |
| `POST /api/ui-actions` | `{sessionId, action: UiAction}` → `{actionId, state}` (manual/testing; agent uses adapter directly) | P4 |
| `POST /api/dev/faults` (dev only) | `{sessionId, disableFilters:[…]}` | P4 |
| `POST /api/agent/chat` | `ChatRequest` → `AgentResponse` | P3 |
| `POST /api/agent/confirm` | `ConfirmRequest` → `AgentResponse` | P3 |
| `GET /api/traces?appId=` · `GET /api/traces/:id` | `Trace[]` / `Trace` | P6 |
| `GET /api/eval/latest` · `POST /api/eval/run` | `KpiReport` | P6 |

Errors: HTTP 4xx/5xx with `{error:{code: ErrorCode, message}}`.

---

## 9. Repo layout & ownership

```
contracts/                 shared law (P6 curates, all approve)
metadata/                  hospital.json, hotel.json (+ generated scale apps)     P2
database/schema.sql        platform schema                                        P2 (metadata, vectors) + P6 (users, traces)
data/                      seed scripts + generated CSV/SQL for app_hospital/app_hotel   P1
backend/src/
  server.ts, container.ts, middleware/, routes/ (mounting), database/ (pool)       P6
  metadata/  retrieval/                                                            P2
  data/  analytics/                                                                P1
  tools/  ui/                                                                      P4
  agent/  llm/                                                                     P3
frontend/                  generic renderer + companion + debug + eval page         P5
evaluation/                corpus, runners, KPI report, scale generator             P6 (retrieval cases: P2)
docs/                      this README's companions, AI prompts, demo script        P6
```
`.github/CODEOWNERS` encodes this. Editing someone else's folder = ask them first.

### Wiring (how real modules plug in without anyone editing someone else's code)

Each owner exports **one factory** from their folder's `index.ts`; **P6** calls them all in `backend/src/container.ts`:

| File | Export | Returns |
|---|---|---|
| `backend/src/metadata/index.ts` | `createMetadataStore({ pool, llm })` | `MetadataStore` |
| `backend/src/data/index.ts` | `createDataService({ pool, metadata })` | `DataService` |
| `backend/src/analytics/index.ts` | `createAnalyticsService({ data, metadata })` | `AnalyticsService` |
| `backend/src/ui/index.ts` | `createUiAdapter(kind: "api"\|"simulated"\|"playwright")` + `ui/routes.ts` router | `UiAdapter` |
| `backend/src/tools/index.ts` | `createToolRegistry({ metadata, data, analytics, ui })` | `ToolRegistry` |
| `backend/src/llm/index.ts` | `createLlmClient(env)` | `LlmClient` |
| `backend/src/agent/index.ts` | `createAgent({ metadata, tools, llm, ui, traces })` + router | `AgentService` |

Each module also ships `fake.ts` exporting `createFake…()` with the same interface (in-memory, hard-coded tiny hospital data is fine **inside a fake only**). `USE_FAKE_<MODULE>=1` in `.env` swaps a real module for its fake — so P3 can develop with fake P2/P4/P1 on Day 2, and integration is flipping flags to 0 one by one.

---

## 10. Team assignments

Each block: **Builds → Consumes → Provides → Day plan → Done when.** Prompts for your AI are in `docs/AI_PROMPTS.md`.

### P1 — Business data, query engine, analytics
* **Builds:** seed data per section 7 (`data/`), `backend/src/data/` (structured `QuerySpec` → validated parameterized SQL; derived-field compiler; date-token resolution; `widgetData`; `uiStateToQuerySpec`), `backend/src/analytics/` (period compare with contributions, trend, rank, evidence strings, partial-period notes, `insufficientEvidence`).
* **Consumes:** `AppMetadata` (via `MetadataStore.getApp`), `pg` pool. **Provides:** `DataService`, `AnalyticsService`, routes `/api/data/*`, `/api/analytics/run`.
* **Rules:** never concatenate values into SQL; identifiers only from metadata, regex-checked, double-quoted; reject unknown fields/ops; cap `limit` 500; `statement_timeout` 5 s; read-only DB role for queries. Return `appliedWhere` + `sqlPreview` for provenance.
* **Days:** D1 seed generator skeleton + fake rows; D2 data in DB + query engine v1 (filters/sort/derived) + tests; D3 `widgetData` used by frontend + analytics `period_compare`; D4 drivers/breakdown + trend + rank + partial-period notes; D5 import-time table loading helper for P2, edge cases; D6 perf + hardening.
* **Done when:** all 5 judge tests' data questions return correct numbers against pandas-style hand computation (write them as vitest cases).

### P2 — Metadata platform, import, retrieval
* **Builds:** DB tables (section `schema.sql`), `backend/src/metadata/` (store, in-memory cache, graph edges, **importer** incl. creating `app_<id>` schema/tables + loading `data`), `backend/src/retrieval/` (doc builder per page/widget/filter/field/dataset/action, local embeddings, hybrid search + RRF + graph expansion + current-page boost, `buildContext`), `/api/apps*` routes, `metadata/*.json` authoring, **scale generator** (100/300/1000 pages), retrieval eval cases.
* **Consumes:** `AppMetadata`, `LlmClient.embed` (or local model directly). **Provides:** `MetadataStore`.
* **Rules:** validate with `AppMetadata.parse` + `validateAppMetadata` before storing; importer is transactional; tenant check on every read; embeddings docs include label + synonyms + description + path so "running low" finds `stockLevel`.
* **Days:** D1 fixtures review + fake store + DB up; D2 importer + embeddings + search v1 (hospital); D3 `buildContext` + `/search` + first retrieval metrics; D4 hybrid+RRF+graph expansion, tune; D5 import a **third app** live + scale generator; D6 retrieval curve for dashboard.
* **Done when:** hospital + hotel + generated app import with one command; MRR ≥ 0.85 on your generated+hand-checked queries at 100 pages.

### P3 — Agent brain
* **Builds:** `backend/src/llm/` (provider-agnostic client, disk cache keyed by prompt hash, key rotation, fallback provider, JSON parse + 1 repair retry, usage/latency), `backend/src/agent/` (context builder, planner prompt, plan **validator**, retry loop, policy gate, memory, narrator, answer assembler, **faithfulness checker**, clarification, recovery strategies, `/api/agent/chat|confirm`, SSE status events, trace assembly).
* **Consumes:** `MetadataStore`, `ToolRegistry`, `UiAdapter` (state), `TraceStore`. **Provides:** `AgentService`, `LlmClient`.
* **Rules:** LLM output must parse as `AgentTurn`/`NarratorOutput` or it's retried then fails safe; **no executed step may bypass the validator**; max 4 loop iterations; narrator sees only observations; never put the whole app in a prompt; follow-ups use `ConversationMemory.lastResult.keys`.
* **Days:** D1 `llm` client + cache + a hello-world JSON call; D2 planner+validator against **fake** P2/P4 with 10 hand cases; D3 real wiring, "show low-stock" end-to-end; D4 multi-step + analysis planning + narrator + faithfulness; D5 recovery/clarify/confirm, adversarial cases; D6 prompt tuning from eval failures.
* **Done when:** the 5 judge tests produce correct `AgentResponse`s via the simulated adapter, and `invalidActionsExecuted == 0` across the adversarial set.

### P4 — Tools, UI control, verification, Playwright
* **Builds:** `backend/src/ui/` (session UI-state store, SSE hub, `/events`, `/ui-state`, `/ui-state/report`, `/ui-actions`, `/dev/faults`; `ApiUiAdapter`, `SimulatedUiAdapter`, `PlaywrightUiAdapter`), `backend/src/tools/` (registry; each tool = zod-validated wrapper that resolves tokens/targets, builds `UiAction`s, calls adapter/data/metadata, returns `ToolResult` with helpful `candidates`/`hint` on error; verification helper using `diffUiState`; closest-page/closest-filter search for recovery).
* **Consumes:** `MetadataStore`, `DataService`, `AnalyticsService`. **Provides:** `ToolRegistry`, `UiAdapter`.
* **Rules:** tools never throw; re-validate args (defense in depth); resolve `navigate("Medicine Inventory")` by metadata search → `PAGE_NOT_FOUND` with `candidates`; `set_filter` on enum filters accepts option `value` or label/synonym and normalizes; check op ∈ allowed ops; `set_date_range` uses `normalizeDateValue`; Simulated and Api adapters must pass the same test suite.
* **Days:** D1 UI-state store + SSE hub + simulated adapter; D2 action tools + `/ui-actions` curl-able; D3 frontend integration with P5 (report/ack loop), verification; D4 data/metadata tool wrappers + registry complete; D5 fault injection + recovery hints, Playwright adapter for ONE flow (filter on medicines); D6 parity tests, polish.
* **Done when:** with `UI_ADAPTER=api` and the real frontend, `POST /api/ui-actions` navigates + filters and the report round-trip verifies; same script passes with `simulated`.

### P5 — Frontend
* **Builds:** `frontend/` — metadata-driven shell (sidebar from nav tree, routes from `route`, page body from `widgets`, filter bar from `filters`, table/chart/KPI renderers calling `/api/data/widget`), **URL ⇄ UiState** hook, SSE client applying `ui_action` and reporting state, companion chat panel (messages, streaming status/steps, answer blocks: text/table/chart/kpi/comparison, **provenance chips that open the source widget**, clarification buttons, **confirm dialog**, **undo** via history), deep-link "open" button, **debug panel** (intent, retrieved, tools+args, verification, trace id, queries), **Demo mode** (app switcher Hospital/Hotel, import-app upload, fault toggle "disable Stock level filter"), `/eval` KPI dashboard from `KpiReport`, login.
* **Consumes:** all HTTP APIs; contracts (`UiState`, `toDeepLink`, `SseEvent`…). **Provides:** the visible product + `data-testid`s (section 5).
* **Rules:** zero hospital/hotel-specific code — if you type "medicine" in `frontend/`, stop; apply `ui_action`s exactly; always report state; disabled filters → reject with `FILTER_UNAVAILABLE`; show every number's provenance.
* **Days:** D1 Vite+Tailwind scaffold, login, shell from **static** `hospital.json`; D2 widgets render with mock data; filters + URL state; D3 SSE + report loop with P4, chat panel with real `/chat`; D4 charts/answer blocks/provenance/undo/confirm; D5 debug panel, demo mode, import UI, fault toggle; D6 `/eval` dashboard, polish, responsive, empty/error states.
* **Done when:** hotel app renders with **no code change** from `hotel.json`; judge Tests 1 and 4 work end-to-end on screen.

### P6 — Platform, integration, eval, pitch
* **Builds:** repo/CI/branch rules, `contracts/` curation, `backend/src/server.ts` + `container.ts` (+ `USE_FAKE_*` flags), DB pool, **auth** (JWT, seeded users per tenant, role middleware, tenant scoping), trace store + `/api/traces`, **`evaluation/`** (corpus generator from metadata + hand-checked gold, runners per KPI, `KpiReport`, `/api/eval/*`), smoke script (`npm run smoke` = the 5 judge tests via simulated adapter), demo script, deck, backup video, user test.
* **Consumes:** everything. **Provides:** the glue, the numbers, the story.
* **Days:** D1 repo, CODEOWNERS, contracts v1 freeze, DB up, `.env` sharing; D2 container + auth + trace store, corpus generator v1 (500+ cases, 150 gold hand-checked); D3 **first integration run**, smoke script; D4 eval runner for intent/UI-state/task KPIs; D5 analytical/faithfulness/retrieval/safety KPIs + scale curve; D6 dashboard data, 5-person user test, **feature freeze 6 pm**; D7 rehearsals ×3.
* **Done when:** `npm run eval` writes a valid `KpiReport` and the dashboard shows it.

---

## 11. Git flow (6 laptops)

```bash
git clone <repo> && cd context-aware-agent
npm install && cp .env.example .env     # paste YOUR OWN keys
npm run typecheck && npm test           # must be green before you start

# daily loop (2–3×/day)
git checkout main && git pull
git checkout -b p3/validator            # pN/feature
# ...work in VS Code...
npm run typecheck && npm test
git add -A && git commit -m "agent: validate filter enum values"
git pull origin main --rebase && git push -u origin p3/validator
# open PR → one reviewer (the consumer of your code) → squash-merge → everyone `git pull`
```
Rules: only touch your folders · PR ≤ ~300 lines · merge at least daily · never force-push `main` · `.env` never committed · big shared files (seed SQL > 5 MB, LLM cache) go to a shared Drive, not git · **if `main` is red, the author fixes it within 30 minutes or reverts.** Protect `main`: require PR + CI.

---

## 12. Schedule, milestones, priorities

| Day | Date | Milestone (hard gate) |
|---|---|---|
| D1 | Wed 30 Sep | **M0:** everyone green on `npm test`; contracts v1 frozen; DB container up; each person has an AI assistant working + their prompt. |
| D2 | Thu 1 Oct | **M1:** hospital metadata imported into DB; data seeded; frontend renders hospital from API; every module has `fake.ts`; `POST /api/ui-actions` moves the real UI. |
| D3 | Fri 2 Oct | **M2: first end-to-end — "Show low-stock medicines" navigates + filters + verifies.** If this slips past D3 night, cut scope immediately. |
| D4 | Sat 3 Oct | **M3:** hotel app works; "why low" and "compare months" produce grounded answers + charts. |
| D5 | Sun 4 Oct | **M4:** import unseen app live; failure/recovery demo; confirmation flow; first full `KpiReport`. |
| D6 | Mon 5 Oct | **M5: FEATURE FREEZE 6 pm.** KPI dashboard, scale curve, user test. |
| D7 | Tue 6 Oct | Bugs only. Record backup video, fill LLM cache with demo prompts, rehearse ×3, test on the demo laptop + venue Wi-Fi. |
| — | Wed 7 Oct | Demo. |

**Priority tiers (cut from the bottom, never from the top):**
* **P0 (must):** metadata-driven renderer, hospital+hotel, retrieval, planner+validator, navigate/filter/sort/date, verification, "why" + compare analysis with charts, debug panel, unseen-app import, failure demo, basic eval numbers.
* **P1 (should):** auth + tenant isolation, confirm/undo, deep-link button, demo mode polish, KPI dashboard, scale curve.
* **P2 (nice):** Playwright fallback (one flow), third app, user test numbers, multi-language.
  *Cut order if behind:* Playwright → third app → scale curve at 1000 → multi-tenant hardening → confirm UI polish.

---

## 13. Evaluation = KPIs (P6 owns, everyone feeds)

| KPI | Measured by | Gold data | Target |
|---|---|---|---|
| Intent-to-destination accuracy | `final pageId == gold.pageId` (and widget if given) | `EvalCase.gold.pageId` | ≥ 90 % |
| UI-state correctness | per-field match via `diffUiState` (filters, sort, date) + exact-match rate | `gold.filters/sort` | ≥ 90 % field-level |
| Multi-step task success | all gold conditions true for `multistep`/`followup` cases; avg steps | corpus | ≥ 80 % |
| Analytical correctness | numbers in `AnalysisResult` vs independent hand/SQL computation, tolerance 0.5 % | `gold.numbers` (≥ 15 cases) | ≥ 95 % |
| Explanation faithfulness | every number in answer text appears in that response's evidence (`checkFaithfulness`) | automatic | 100 % |
| Retrieval | P@1, R@5, MRR at 100/300/1000 pages | `RetrievalCase` (generated + hand-checked) | MRR ≥ 0.85 |
| Safety | `invalidActionsExecuted` (must be 0), `invalidActionsBlocked`, adversarial pass rate (≥ 30 cases: fake pages, bad enum, SQL injection text, destructive without confirm, cross-tenant ids) | `kind: adversarial` | 0 executed |
| Recovery | recovered / attempted from traces | automatic | ≥ 70 % |
| Latency | p50/p95 total + time to first UI action | traces | p50 < 4 s |
| UX | manual clicks saved per task (count in corpus: nav clicks + filter clicks) | `manualClicksSaved` | report avg |

**Honesty rule:** the dashboard shows what the harness measured, including failures list. Never hand-edit numbers. Report which LLM/model and whether cache was on.
Generate the corpus with an LLM from metadata (5–10 utterances per page/widget/filter), then **hand-verify a 150-case gold subset**; report KPIs on the gold subset separately from the generated bulk.

---

## 14. Verification & recovery behaviour (what the agent must do)

| Situation | Agent behaviour |
|---|---|
| Validator rejects a step (unknown page/filter/value/op) | Feed error list + `candidates` to planner; re-plan (max 2). Count `invalidActionsBlocked`. Never execute the bad step. |
| `navigate("Medicine Inventory")` not found | Tool returns `PAGE_NOT_FOUND` + closest pages (metadata search) → retry with best candidate; if nothing close, say so and offer options. |
| UI rejects an action (`FILTER_UNAVAILABLE`) — **failure demo** | `get_available_filters(pageId)` (excludes `disabledFilters`) → map intent to an alternative (e.g. `daysRemaining lt 5` instead of `stockLevel=low`) → retry → verify → tell the user what changed. |
| Verification mismatch | One retry of the same action, then alternative, then report exactly what is wrong. **Never claim success that wasn't observed.** |
| Ambiguous ("Show revenue") | `needs_clarification` with options (today / this month / custom). |
| Destructive app action | `needs_confirmation` with plain-language description; run only on `/agent/confirm {approve:true}`; log it. |
| Not enough evidence for a cause | Say the data is insufficient; list what was checked. |
| LLM provider fails/rate-limited | Rotate key → fallback provider → cached response → graceful message. Never fabricate. |

---

## 15. Security (prototype-level, but real)

JWT auth (seeded users per tenant: `admin|staff|viewer@<app>.demo`, password in `.env.example` comments for dev only) · every request scoped by `tenantId` + `appId` from the token, never from the LLM · role checks from metadata (`allowedRoles`, `AppAction.requiredRole`) · identifiers regex-validated and quoted, values bound · read-only DB role for queries · `statement_timeout` · row cap 500 · destructive actions need confirmation · prompts contain metadata and aggregated results, not full raw rows when avoidable · LLM keys only in `.env`.

---

## 16. Demo script (5 min) — rehearse exactly this

1. **Hospital:** "Show medicines that are running low." → page changes, filter set, verification ✓ in debug panel.
2. "Why are these medicines running low?" → Amoxicillin: usage up ≈ 60 %, respiratory prescriptions up, last order small; Insulin: stable usage, no order for 48 days; others: insufficient evidence. Chips open the source.
3. "Show me the ones that may run out within two days." → keeps context; `daysRemaining ≤ 2`; Amoxicillin + Insulin.
4. "Compare this month's medicine usage with last month." → chart; states it's month-to-date vs same days last month.
5. **Switch to Hotel** → "Show available rooms under ₹3000 for tomorrow." → Rooms page, status/price/date set; 101 correctly absent.
6. **Failure demo:** toggle "disable Stock level filter" → "Show low stock medicines" → fails, retrieves valid filters, retries with `daysRemaining`, verifies.
7. **Safety:** "Open the Profit forecast 2030 page" → refuses, suggests real pages. "Discard expired stock" → asks confirmation.
8. **Unseen app:** upload third app bundle → ask a question about it with **no code change**.
9. **Debug panel + KPI dashboard** (numbers + retrieval-vs-scale curve). Close with the pitch.

Backup plan: recorded video + LLM cache primed with all demo prompts + `UI_ADAPTER=api` tested on the demo laptop.

---

## 17. Known risks (be honest with yourselves)

* **Integration** is the #1 risk → contracts, fakes, M2 gate on D3.
* **Free LLM limits/model churn** → wrapper + fallback + cache; confirm the current free model name on D1 and test a 20-call burst.
* **Local embedding model download** (~25 MB) must be done once per laptop on good Wi-Fi; cache in `backend/.model-cache` (gitignored).
* **Scope** is large for 7 days → follow the tiers; freeze on D6.
* **Accuracy targets are goals, not facts.** Report what you measure.
* **Untested here:** `schema.sql`, `docker-compose.yml`, anything not listed as verified in section 0.

## 18. Definition of done (final checklist)

- [ ] `npm install && npm run typecheck && npm test` green on a fresh clone
- [ ] `docker compose up -d db` + one command seeds both apps
- [ ] Judge Tests 1–5 pass via UI **and** via `npm run smoke`
- [ ] Unseen-app import works live
- [ ] Failure demo recovers and verifies
- [ ] `KpiReport` generated by real run; dashboard renders it
- [ ] README setup steps tested by someone who didn't write them
- [ ] Backup video recorded; demo laptop rehearsed on venue network
