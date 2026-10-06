# AI Prompts & Assistant Guide

How to use this file: **(1)** read section A to pick your assistants, **(2)** paste section B (shared preamble) into your assistant once per chat, **(3)** paste your own prompt from section C, **(4)** follow the working loop in section D.

---

## A. Which AI assistant for which component (all free)

Free limits and model names change often — **check each provider's current free tier on Day 1** and write down what you actually get. Everyone installs **one editor assistant + one chat assistant** so one rate limit never blocks you.

| Tool | Free? | Best used for | Notes |
|---|---|---|---|
| **GitHub Copilot Free** (VS Code) | Free tier with monthly quota | Inline completions, small edits, test boilerplate | **Students: apply for the GitHub Student Developer Pack** — it normally includes Copilot Pro. The repo's `.github/copilot-instructions.md` is read automatically. |
| **Claude (claude.ai free)** | Limited daily messages | Design questions, hard debugging, prompt writing, code review, SQL | Spend messages on *hard* problems; paste `docs/AI_CONTEXT.md` first. |
| **Google AI Studio / Gemini (free)** | Generous free tier | Long outputs: seed data, big files, test corpora, long-context repo questions | Also the **runtime LLM** for the agent. |
| **Gemini CLI** (terminal) | Free with a Google login (verify current limits) | Repo-wide edits and "implement module X against these interfaces" | Reads `GEMINI.md` automatically. |
| **ChatGPT free** | Limited | Second opinion, regex/SQL/CSS quick questions | Backup. |
| **Continue.dev + Ollama (local)** | Free, unlimited | Offline emergency (needs ~16 GB RAM for a 7B coder model) | Slower and weaker; backup only. |

**Recommended pairing per person**

| Person | Component | Editor assistant | Chat/agent assistant (primary) | Backup |
|---|---|---|---|---|
| **P1** | Data, query engine, analytics | Copilot Free | **Gemini (AI Studio)** for seed generators and big SQL/TS files; **Claude** to review the query-compiler security | ChatGPT |
| **P2** | Metadata, importer, retrieval | Copilot Free | **Claude** for schema/SQL/retrieval design; **Gemini** for long files | Gemini CLI |
| **P3** | Agent brain, LLM client, prompts | Copilot Free | **Claude** for prompt design, validator logic, debugging loops; **Gemini** for bulk code | ChatGPT |
| **P4** | Tools, UI control, Playwright | Copilot Free | **Gemini CLI** for multi-file wiring; **Claude** for Playwright + SSE debugging | ChatGPT |
| **P5** | Frontend | Copilot Free | **Gemini** (fast UI generation) + **Claude** for state/URL sync bugs | ChatGPT |
| **P6** | Platform, eval, docs, pitch | Copilot Free | **Claude** for architecture/eval design; **Gemini** for corpus generation and slides text | ChatGPT |

**Survival rules:** keep a text file `my-ai-notes.md` (not committed) with the prompts that worked · when a chat gets long and confused, start a new chat and re-paste preamble + your prompt + the file you're editing · never paste API keys into any chat · if an assistant invents a field that isn't in `contracts/`, the contract wins.

---

## B. SHARED PREAMBLE — paste first, every new chat

```
You are a senior TypeScript engineer on a 6-person hackathon team building a "Context-Aware Application Agent":
an AI assistant embedded in a no-code business app. It understands the app only from METADATA (pages, widgets,
filters, datasets), can navigate/filter/sort the app, query business data, analyze it, verify the UI result, and
work on an unseen app by importing metadata.

Repo: npm-workspaces monorepo (contracts/, backend/, frontend/, evaluation/, metadata/, database/, data/).
Stack: TypeScript strict, Node 20, Express, Postgres 16 + pgvector, React + Vite + Tailwind + Recharts, zod, vitest.

RULES (non-negotiable):
1. Never hard-code application logic. No `if (query.includes("low stock"))`, no `if (app === "hospital")`.
   All app knowledge comes from metadata JSON through the MetadataStore interface.
2. `contracts/` is the shared source of truth (zod schemas, types, service interfaces). Import from "@cab/contracts".
   Never redefine or edit contract types. If something seems missing, tell me instead of inventing it.
3. Code against the interfaces in contracts/src/services.ts. Also write an in-memory `fake.ts` for my module.
4. The LLM never writes SQL and never emits UI actions directly. It emits ToolCall/AgentTurn JSON validated by zod,
   then the backend validates against metadata. Numbers in answers come from code (tool results), not from the LLM.
5. Tools never throw to the agent: return ToolResult {ok:true,data} | {ok:false,error:{code,message,candidates?,hint?}}.
6. UI state is the URL. Use toDeepLink/fromDeepLink/diffUiState from contracts. Dates: only resolveDateToken/
   normalizeDateValue resolve relative dates. Never use Date.now() for business dates; use ctx.now (DEMO_NOW).
7. Identifiers: UI ids (page/widget/filter/action) camelCase; dataset/table/field names lowercase snake_case.
   In SQL: validate identifiers by regex, double-quote them, bind all values as parameters.
8. Tenant isolation: every DB/metadata call is scoped by ctx.tenantId and ctx.appId.
9. No secrets in code; read from process.env.
10. Work in small steps. Before each step say what you will build. After each step run `npm run typecheck` and
    `npm test`, fix errors, and write a vitest for every non-trivial function. Never claim something works unless
    it was run. Choose the simplest design that satisfies the requirement.

First, read these files in the repo and summarize in 5 lines what you understood, then wait for my task:
docs/AI_CONTEXT.md, README.md (sections 4,5,6,9), contracts/src/*.ts, metadata/hospital.json.
```

---

## C. PER-MEMBER PROMPTS (paste after the preamble)

### P1 — Business data, query engine, analytics

```
MY ROLE: P1 — Business data + Query engine + Analytics. I own: data/, backend/src/data/, backend/src/analytics/.

BUILD, IN THIS ORDER (stop after each step and show me how to run its tests):

1. SEED DATA GENERATOR (data/seed/). Deterministic (fixed random seed) TypeScript script producing SQL or direct
   inserts for schemas app_hospital and app_hotel, EXACTLY matching the datasets/fields in metadata/hospital.json and
   metadata/hotel.json (column name = field name, skip `derived` fields). Follow README section 7 literally:
   specific medicine rows, planted Amoxicillin/Insulin causes, hotel room availability where room 101 is occupied
   on 2026-10-08, September revenue ≈ -12% vs August with Room Bookings ≈ -18% and more OTA cancellations.
   Demo clock DEMO_NOW=2026-10-07; 120 days of history. Add `npm run seed` in the root package.json scripts (tell me).
   Also write vitest "story tests" that assert the planted facts (e.g. Amoxicillin last-14-day usage is ≥50% above the
   prior 14 days; Insulin has no purchase after 2026-08-20).

2. QUERY ENGINE (backend/src/data/). Implement `DataService` from contracts/src/services.ts:
   - Compile a QuerySpec to parameterized SQL: validate dataset + every field against the AppMetadata dataset;
     quote identifiers; bind values; support ops eq,neq,lt,lte,gt,gte,in,between,contains; select, groupBy
     (with grain day/week/month via date_trunc), metrics (sum/avg/min/max/count with alias), orderBy (field or alias),
     limit (≤500). Compile `derived` field expressions (add/sub/mul/div/min/max/round; div must be NULLIF-guarded)
     into SQL; derived fields are usable in select/where/orderBy/metrics.
   - Resolve DateToken strings in conditions on date fields with normalizeDateValue(op,value,ctx.now).
   - Return QueryResult incl. appliedWhere (resolved) and sqlPreview. Set statement_timeout 5s, use a read-only role/connection.
   - `widgetData(ctx,pageId,widgetId,uiState)`: build a QuerySpec from the widget definition + current UiState:
     filters → conditions (enum option `where` presets expand to conditions; numeric/date/dateRange map to field conditions),
     only apply filters whose field exists in the widget's dataset, apply UiState.sort else widget.defaultSort,
     table → select columns; chart → groupBy x(+grain) and metric y(+series); kpi → single metric with kpi.where.
     Export this as a pure function `uiStateToQuerySpec(app, pageId, widgetId, uiState, now)` — the frontend table and
     the agent's get_widget_data MUST go through it so the answer always matches the screen.
   - Routes: POST /api/data/query and POST /api/data/widget (zod-validate bodies, use ctx from auth middleware).
   - SECURITY TESTS: unknown field, SQL injection strings in values and identifiers, limit 10^6, cross-app dataset → all rejected.

3. ANALYTICS (backend/src/analytics/). Implement `AnalyticsService.run` for AnalysisSpec kinds period_compare, trend, rank:
   - Resolve periods (tokens via resolveDateToken). periodA = current, periodB = baseline.
   - period_compare: totals for both periods, absChange, pctChange (null if baseline 0), and when breakdownBy is given a
     breakdown with a, b, abs, pct, shareOfChange (= row abs / total abs, null if total abs is 0), sorted by |abs| desc.
   - Partial-period handling: if period lengths differ, set periods.note in plain language (e.g. "Period A is 7 days, period B is 30 days").
   - trend: series by grain with optional breakdown; rank: top-N by dimension.
   - evidence[]: short plain-language facts WITH numeric `value` (these are the only numbers the narrator may cite).
   - insufficientEvidence=true (+reason) when the baseline has no rows or the change is within ±2% .
   - provenance.queryIds from the DataService queries you ran (reuse DataService.query internally).
   - Route: POST /api/analytics/run.
   - Tests: verify numbers against hand-computed values from the seeded data (Test 3: usage this_month vs last_month_to_date).

4. Ship backend/src/data/fake.ts and analytics/fake.ts (tiny in-memory fakes) by end of Day 2, and index.ts exporting
   createDataService({pool,metadata}) and createAnalyticsService({data,metadata}).

ACCEPTANCE: all vitest pass; "low stock" via widgetData returns Amoxicillin, Insulin, Metformin, Salbutamol;
"days_remaining <= 2" returns exactly Amoxicillin and Insulin; hotel "Available, price<3000, 2026-10-08" excludes room 101.
```

### P2 — Metadata platform, import, retrieval

```
MY ROLE: P2 — Metadata platform + Importer + Retrieval. I own: database/schema.sql (metadata parts), metadata/,
backend/src/metadata/, backend/src/retrieval/, and retrieval evaluation cases.

BUILD, IN THIS ORDER:

1. DATABASE: get database/schema.sql running (docker compose up -d db). It was never executed — fix any errors.
   Seed tenants (tenant-a hospital, tenant-b hotel). Tell me what you changed.

2. METADATA STORE (backend/src/metadata/): implement `MetadataStore` from contracts/src/services.ts.
   - getApp(ctx): tenant-checked (ctx.tenantId must own ctx.appId), in-memory cached, validated by AppMetadata.parse.
   - listApps(tenantId).
   - importApp(tenantId, ImportBundle): validate with AppMetadata + validateAppMetadata (reject with a list of errors);
     in ONE transaction: upsert applications (metadata jsonb), normalized tables (datasets, columns, pages, routes,
     widgets, data_views, filters, actions), graph_edges (app→page→widget→dataset, dataset→field, field→filter,
     parent→child page, dataset relation edges), create schema app_<appId> and one table per dataset from non-derived
     fields (string→text, number→numeric, date→date, boolean→boolean; validate all identifiers), bulk-insert bundle.data,
     compute+store embeddings. Return counts.
   - Routes: GET /api/apps, GET /api/apps/:appId/metadata, POST /api/apps/import (admin only), POST /api/apps/:appId/search.
   - CLI: `npm run import:app -- metadata/hospital.json` (tell me the script entry to add).

3. RETRIEVAL (backend/src/retrieval/):
   - Document builder: one text doc per page, widget, filter, field, dataset, action. Include name, label, description,
     synonyms, filter option labels/synonyms, field enum values, and the breadcrumb path (use pagePath). E.g. the
     stockLevel doc must contain "running low", "low stock", "shortage".
   - Local embeddings: @huggingface/transformers with Xenova/all-MiniLM-L6-v2 (384 dims), cache dir backend/.model-cache,
     batch embed, normalize. Put behind a small `embed(texts)` function so it can be swapped for the LlmClient later.
   - search(ctx, query, {k, kinds, currentPageId}): hybrid = pgvector cosine top-N + Postgres full-text (tsv) top-N,
     fused by Reciprocal Rank Fusion; then graph expansion (a hit on a filter/field also surfaces its widget+page; a hit
     on a widget surfaces its page and filters); small boost for hits on currentPageId; scoped by app_id; return RetrievalHit[].
   - buildContext(ctx, hits, currentPageId): RetrievalContext with the FULL navTree (names+routes only) but full cards
     only for pages implicated by hits (+ current page), their datasets (fields incl. derived flag, enumValues, roles,
     relations) and actions. Keep it compact (target < 3k tokens for the hospital app).
   - Ship fake.ts (keyword-based fake over the JSON, used by others on Day 2) and index.ts exporting
     createMetadataStore({pool,llm}).

4. EVALUATION OF RETRIEVAL: write evaluation/corpus/retrieval.jsonl (RetrievalCase) — generate ~200 queries per app from
   metadata with an LLM, hand-check 60. Write a script computing P@1, R@5, MRR. Report per app.

5. SCALE GENERATOR (evaluation/src/generateScaleApps.ts): produce valid synthetic AppMetadata with N=100/300/1000 pages
   (varied domains, nested directories, widgets, filters, shared vocabulary so retrieval is non-trivial), import them as
   apps scale100/scale300/scale1000, and output MRR/R@5 per scale for the dashboard's byScale curve.

6. Import a THIRD app (e.g. retail or school) as the live "unseen app" demo bundle: metadata + data.

ACCEPTANCE: hospital+hotel import with one command; search("running low") returns stockLevel/medicines page in top 3;
search("rooms cheaper than 3000 tomorrow") returns rooms page + price + stayDate; MRR ≥ 0.85 at 100 pages; a bad
metadata file is rejected with readable errors and leaves the DB unchanged.
```

### P3 — Agent brain

```
MY ROLE: P3 — Agent brain + LLM client. I own: backend/src/llm/, backend/src/agent/.

BUILD, IN THIS ORDER:

1. LLM CLIENT (backend/src/llm/): implement `LlmClient` from contracts.
   - Provider-agnostic: Gemini via plain fetch to the REST API (no SDK), plus Groq/OpenRouter (OpenAI-compatible) and Ollama.
     Config from env: LLM_PROVIDER, NVIDIA_API_KEY, LLM_API_KEYS_EXTRA (rotate on 429), LLM_MODEL. No fallback provider is used for the Nvidia setup.
   - json(req, parse): ask for JSON only, strip code fences, parse with the supplied zod parse; on failure ONE repair retry that
     includes the validation error; then throw LlmError. temperature default 0.
   - Disk cache in backend/.llm-cache keyed by sha256(provider+model+system+user+schemaName); LLM_CACHE=on|off; report `cached`.
   - Backoff on 429/5xx, fallback provider on exhaustion. Return latencyMs and usage.
   - embed(): delegate to local embeddings function if EMBEDDING_PROVIDER=local (coordinate with P2) else provider embeddings.
   - Tests with a mocked fetch. Also ship llm/fake.ts: a scripted client that returns queued JSON (used by everyone's tests).

2. PROMPTS (backend/src/agent/prompts.ts): planner system prompt and narrator system prompt. Planner receives:
   today's date (ctx.now), current UiState, ConversationMemory (history + lastResult keys), the RetrievalContext JSON,
   the list of allowed tools with arg schemas, observations from prior iterations, and previous validator errors.
   It must output ONLY an AgentTurn. Rules in the prompt: use only ids present in the context; filter values for enum
   filters must be one of the listed option values; use date TOKENS (never compute dates); ask clarification when the
   request is ambiguous; for "why" questions use run_analysis/query_business_data and never guess causes; follow-ups
   reuse memory.lastResult.keys.
   Narrator receives observations (QueryResult/AnalysisResult JSON) and writes NarratorOutput referencing resultIds; it may
   only cite numbers present in evidence/rows; must mention periods.note and insufficientEvidence honestly.

3. VALIDATOR (backend/src/agent/validate.ts): `validatePlan(app, ui, role, turn): {ok, errors[{stepIndex,code,message,candidates?}]}`.
   Checks against AppMetadata: page exists (by id/route/name), filter exists ON that page, op allowed (filter.operators or
   defaultOps(type)), enum value ∈ option values (also accept label/synonym → normalize and report the normalization),
   number/date value types, set_date_range filter is a date/dateRange filter, sort field ∈ widget.sortable, datasets/fields
   in QuerySpec/AnalysisSpec exist and are allowed, widget belongs to the target page, role allowed (allowedRoles,
   AppAction.requiredRole), destructive actions flagged. Use closest-match suggestions (simple string similarity over names +
   synonyms) for `candidates`. 100% unit-tested with adversarial cases (SQL strings, other-app ids, invented tools).

4. AGENT LOOP (backend/src/agent/index.ts): createAgent({metadata,tools,llm,ui,traces}) → AgentService.
   chat(): load memory → actual UiState (ui.getState, fallback req.uiState) → search+buildContext → loop (max 4 iterations):
   planner → validate (invalid: feed errors back, max 2 repairs per iteration, count invalidActionsBlocked) → policy gate
   (TOOL_KIND destructive or AppAction.destructive → status needs_confirmation, store pendingConfirmation, do NOT execute)
   → execute steps sequentially via tools.execute (stop on first error and let planner recover with the error in context)
   → after action tools, verify with diffUiState against expected state (tools return expected state in meta/data; coordinate
   with P4) → collect observations → loop until done. Then narrator → assembler fills AnswerBlocks from observations
   (tables/charts/comparisons built from QueryResult/AnalysisResult, provenance from resultIds, text from the LLM) →
   `checkFaithfulness(text, evidence)` (export it; P6 reuses it for the KPI) → update memory (lastResult keys etc.) →
   build Trace and save to TraceStore → return AgentResponse incl. deepLink (toDeepLink) and manualClicksSaved estimate.
   Emit SSE agent_status/agent_step events through the UiAdapter/hub provided by P4 (agree on the function).
   confirm(): execute the stored toolCall only if approve=true and the confirmationId matches this session.
   Clarification: status needs_clarification with options. Failures: status failed with an honest message.
   Routes: POST /api/agent/chat, POST /api/agent/confirm (zod-validate).

5. Ship agent/fake? No — instead ship test fixtures: scripted LlmClient + fake MetadataStore/ToolRegistry so the whole loop is
   tested offline. Write scenario tests for the 5 judge tests using scripted LLM turns, plus: invalid filter value → repaired;
   nonexistent page → refusal with candidates; destructive → needs_confirmation; follow-up uses memory.

ACCEPTANCE: with fakes, all scenario tests pass; with real modules + UI_ADAPTER=simulated, "Show low-stock medicines" yields
navigate+set_filter, verification ok, and an answer whose numbers all pass checkFaithfulness; adversarial set never executes
an invalid action.
```

### P4 — Tools, UI control, verification, Playwright

```
MY ROLE: P4 — Tools + UI control layer + verification + Playwright fallback. I own: backend/src/ui/, backend/src/tools/.

BUILD, IN THIS ORDER:

1. UI STATE HUB (backend/src/ui/): per-session in-memory store {state: UiState|null, pending actions, SSE connections}.
   Routes: GET /api/events (SSE; auth via ?token=; send `hello`; heartbeat every 15s; emit SseEvent JSON), GET /api/ui-state,
   POST /api/ui-state/report (UiStateReport → store state, resolve the waiting ack for actionId, ignore stale versions),
   POST /api/ui-actions (manual testing), POST /api/dev/faults (dev only: disableFilters list per session; stored and reflected
   in state.disabledFilters). Export `publish(sessionId, SseEvent)` so P3 can emit agent_status/agent_step.

2. THREE UiAdapter IMPLEMENTATIONS (same interface, same behaviour, one shared test suite run against each):
   - ApiUiAdapter: dispatch → publish ui_action {actionId, action, baseVersion} → awaitAck waits (default 3000 ms) for a report
     with that actionId; returns {state, rejected?} or {timeout:true}.
   - SimulatedUiAdapter: in-memory; applies UiAction to a UiState exactly like the real frontend would (navigate resets filters
     unless the page is unchanged; set_filter writes FilterValue; clear/ sort/ date range; honors disabledFilters by returning
     rejected FILTER_UNAVAILABLE). Used by eval and CI. It needs the app metadata to know routes → take MetadataStore in the factory.
   - PlaywrightUiAdapter (do LAST, one flow only): drive the real frontend using data-testids from README section 5 (nav-<pageId>,
     filter-<filterId>, ...), then read the URL → fromDeepLink → UiState.

3. TOOLS (backend/src/tools/): `createToolRegistry({metadata,data,analytics,ui}) → ToolRegistry` with
   execute(ctx, call): zod re-validate with ToolCall; switch on tool; ALWAYS return ToolResult (catch everything → INTERNAL).
   - search_metadata, get_app_metadata (nav tree summary), get_page_details, get_available_filters (metadata filters minus the
     session's disabledFilters), get_current_page, get_current_ui_state: thin wrappers over MetadataStore/UiAdapter.
   - navigate(target): resolve id/route/name/synonym via metadata (exact → case-insensitive → search); not found → PAGE_NOT_FOUND
     with candidates (top 3 page names). Build UiAction {navigate,pageId,route}; dispatch; await ack.
   - set_filter: resolve filter on current page (or args.pageId); normalize enum value via option value/label/synonym; op default
     eq (in for arrays); check op allowed; resolve date tokens via normalizeDateValue; dispatch; await ack; if rejected →
     FILTER_UNAVAILABLE with candidates = other enabled filters on the same field/dataset. clear_filter, set_date_range
     (token OR start/end; filterId optional → the page's single date/dateRange filter), sort (field must be sortable).
   - After each action tool return data {expected: ExpectedUiState, actual: UiState, verified: boolean, mismatches} using
     diffUiState, so P3 can verify without extra calls.
   - get_widget_data → DataService.widgetData with the CURRENT UiState; query_business_data → DataService.query;
     run_analysis → AnalyticsService.run; invoke_app_action → NEVER executes without a confirmation flag set by P3's policy gate
     (return NEEDS_CONFIRMATION otherwise); check role from metadata.
   - Each result carries meta.queryId/resultId for provenance.

4. Ship ui/fake.ts and tools/fake.ts (scripted) by end of Day 2. Export createUiAdapter(kind), ui router, createToolRegistry.

5. FAILURE DEMO support: with disabledFilters=['stockLevel'], set_filter(stockLevel) → ok:false FILTER_UNAVAILABLE, candidates include
   'daysRemaining'; get_available_filters no longer lists stockLevel.

ACCEPTANCE: parity suite green for api+simulated adapters; curl POST /api/ui-actions moves the real frontend (with P5) and the
report round-trip is acknowledged within 1s; verification catches a deliberately wrong state; every tool is unit-tested for
error paths (bad page, bad filter, bad enum, wrong op, disabled filter, timeout).
```

### P5 — Frontend

```
MY ROLE: P5 — Frontend. I own: frontend/.

BUILD, IN THIS ORDER (Day 1: work from the static metadata/hospital.json imported directly; no backend needed yet):

1. SCAFFOLD: Vite + React + TS + Tailwind + React Router in frontend/ (package.json exists; add index.html, src/, configs).
   Import types from "@cab/contracts". API base from VITE_API_URL (default http://localhost:4000). Login page → JWT in memory + localStorage.

2. METADATA-DRIVEN APP SHELL — ZERO hospital/hotel-specific code (if you type "medicine" or "room" in src/, stop):
   - Load AppMetadata from GET /api/apps/:appId/metadata. Sidebar = nav tree from pages.parent (collapsible), routes from page.route.
   - Page body = widgets in a grid: table (columns, sortable headers, default sort), chart (bar/line/pie/donut via Recharts using
     QueryResult rows), KPI card. Data from POST /api/data/widget {appId,pageId,widgetId,uiState}. Format values by field.format/unit.
   - Filter bar from page.filters: enum → select/chips (option labels), number → operator + value, date → date input, dateRange → two dates.
   - Realistic enterprise look (header with app name + app switcher, clean cards). Responsive. Loading/empty/error states.
   - Emit data-testid: nav-<pageId>, filter-<filterId>, filter-<filterId>-option-<value>, sort-<widgetId>-<field>, widget-<widgetId>,
     row-<widgetId>-<key>, chat-input, chat-send.

3. UI STATE = URL: a `useUiState()` hook deriving UiState ONLY from location (fromDeepLink) and writing every change via toDeepLink.
   Version counter increments on each change. After EVERY state change, POST /api/ui-state/report {sessionId, state}.
   sessionId = crypto.randomUUID() stored per app+user. Undo = history back.

4. AGENT SYNC: EventSource GET /api/events?sessionId=..&token=..; on `ui_action` apply it exactly (navigate → push route; set_filter/
   clear_filter/set_date_range/sort → update query string; clear_all_filters), then report with actionId. If the action targets a filter in
   state.disabledFilters, DO NOT apply: report {rejected:{code:'FILTER_UNAVAILABLE',reason}}. Show `agent_status`/`agent_step` live.

5. COMPANION PANEL (right side): messages, input; POST /api/agent/chat; render AgentResponse: status badges, steps list (tool, args, ✓/✗,
   recovery), AnswerBlocks (text markdown, table, chart, kpi, comparison) each with PROVENANCE CHIPS that open the source page/widget
   (navigate to provenance.pageId + highlight widgetId), clarification options as buttons, confirmation dialog for needs_confirmation
   (POST /api/agent/confirm), "Open in app" button for deepLink, "Undo".

6. DEBUG PANEL (toggle): intent, retrieved hits, tool calls + args + results, verification (expected vs actual, ✓/✗), queries/SQL preview,
   latency, cachedCalls, trace id (GET /api/traces/:id). DEMO MODE: app switcher (GET /api/apps), "Import app" (upload ImportBundle JSON →
   POST /api/apps/import), "Simulate failure: disable Stock level filter" toggle (POST /api/dev/faults + reflect in disabledFilters),
   fixed demo date banner (DEMO_NOW).

7. /eval DASHBOARD: fetch GET /api/eval/latest (KpiReport) → KPI tiles with target/pass indicators, retrieval-by-scale line chart,
   failures table, model + cache flag. Until the API exists, use a sample KpiReport JSON (clearly labeled SAMPLE).

ACCEPTANCE: the hotel app renders with no code changes; POST /api/ui-actions (P4) visibly navigates+filters the real UI and the report is
sent; deep link in the address bar reproduces the exact state after refresh; every control has its data-testid; Lighthouse-style basics
(no console errors, usable at 1280px and tablet width).
```

### P6 — Platform, integration, eval, pitch

```
MY ROLE: P6 — Platform, integration lead, evaluation, pitch. I own: contracts/ (curator), backend/src/server.ts, container.ts, middleware/,
database/ (users, traces), evaluation/, docs/, CI.

BUILD, IN THIS ORDER:

1. REPO + CI (Day 1): verify `npm install && npm run typecheck && npm test` on a clean clone; set CODEOWNERS with real usernames; protect main
   (PR + CI required); share .env values (not keys) with the team; create `my-ai-notes` guidance; run a 10-minute kickoff to FREEZE contracts v1.
   Then act as the only person who merges PRs touching contracts/.

2. SERVER + CONTAINER: backend/src/container.ts: createServices() builds pool (backend/src/database/pool.ts) and wires each module's factory
   (README section 9 'Wiring'), honoring USE_FAKE_METADATA|DATA|ANALYTICS|UI|TOOLS|LLM|AGENT env flags (fake when '1'). server.ts mounts routers:
   auth, apps (P2), data+analytics (P1), ui (P4), agent (P3), traces, eval. Error handler → {error:{code,message}}. Request ctx builder: from JWT +
   body/params build RequestContext {tenantId, appId, userId, role, sessionId, traceId, now: process.env.DEMO_NOW}.

3. AUTH + TENANCY: users table seed (bcrypt) for tenant-a (admin/staff/viewer@hospital.demo) and tenant-b (…@hotel.demo); POST /api/auth/login;
   JWT middleware (also accepts ?token= for SSE); requireRole; assertAppAccess(ctx) used by routes. Tests: cross-tenant access denied.

4. TRACE STORE: implement TraceStore on agent_traces; GET /api/traces, /api/traces/:id.

5. EVALUATION (evaluation/): 
   - generateCorpus.ts: from metadata + an LLM, generate EvalCase JSONL (kinds navigate, operate, analyze, multistep, followup, clarify,
     adversarial) — ≥500 generated, ≥150 hand-verified 'gold' in evaluation/corpus/gold.jsonl, ≥30 adversarial (fake pages, invalid enum,
     SQL-injection text, destructive without confirmation, cross-tenant ids, prompt-injection text inside data).
   - run.ts: replay cases through POST /api/agent/chat (or in-process AgentService) with UI_ADAPTER=simulated, reset session per case,
     replay `history` first; compute every KPI in README section 13 exactly as defined: intentToDestination, uiState (field-level via
     diffUiState + exact match), taskSuccess, analytical (numbers vs gold with tolerance), faithfulness (use P3's checkFaithfulness),
     retrieval (P2's script; byScale), safety (invalidActionsExecuted must be 0), recovery, latency p50/p95, ux (clicks saved).
     Output evaluation/results/latest.json validated by KpiReport.parse, include failures list, model, cache flag, git commit.
   - API: GET /api/eval/latest, POST /api/eval/run.
   - `npm run smoke`: the 5 judge tests end to end with simulated adapter, printing PASS/FAIL per test — run it after every merge.

6. PITCH: docs/DEMO_SCRIPT.md (README section 16 timed), slide deck outline (problem → insight → architecture → live demo → KPIs → limits/next),
   record a backup demo video on Day 7, fill the LLM cache by running every demo prompt once, run the 5-person user test (clicks saved + 1–5 rating).

ACCEPTANCE: fresh-clone setup works for a teammate who didn't write the code; `npm run eval` produces a valid KpiReport; `npm run smoke`
is green; main is never red for more than 30 minutes.
```

---

## D. Working loop with your AI (use for every task)

1. **Start of day:** `git pull`, `npm install`, `npm test`.
2. **New chat:** paste preamble (B) + your prompt (C). Ask the AI to do **one numbered step**.
3. **Ask for tests first** ("write vitest cases for X, then implement"). Run them. Paste failures back verbatim.
4. **Small diffs:** one file or one function at a time; review what it wrote — if you can't explain it, don't commit it.
5. **Contract mismatch?** Don't let the AI "fix" it by editing contracts. Post in the group chat.
6. **Commit + PR** at least daily. In the PR description paste the command you ran to test.
7. **Stuck for > 30 min?** Switch assistant (Claude ↔ Gemini), or ask the consumer of your module to pair for 10 minutes.
8. **Before leaving for the night:** push your branch, and write 3 lines in the group chat: done, next, blocked-on.
