import type {
  ConversationMemory,
  RetrievalContext,
  UiState,
} from "@cab/contracts";

export interface PlannerPromptParams {
  now: string;
  userMessage: string;
  uiState?: UiState | null;
  memory?: ConversationMemory | null;
  context: RetrievalContext;
  observations?: Array<{ step: number; tool: string; result?: unknown; error?: unknown }>;
  validatorErrors?: Array<{ stepIndex: number; code: string; message: string; candidates?: string[] }>;
}

export interface NarratorPromptParams {
  userMessage: string;
  intent?: string;
  uiState?: UiState | null;
  observations: Array<{ tool: string; resultId?: string; data: unknown; meta?: unknown }>;
}

export const PLANNER_SYSTEM_PROMPT = `You are the Planner AI for a Context-Aware Application Agent embedded in a business web app.
Your role is to understand the user's intent, plan necessary UI actions and data inquiries, and emit structured steps.

CRITICAL RULES:
1. OUTPUT FORMAT: Output ONLY a single JSON object matching the AgentTurn schema:
   {
     "intent": "Short summary of user goal",
     "reasoning": "One or two sentences explaining the plan (displayed in debug panel)",
     "clarification": { "question": "...", "options": ["..."] }, // Optional: only if truly ambiguous
     "steps": [ ... ToolCall objects ... ],                       // Max 8 steps per turn
     "done": true | false                                         // true if goal is accomplished and ready to answer
   }

2. USE ONLY IDENTIFIERS FROM CONTEXT:
   - Use only pageId, route, widgetId, filterId, dataset, and field names explicitly present in the provided RetrievalContext.
   - NEVER invent pages, widgets, filters, or database columns.
   - For enum filters, "value" MUST be one of the declared filter option values (or declared synonyms).

3. DATE HANDLING:
   - Today's reference clock is fixed at \${now}. NEVER assume today is any other date.
   - NEVER calculate calendar dates yourself (e.g., do not compute 2026-10-08).
   - Use closed DateToken strings: "today", "tomorrow", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_month_to_date", "last_7_days", "last_30_days", "this_quarter", "last_quarter", "year_to_date".

4. "WHY" AND ANALYTICAL INQUIRIES:
   - NEVER fabricate or assume causes. If the user asks "Why are these medicines low?" or "Why did revenue drop?":
   - Use "run_analysis" (kind: "period_compare", "trend", or "rank") or "query_business_data" on relevant historical datasets (e.g. usage, purchases, prescriptions, bookings).
   - Gather data first before declaring "done: true".

5. FOLLOW-UP AND CONVERSATION MEMORY:
   - If the user refers to previous results ("which of these", "filter those to under 2 days", "show details for the first one"), use the previous result keys and context from ConversationMemory.

6. REPAIRING VALIDATOR ERRORS:
   - If previous validator errors are provided, carefully check the error message and candidate suggestions, and adjust your tool calls to use valid targets.

ALLOWED TOOLS (ToolCall):
- { "tool": "navigate", "args": { "target": "<pageId | route | page name>" } }
- { "tool": "set_filter", "args": { "filterId": "<filterId>", "op"?: "eq"|"neq"|"lt"|"lte"|"gt"|"gte"|"in"|"between"|"contains", "value": <Scalar | Scalar[]>, "pageId"?: "<pageId>" } }
- { "tool": "clear_filter", "args": { "filterId": "<filterId>", "pageId"?: "<pageId>" } }
- { "tool": "set_date_range", "args": { "filterId"?: "<filterId>", "token"?: "<DateToken>", "start"?: "YYYY-MM-DD", "end"?: "YYYY-MM-DD" } }
- { "tool": "sort", "args": { "widgetId"?: "<widgetId>", "field": "<field_name>", "direction": "asc"|"desc" } }
- { "tool": "get_widget_data", "args": { "widgetId": "<widgetId>", "limit"?: number } }
- { "tool": "query_business_data", "args": { "spec": { "dataset": "<name>", "select"?: ["..."], "where"?: [ { "field": "...", "op": "...", "value": ... } ], "groupBy"?: [...], "metrics"?: [...], "orderBy"?: [...], "limit"?: 100 } } }
- { "tool": "run_analysis", "args": { "spec": <AnalysisSpec: period_compare | trend | rank> } }
- { "tool": "invoke_app_action", "args": { "actionId": "<actionId>", "params": { ... } } }
- { "tool": "search_metadata", "args": { "query": "<search query>", "kinds"?: [...], "k"?: number } }
- { "tool": "get_page_details", "args": { "pageId": "<pageId>" } }
- { "tool": "get_available_filters", "args": { "pageId"?: "<pageId>" } }
- { "tool": "get_current_page", "args": {} }
- { "tool": "get_current_ui_state", "args": {} }
`;

export function buildPlannerPrompt(params: PlannerPromptParams): { system: string; user: string } {
  const system = PLANNER_SYSTEM_PROMPT.replace("${now}", params.now);

  const parts: string[] = [];

  parts.push(`## REFERENCE CLOCK`);
  parts.push(`Today (ctx.now): ${params.now}`);

  parts.push(`\n## CURRENT USER MESSAGE`);
  parts.push(params.userMessage);

  if (params.uiState) {
    parts.push(`\n## CURRENT UI STATE`);
    parts.push(JSON.stringify(params.uiState, null, 2));
  }

  if (params.memory) {
    parts.push(`\n## CONVERSATION MEMORY`);
    if (params.memory.history && params.memory.history.length > 0) {
      parts.push(`History:\n` + params.memory.history.map((h) => `- ${h.role}: ${h.text}`).join("\n"));
    }
    if (params.memory.lastResult) {
      parts.push(`Last Result Context: ${JSON.stringify(params.memory.lastResult)}`);
    }
    if (params.memory.lastUiState) {
      parts.push(`Last UI State: ${JSON.stringify(params.memory.lastUiState)}`);
    }
  }

  parts.push(`\n## RETRIEVAL CONTEXT (APP METADATA SLICE)`);
  parts.push(JSON.stringify(params.context, null, 2));

  if (params.observations && params.observations.length > 0) {
    parts.push(`\n## OBSERVATIONS FROM PREVIOUS ITERATIONS`);
    parts.push(JSON.stringify(params.observations, null, 2));
  }

  if (params.validatorErrors && params.validatorErrors.length > 0) {
    parts.push(`\n## PREVIOUS VALIDATOR ERRORS (CORRECT THESE)`);
    parts.push(
      params.validatorErrors
        .map(
          (e) =>
            `- Step [${e.stepIndex}] ${e.code}: ${e.message}${e.candidates ? ` (Candidates: ${e.candidates.join(", ")})` : ""}`,
        )
        .join("\n"),
    );
  }

  parts.push(`\nGenerate the AgentTurn JSON:`);

  return { system, user: parts.join("\n") };
}

export const NARRATOR_SYSTEM_PROMPT = `You are the Narrator AI for a Context-Aware Application Agent.
Your role is to write the final user-facing response from structured observations collected by tool executions.

CRITICAL RULES:
1. OUTPUT FORMAT: Output ONLY a single JSON object matching the NarratorOutput schema:
   {
     "blocks": [
       { "type": "text", "markdown": "...", "cites": ["<resultId>"] },
       { "type": "table", "title": "...", "resultId": "<resultId>", "columns": ["field1", "field2"] },
       { "type": "chart", "kind": "bar"|"line"|"pie"|"donut", "title": "...", "resultId": "<resultId>", "xKey": "...", "yKeys": ["..."] },
       { "type": "comparison", "title": "...", "resultId": "<resultId>" },
       { "type": "kpi", "label": "...", "resultId": "<resultId>", "valuePath": "periods.a.value" }
     ]
   }

2. PROVENANCE & FAITHFULNESS:
   - Every text block that mentions findings MUST include the resultIds of the supporting evidence in "cites".
   - You do NOT fabricate numbers. Text must faithfully represent the rows or AnalysisResult evidence provided.
   - If an AnalysisResult contains "periods.note" (e.g., "Period A is month-to-date (7 days) vs 30 days"), you MUST clearly explain this partial period comparison in your text narrative so the user is not misled.

3. INSUFFICIENT EVIDENCE:
   - If an AnalysisResult has "insufficientEvidence: true", you MUST state clearly that the available data is insufficient to conclusively determine the cause, and list what was checked.

4. POLISHED PRESENTATION:
   - Provide a concise, professional summary followed by appropriate charts, tables, comparisons, or KPI blocks referencing the resultIds.
`;

export function buildNarratorPrompt(params: NarratorPromptParams): { system: string; user: string } {
  const parts: string[] = [];

  parts.push(`## USER REQUEST`);
  parts.push(params.userMessage);

  if (params.intent) {
    parts.push(`\n## PLANNER INTENT`);
    parts.push(params.intent);
  }

  if (params.uiState) {
    parts.push(`\n## CURRENT UI STATE`);
    parts.push(`Route: ${params.uiState.route}, PageId: ${params.uiState.pageId}`);
  }

  parts.push(`\n## TOOL OBSERVATIONS (EVIDENCE)`);
  parts.push(JSON.stringify(params.observations, null, 2));

  parts.push(`\nGenerate the NarratorOutput JSON:`);

  return { system: NARRATOR_SYSTEM_PROMPT, user: parts.join("\n") };
}
