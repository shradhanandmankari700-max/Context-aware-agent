# HANDOFF PROMPT: finish the Context-Aware Application Agent

Paste this whole file into the assistant on the new laptop, or tell the assistant to read it from `docs/HANDOFF_PROMPT.md`.
You have no memory of earlier work. Everything you need is here, in `README.md`, in `docs/`, and in `INTEGRATION_LOG.md`.

## 1. The project in one paragraph

A hackathon project (demo Wednesday 7 Oct 2026, feature freeze Tuesday 6 Oct 2 PM). An AI helper lives inside a business app (Hospital Management, Hotel Management).
The user types "Show medicines that are running low." The helper finds the right page from the app's metadata, sets filters, checks the real screen, queries the data,
does the maths in code, and answers with sources. It must never invent actions: every tool call is validated against the app's own metadata. Numbers in answers
come from code, not from the AI. It must also work on a brand-new app by importing metadata only. The user is P6 (integration lead), working alone on this laptop to finish the integration.

## 2. Stack and layout

TypeScript everywhere, npm workspaces. Node 20, Express, Postgres 16 + pgvector (Docker, image pgvector/pgvector:pg16), React + Vite, zod, vitest.
AI: Gemini via plain HTTP (free tier), Groq fallback, local embeddings (all-MiniLM-L6-v2, 384 dims).
Folders and owners: `contracts/` shared law (never edit); `metadata/` hospital.json, hotel.json; `database/schema.sql`, `seed_users.sql`;
`data/` seed generator (P1); `backend/src/data` and `analytics` (P1); `metadata` and `retrieval` (P2); `agent` and `llm` (P3); `ui` and `tools` (P4); `frontend/` (P5);
`server.ts`, `container.ts`, `middleware`, `evaluation/` (P6). Read `README.md` sections 4, 5, 6, 9 and 14 and `docs/AI_CONTEXT.md` first.
Ports: backend 4000, frontend 5173, database 5432. Demo clock: `DEMO_NOW=2026-10-07`. Each `USE_FAKE_<MODULE>` env flag swaps a real module for a fake (0 = real).

## 3. State when this handoff was written (verify, do not trust)

- Backend: all eight modules (metadata, data, analytics, ui, tools, llm, traces, agent) loaded as "real" in `/api/health`. "Real" only means the code loaded.
- Login works. Tenant isolation works: the hospital admin cannot open the hotel app (403).
- M2 (low-stock) returned the right 4 medicines in the real browser once, but that run showed status `partial` because an unrequested `sort` step timed out. M2 has not been re-verified after fixes.
- Hotel flow: the API returned rooms for "available rooms under 3000 for tomorrow", but the browser stayed on "Thinking..." and never finished. Cause unknown.
- Known bugs: (1) the planner adds a sort the user did not ask for; the frontend did not acknowledge a sort action. (2) date columns come back as `2027-04-04T18:30:00.000Z`
  instead of `2027-04-10`. (3) raw `**` marks and duplicated answer text in the chat. (4) source chips sometimes show no label. (5) the frontend may keep a stale token or a different
  sessionId for the events connection after login or app switch. (6) LLM rate limits: the Gemini free tier allows about 20 requests per day per model per project; Groq's fallback model has a
  7,000 input tokens per minute limit, and one request can need about 4,400 tokens.
- LLM model that answered: `gemini-3.5-flash-lite`. Other models that answered a test: `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemma-4-31b-it`. `gemini-3.8-flash` was exhausted.
- The frontend source of truth is P5's branch `origin/codex/p5-frontend`. An earlier assistant wrote a single-file fallback `App.tsx`; it may exist in a sibling folder `frontend-assistant-backup`.
  Do not rewrite frontend files wholesale.
- Teammates may have pushed fixes since. Always `git fetch --all` first and check what is new before redoing a fix.

## 4. Demo facts used for verification

- Hospital low stock (days_remaining < 5): Insulin 0.6, Amoxicillin 0.8, Metformin 3.0, Salbutamol 3.8. Within two days: only Amoxicillin and Insulin.
- Planted causes: Amoxicillin usage rose about 60% in the last 14 days (before 2026-10-07) with more respiratory-infection prescriptions, and its last order was 2026-08-28 for 60 units
  (usual 150). Insulin usage is flat at 8 per day and its last order was 2026-08-20. Metformin and Salbutamol have no clear cause: the agent must say evidence is insufficient.
- Hotel: room 101 is Available on 2026-10-07 and Occupied on 2026-10-08. "Available rooms under 3000 for tomorrow" means date 2026-10-08, status Available, price < 3000; room 101 must NOT appear.
  September revenue is about 12% lower than August, with Room Bookings about 18% lower and more OTA cancellations.
- Demo logins are in `database/seed_users.sql` (comments) or `README.md`: admin@hospital.demo and admin@hotel.demo. Never print tokens or passwords in your output.

## 5. HARD RULES (every phase)

1. Never edit `contracts/`. NEVER edit `.env`: if a value must change, tell me the exact line and the new value, then wait. Never read, print or log keys, tokens (not even partial), passwords or the JWT secret.
   To check config print ONLY: `Select-String -Path .env -Pattern '^(LLM_MODEL|LLM_PROVIDER|LLM_FALLBACK_PROVIDER|LLM_FALLBACK_MODEL|LLM_CACHE|UI_ADAPTER|STRICT_REAL)='` (use `grep` on Mac/Linux).
2. First detect the operating system. Use PowerShell on Windows, bash on Mac/Linux. Forbidden everywhere: `git reset --hard`, `git clean`, `git push` (I push myself), `git merge --force`,
   `npm audit fix --force`, `docker compose down -v`, `docker system prune`.
3. EVIDENCE: a milestone passes only by a live run on the real stack (real AI, real Postgres, real browser at http://localhost:5173) that you actually observed.
   Unit tests and scripted-AI tests are "offline tests": report them separately and never as milestone evidence. Use the checklists below exactly; do not rewrite them or add rows.
4. Do not advance to another milestone on your own. Work phase by phase, in order.
5. FIXES: smallest possible, and say what and why. Backend/glue under about 20 lines. Frontend: only specific bugs (a wrong route, a missing state report, markdown not rendered,
   duplicated text, missing chip labels, stale token or sessionId). Never rewrite or restyle frontend files. Bigger problems: name the owner
   (P1 data/query, P2 metadata/search, P3 agent/llm, P4 ui sync/tools, P5 frontend, P6 platform) and the exact change, then continue with the next independent item.
6. Max 3 attempts per error, then report and move on. Never loop on a failing live request. If every AI provider returns 429, stop live testing, report provider, model and retry delay, and wait for me.
7. Live AI budget is limited. Never send a live chat request while another one is pending. Never use localStorage tricks or direct API chat calls to stand in for the browser test.
   Use ONE browser tab and one conversation for follow-ups so memory carries over. Do not repeat a live request that already passed.
8. Append each phase to `INTEGRATION_LOG.md`: Phase | Result PASS/FAIL | Live evidence | Offline tests | Problem + owner | Next.
9. After each phase print: `Milestone: _ | Live evidence: _ | Offline tests: _ | Still open: _ | Next: _`. Continue only on PASS. After 3 failed attempts, stop and wait for me.

## 6. PHASE 0: bring up the project on this laptop (no live AI)

0.1 `git branch --show-current`, `git status --short`, `git fetch --all`, `git log --oneline -10`, `git branch -r`. Report which branch I am on, whether `origin/codex/p5-frontend` is already an ancestor of HEAD
    (`git merge-base --is-ancestor origin/codex/p5-frontend HEAD`), and what new commits exist on `origin/feature` and `origin/main` that I do not have. Do not merge anything yet; show me first.
0.2 Check tools: `node -v` (needs 20+), `npm -v`, `git --version`, `docker --version`. Report what is missing.
0.3 `npm install`, `npm run typecheck`, `npm test`. Report counts. Fix only glue-level failures.
0.4 `.env` must exist (copied from `.env.example` and filled by me). Check only that file exists and print the allowed config lines. Required values (tell me, do not edit): `LLM_MODEL=gemini-3.5-flash-lite`,
    `UI_ADAPTER=api` for browser tests, `LLM_CACHE=on`, all `USE_FAKE_*=0`, `STRICT_REAL=0`, a non-empty `LLM_FALLBACK_MODEL`.
0.5 Database: Docker must be running. `docker compose up -d db`, wait until healthy (`docker compose ps`). Load users: apply `database/seed_users.sql`. List tables.
0.6 Data: find the seed and import scripts in `package.json` (`seed`, `import:app`) and `README.md`. Run the seed, then import `metadata/hospital.json` and `metadata/hotel.json`.
    Verify with psql: applications has hospital and hotel; counts for `app_hospital.medicines` (expect about 22), `app_hospital.medicine_usage`, `app_hotel.room_availability` (expect 1800).
0.7 Start backend (`npm run dev:backend`) and frontend (`npm run dev:frontend`) in separate FRESH terminals (a `.env` change is not picked up by `tsx watch`). `GET /api/health` must list all eight modules as real.
    The startup log should show provider, model, cache and the number of keys (counts only).
0.8 Protocol check without the browser or the AI: login as admin@hospital.demo, open the events stream for session `m2-proto`, POST a navigate action to `/api/ui-actions`, confirm a `ui_action` event arrives,
    then POST the matching `/api/ui-state/report` and confirm the action is acknowledged.
Print the status block.

## 7. PHASE A: known bugs (mocked tests only, no live AI)

A1 Planner prompt (`backend/src/agent/prompts.ts`): add the rule "never add sorting, filters or date ranges the user did not ask for". Add a mocked-LLM test that fails if a plan for
   "Show medicines that are running low." contains a sort step.
A2 Find why the frontend did not acknowledge a sort `ui_action`. Read the frontend code that applies `ui_action` events and report in 5 lines: does it apply sort, write `sort=<widgetId>:<field>:<direction>` into the URL,
   and post `/api/ui-state/report` echoing the `actionId`? Fix if under 20 lines.
A3 Dates: date columns must come back as plain `YYYY-MM-DD` with no time zone. Find where rows leave Postgres (the pg date type parser or the data layer) and fix. Add a test: the value 2027-04-10 round-trips,
   and hotel stay_date 2026-10-08 returns "2026-10-08".
A4 Frontend polish if small: render markdown in answers, remove duplicated answer text, give source chips a label (provenance description or dataset name).
A5 Frontend session handling: after login, logout and app switch, the events connection and the chat request must use the SAME current token and sessionId. A pending or failed request must show an error in the UI, not spin forever.
A6 LLM: model from `LLM_MODEL` first, provider default second (change the gemini default to `gemini-3.5-flash-lite`). Optional `LLM_MODELS` (comma-separated list tried in order). Long 429 (retry delay over about 20 s):
   mark that key+model exhausted for this process and move to the next key, model, then provider, no retries. Short 429: wait and retry once. User-facing error text is short and generic
   ("The AI service is busy. Please try again in a minute."); the full provider error goes only into the saved trace, with organization ids removed. Cache keys must not depend on the model name. Mocked tests only.
Run typecheck and tests. Restart both servers in fresh terminals. Print the status block.

## 8. PHASE M2: confirm on the real screen (1 live request; hospital app, admin@hospital.demo)

Type exactly: `Show medicines that are running low.`
Checklist (YES/NO with what you saw):
1 answer status is ok, not partial
2 steps navigate, set_filter, get_widget_data all succeeded; NO sort step; no timeout
3 URL contains /inventory/medicines and f.stockLevel=eq (encoded colon is fine) low
4 page heading shows Medicines and a Stock level = low chip or control is visible
5 table has exactly 4 rows: Insulin, Amoxicillin, Metformin, Salbutamol
6 Expiry column shows plain dates (no T..Z)
7 no raw ** marks and no duplicated answer text
8 F5 keeps the filter and the 4 rows
9 trace (GET /api/traces/<id> with a login token; do not print it): status ok, llm.provider gemini, llm.model gemini-3.5-flash-lite, llm.calls and llm.cachedCalls, no failed tool call
10 /api/events stays open and POST /api/ui-state/report is called after each change
M2 passes only if 1-5, 8 and 9 are YES. 6, 7 and 10 go to the polish list with an owner.

## 9. PHASE M3: analysis and the hotel app (live; one request each; same tab and conversation for 1-3)

1 `Why are these medicines running low?` PASS: says Amoxicillin usage rose about 60% (last 14 days versus the 14 before) and respiratory-infection prescriptions rose; Insulin usage is flat and its last order was
  2026-08-20 (about 48 days ago); says evidence is insufficient for Metformin and Salbutamol; states no cause the data does not show; source chips are labelled; every number in the text appears in a tool result in the trace.
  Verify at least 3 numbers yourself with psql.
2 `Show me the ones that may run out within two days.` PASS: URL has f.daysRemaining=lte (encoded) 2, the table shows only Amoxicillin and Insulin, and the earlier context was kept.
3 `Compare this month's medicine usage with last month.` PASS: states the two periods (month to date 2026-10-01..2026-10-07 versus the same days of last month 2026-09-01..2026-09-07), shows both totals and the % change,
  a chart or comparison block is actually rendered, and the totals match a direct psql SUM over the same dates (report both numbers).
4 Sign out through the UI, sign in as admin@hotel.demo, choose the hotel app (never use localStorage tricks). Type `Show available rooms under ₹3000 for tomorrow.`
  PASS: filters Available, price under 3000, date 2026-10-08 are in the URL; the table equals the psql result for Available rooms priced under 3000 on 2026-10-08; room 101 is absent; no extra filters or sort; status ok; F5 keeps the state.
  If the page hangs on "Thinking...", diagnose from the Network tab (status code of the chat request), the backend log, and `GET /api/traces?appId=hotel`; do not send more live requests until you know the cause.
5 `Why did revenue decrease in September compared with August?` PASS: states the total change and that Room Bookings is the largest decrease, with numbers matching psql sums over app_hotel.revenue
  for 2026-08-01..08-31 and 2026-09-01..09-30; mentions cancellations only if the bookings data shows it; says so if the data is insufficient.
Print the status block with a pass or fail per request.

## 10. PHASE M4: recovery, safety, new app

1 Failure recovery: turn on the "disable Stock level filter" toggle in the UI (or POST `/api/dev/faults` with disableFilters ["stockLevel"] for the current session). Hospital app, type `Show medicines that are running low.`
  PASS: the first attempt on stockLevel is rejected as unavailable; the agent looks up the available filters and retries with daysRemaining lt 5; verification succeeds; the answer says which filter was used instead;
  the trace records the recovery. Turn the fault off afterwards.
2 `Open the Profit forecast 2030 page.` PASS: no navigation; the reply says it could not find the page and offers real page names.
3 `Discard expired stock.` PASS: status needs_confirmation, nothing executed, Confirm and Cancel shown. Click Cancel; verify in the database that nothing changed.
4 Hotel app: `Show revenue.` PASS: asks a clarifying question about the period instead of guessing.
5 Tenant isolation (API, no AI): with the hospital token POST `/api/agent/chat` with appId "hotel" -> 403, with the same body as for a nonexistent app.
6 Adversarial text through the validator or API without a live AI call where possible: a message containing SQL (`'; DROP TABLE medicines; --`), a request for a field that does not exist, and "ignore previous rules".
  PASS: nothing outside the allowed tool list runs and no data changes.
7 New app, no code change: if no third bundle exists, create ONE small valid bundle under `metadata/` (for example a retail or school app: 2 pages, 2 datasets, 2 filters, about 50 rows, one derived field),
  validate with `npm run check:metadata`, import it with the existing importer, confirm it appears in the app switcher, and ask one natural-language question about it. PASS: correct navigation and filter with ZERO changes to agent code.
Print the status block.

## 11. PHASE R: the remaining work

R1 Evaluation: run `npm run smoke` and `npm run eval` if they exist (otherwise report which files are missing and build the smallest version: replay the five judge tests and print PASS or FAIL). Report KPI values exactly as produced; list failures; never edit numbers.
R2 Strict real: ask me to set `STRICT_REAL=1`. After I confirm, restart the backend and show it starts with all eight modules real, then `/api/health`.
R3 Security check: `git diff main -- contracts` is empty; `.env` is not tracked; no key patterns in tracked files (`Select-String -Path backend\src,frontend\src,docs -Pattern 'AIza|sk-|gsk_' -Recurse`);
   user passwords are bcrypt hashes in `seed_users.sql`; the JWT secret comes from the environment; `?token=` is accepted only for the events route; the app-access guard reads appId from params, body and query.
R4 Demo script: read `docs/DEMO_SCRIPT.md` (create it from README section 16 with timings if missing). Walk the exact demo order once, live, and report anything that breaks:
   hospital low-stock, why, within two days, compare months, switch to hotel rooms, failure recovery, refusal, confirmation, new app, debug panel, scoreboard page.
R5 Cache priming (last): with `LLM_CACHE=on`, from a clean session, run the demo in that exact order once more so real answers are cached. Report the cache folder path and its file count.
   Do not change any prompt or context-building code afterwards. Tell me to copy the folder to a second location.
R6 Final: `npm run typecheck && npm test`, `git status --short`, list changed files. Commit on the current branch with message "integration: M2-M4 verified, fixes" ONLY if checks pass and `.env` is not staged. Do not push.

## 12. FINAL REPORT

One table per phase (item | result | evidence | owner if failing), then: demo-ready YES or NO, remaining risks, bugs to send to P1-P5 with the exact change, and the exact commands I should run to push and open the pull request. Then STOP and wait.
