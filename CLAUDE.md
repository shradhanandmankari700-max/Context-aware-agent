# AI CONTEXT — read this before writing any code in this repo

Project: **Context-Aware Application Agent** (hackathon, demo 7 Oct 2026). A natural-language agent that understands a
no-code business app's *metadata* (pages, widgets, filters, datasets), operates the app (navigate, filters, dates, sort),
queries business data, analyzes it, verifies the UI result, and works on an unseen app by importing metadata only.

## Non-negotiable rules
1. **Never hard-code application logic.** No `if (query.includes("low stock"))`, no `if (app === "hospital")`. All app knowledge comes from `metadata/*.json` via the `MetadataStore`.
2. **`contracts/` is the law.** Import types/schemas from `@cab/contracts`. Do not redefine them. Do not edit `contracts/` — ask the team (changes go through a PR that all 6 approve).
3. **Code against interfaces** in `contracts/src/services.ts`. Ship an in-memory `fake.ts` for your own module so others can integrate before your real one is done.
4. **The LLM never writes SQL and never emits UI actions directly.** It emits `ToolCall`/`AgentTurn` JSON (validated by zod) → backend validates against metadata → executes. Numbers in answers come from code (tool results), never from the LLM.
5. **Tools never throw to the agent.** Return `ToolResult` (`{ok:true,data}` or `{ok:false,error:{code,message,candidates?,hint?}}`).
6. **UI state = the URL.** Use `toDeepLink` / `fromDeepLink` / `diffUiState` from contracts. Filter values in UI state are ISO/resolved; date tokens are resolved only by `resolveDateToken` / `normalizeDateValue`.
7. **Never use real `Date.now()` for business dates.** Use `ctx.now` (env `DEMO_NOW`, default 2026-10-07).
8. **Identifiers:** UI ids (page/widget/filter/action) are camelCase; dataset/table/field names are lowercase snake_case. Always double-quote and regex-validate identifiers before putting them in SQL; values are always bound parameters.
9. **Tenant isolation:** every DB/metadata call is scoped by `ctx.tenantId` + `ctx.appId`. Never trust ids from the LLM without checking they belong to `ctx.appId`.
10. **No secrets in code or prompts.** Keys only from `.env`.

## Stack
TypeScript everywhere (strict), Node 20 + Express, Postgres 16 + pgvector (Docker), React + Vite + Tailwind + Recharts + React Router, zod, vitest, Playwright (fallback only). LLM = provider-agnostic wrapper (Gemini free tier default). Embeddings = local `all-MiniLM-L6-v2` (384 dims).

## How to work
Small tasks, one file at a time. After each change run `npm run typecheck` and `npm test`. Write a vitest for every non-trivial function. Say what you will build before building it. Never claim something works unless you ran it.
