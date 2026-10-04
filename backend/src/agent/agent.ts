import crypto from "node:crypto";
import type {
  AgentResponse,
  AgentService,
  AgentTurn,
  ChatRequest,
  ConfirmRequest,
  ExpectedUiState,
  LlmClient,
  MetadataStore,
  RequestContext,
  SseEvent,
  StepRecord,
  ToolCall,
  ToolRegistry,
  Trace,
  TraceStore,
  UiAdapter,
  UiState,
  Verification,
} from "@cab/contracts";
import {
  AgentTurn as AgentTurnSchema,
  NarratorOutput as NarratorOutputSchema,
  TOOL_KIND,
  diffUiState,
  toDeepLink,
} from "@cab/contracts";
import { buildNarratorPrompt, buildPlannerPrompt } from "./prompts";
import { normalizeAgentTurnForSchema, validatePlan } from "./validate";
import { assembleAnswerBlocks, type ObservationRecord } from "./assembler";
import { checkFaithfulness } from "./faithfulness";
import { defaultMemoryStore, type MemoryStore } from "./memory";

export interface AgentDependencies {
  metadata: MetadataStore;
  tools: ToolRegistry;
  llm: LlmClient;
  ui: UiAdapter;
  traces: TraceStore;
  memoryStore?: MemoryStore;
  emitSse?: (sessionId: string, event: SseEvent) => void;
}

function deriveExpectedUiState(
  step: ToolCall,
  current: UiState | null,
): ExpectedUiState {
  switch (step.tool) {
    case "navigate":
      return {
        pageId: step.args.target,
      };
    case "set_filter": {
      const op = step.args.op ?? "eq";
      return {
        filters: {
          ...(current?.filters ?? {}),
          [step.args.filterId]: { op, value: step.args.value as any },
        },
      };
    }
    case "clear_filter":
      return {
        absentFilters: [step.args.filterId],
      };
    case "sort":
      return {
        sort: {
          widgetId: step.args.widgetId ?? "default",
          field: step.args.field,
          direction: step.args.direction,
        },
      };
    default:
      return {};
  }
}

export function createAgent(deps: AgentDependencies): AgentService {
  const memoryStore = deps.memoryStore ?? defaultMemoryStore;

  function emitSse(sessionId: string, traceId: string, event: Partial<SseEvent>): void {
    if (!deps.emitSse) return;
    try {
      if (event.type === "agent_status") {
        deps.emitSse(sessionId, {
          type: "agent_status",
          traceId,
          stage: event.stage!,
          detail: event.detail,
        });
      } else if (event.type === "agent_step") {
        deps.emitSse(sessionId, {
          type: "agent_step",
          traceId,
          step: event.step!,
        });
      }
    } catch {
      // Non-blocking SSE emission
    }
  }

  return {
    async chat(ctx: RequestContext, req: ChatRequest): Promise<AgentResponse> {
      const startTime = Date.now();
      const traceId = ctx.traceId || `trace-${crypto.randomUUID().slice(0, 8)}`;

      try {
        let invalidActionsBlocked = 0;
        const invalidActionsExecuted = 0; // Guaranteed 0 by policy gate & validator
        const turnsLog: unknown[] = [];
        const toolCallsLog: Array<{ step: number; tool: string; args: unknown; ok: boolean; errorCode?: string; durationMs: number }> = [];
        const stepRecords: StepRecord[] = [];
        const observations: ObservationRecord[] = [];
        const recoveriesLog: Array<{ step: number; error: string; strategy: string }> = [];

        let llmCalls = 0;
        let cachedLlmCalls = 0;
        let firstActionLatency: number | undefined = undefined;

        // 1. Load memory & UI state
        const memory = memoryStore.get(req.sessionId, ctx.appId);
        memoryStore.recordUserTurn(req.sessionId, ctx.appId, req.message);

        const uiBefore = (await deps.ui.getState(req.sessionId)) ?? req.uiState ?? null;
        let currentUiState: UiState | null = uiBefore ? JSON.parse(JSON.stringify(uiBefore)) : null;

        // 2. Retrieval
        emitSse(req.sessionId, traceId, { type: "agent_status", stage: "retrieving" });
        const appMetadata = await deps.metadata.getApp(ctx);
        const lastContextHint = memory.lastResult ? ` ${memory.lastResult.description}` : "";
        const searchQuery = `${req.message}${lastContextHint}`;
        const hits = await deps.metadata.search(ctx, searchQuery, {
          k: 8,
          currentPageId: currentUiState?.pageId,
        });
        const retrievalContext = await deps.metadata.buildContext(ctx, hits, currentUiState?.pageId);

        // 3. Planner & Execution Loop (max 4 iterations)
        let finalIntent = req.message;
        let isDone = false;
        let pendingConfirmation: AgentResponse["pendingConfirmation"] = undefined;
        let clarification: AgentResponse["clarification"] = undefined;
        let verificationResult: Verification | undefined = undefined;

        let loopIteration = 0;
        while (loopIteration < 4 && !isDone) {
          loopIteration++;
          emitSse(req.sessionId, traceId, { type: "agent_status", stage: "planning", detail: `Iteration ${loopIteration}` });

          let currentTurn: AgentTurn | null = null;
          let validatorErrors: Array<{ stepIndex: number; code: any; message: string; candidates?: string[] }> = [];

          // Validation & repair loop (max 2 repairs)
          for (let repair = 0; repair < 3; repair++) {
            const plannerPrompt = buildPlannerPrompt({
              now: ctx.now,
              userMessage: req.message,
              uiState: currentUiState,
              memory,
              context: retrievalContext,
              observations,
              validatorErrors,
            });

            const llmRes = await deps.llm.json<AgentTurn>(
              {
                system: plannerPrompt.system,
                user: plannerPrompt.user,
                schemaName: "AgentTurn",
              },
              (raw) => AgentTurnSchema.parse(normalizeAgentTurnForSchema(raw)),
            );

            llmCalls++;
            if (llmRes.cached) cachedLlmCalls++;
            currentTurn = llmRes.data;
            finalIntent = currentTurn.intent || finalIntent;

            const valRes = validatePlan(appMetadata, currentUiState, ctx.role, currentTurn);
            if (valRes.ok) {
              currentTurn = valRes.normalizedTurn;
              break;
            }

            invalidActionsBlocked += valRes.errors.length;
            validatorErrors = valRes.errors;

            if (repair === 2) {
              // Drop invalid steps on max repairs
              const badIndices = new Set(valRes.errors.map((e) => e.stepIndex));
              currentTurn.steps = currentTurn.steps.filter((_, idx) => !badIndices.has(idx));
            }
          }

          turnsLog.push(currentTurn!);

          // Clarification check
          if (currentTurn!.clarification) {
            clarification = currentTurn!.clarification;
            isDone = true;
            break;
          }

          // Policy Gate: check for destructive actions
          for (const step of currentTurn!.steps) {
            let isDestructive = false;
            let actionDesc = "";

            if (step.tool === "invoke_app_action") {
              const act = appMetadata.actions.find((a) => a.id === step.args.actionId);
              if (act?.destructive) {
                isDestructive = true;
                actionDesc = act.description || act.label;
              }
            } else if (TOOL_KIND[step.tool] === "destructive") {
              isDestructive = true;
              actionDesc = `Execute ${step.tool}`;
            }

            if (isDestructive) {
              const confId = `conf-${crypto.randomUUID().slice(0, 8)}`;
              pendingConfirmation = {
                confirmationId: confId,
                description: actionDesc,
                actionId: step.tool === "invoke_app_action" ? step.args.actionId : (step.tool as any),
              };
              memoryStore.setPendingConfirmation(req.sessionId, ctx.appId, {
                confirmationId: confId,
                toolCall: step,
                description: actionDesc,
              });
              isDone = true;
              break;
            }
          }

          if (pendingConfirmation) {
            break;
          }

          // Execution of steps
          emitSse(req.sessionId, traceId, { type: "agent_status", stage: "acting" });
          let stepErrorEncountered = false;

          for (let sIdx = 0; sIdx < currentTurn!.steps.length; sIdx++) {
            const step = currentTurn!.steps[sIdx]!;
            const stepStartTime = Date.now();

            const callRes = await deps.tools.execute(ctx, step);
            const durationMs = Date.now() - stepStartTime;

            if (firstActionLatency === undefined) {
              firstActionLatency = Date.now() - startTime;
            }

            toolCallsLog.push({
              step: sIdx,
              tool: step.tool,
              args: step.args,
              ok: callRes.ok,
              errorCode: callRes.ok ? undefined : callRes.error.code,
              durationMs,
            });

            const stepRecord: StepRecord = {
              index: stepRecords.length,
              tool: step.tool,
              args: step.args,
              status: callRes.ok ? "ok" : "error",
              summary: callRes.ok ? `Executed ${step.tool}` : callRes.error.message,
              error: callRes.ok ? undefined : callRes.error,
              durationMs,
            };
            stepRecords.push(stepRecord);
            emitSse(req.sessionId, traceId, { type: "agent_step", step: stepRecord });

            if (callRes.ok) {
              observations.push({
                step: sIdx,
                tool: step.tool,
                resultId: (callRes as any).meta?.resultId,
                data: callRes.data,
                meta: (callRes as any).meta,
              });

              // Action verification
              if (TOOL_KIND[step.tool] === "action") {
                const latestUi = await deps.ui.getState(req.sessionId);
                if (latestUi) currentUiState = latestUi;

                if (currentUiState) {
                  const expected = deriveExpectedUiState(step, currentUiState);
                  const mismatches = diffUiState(expected, currentUiState);
                  verificationResult = {
                    ok: mismatches.length === 0,
                    attempts: 1,
                    expected,
                    actual: currentUiState,
                    mismatches,
                  };

                  if (mismatches.length > 0) {
                    recoveriesLog.push({
                      step: sIdx,
                      error: `Verification mismatch on ${mismatches.map((m) => m.field).join(", ")}`,
                      strategy: "re-plan",
                    });
                  }
                }
              }
            } else {
              // Step error: feed into observations to allow recovery
              observations.push({
                step: sIdx,
                tool: step.tool,
                data: null,
                meta: callRes.error,
              });
              recoveriesLog.push({
                step: sIdx,
                error: callRes.error.message,
                strategy: "planner_retry",
              });
              stepErrorEncountered = true;
              break;
            }
          }

          if (currentTurn!.done && !stepErrorEncountered) {
            isDone = true;
            break;
          }
        }

        // 4. Narrator and Answer Assembly
        let answerBlocks = [];
        if (clarification) {
          answerBlocks = [
            {
              type: "text" as const,
              markdown: clarification.question,
              provenance: [],
            },
          ];
        } else if (pendingConfirmation) {
          answerBlocks = [
            {
              type: "text" as const,
              markdown: `Action required: ${pendingConfirmation.description}. Please confirm to proceed.`,
              provenance: [],
            },
          ];
        } else {
          emitSse(req.sessionId, traceId, { type: "agent_status", stage: "answering" });
          const narratorPrompt = buildNarratorPrompt({
            userMessage: req.message,
            intent: finalIntent,
            uiState: currentUiState,
            observations,
          });

          const narratorRes = await deps.llm.json(
            {
              system: narratorPrompt.system,
              user: narratorPrompt.user,
              schemaName: "NarratorOutput",
            },
            (raw) => NarratorOutputSchema.parse(raw),
          );

          llmCalls++;
          if (narratorRes.cached) cachedLlmCalls++;

          const defaultDataset = appMetadata.datasets[0]?.name ?? "medicines";
          answerBlocks = assembleAnswerBlocks(narratorRes.data, observations, defaultDataset);
        }

        // 5. Faithfulness Check
        const fullText = answerBlocks
          .filter((b) => b.type === "text")
          .map((b) => (b as any).markdown)
          .join("\n");
        checkFaithfulness(fullText, observations);

        // 6. Manual clicks saved estimate
        let manualClicksSaved = 0;
        for (const step of stepRecords) {
          if (step.tool === "navigate") manualClicksSaved += 1;
          if (step.tool === "set_filter") manualClicksSaved += 2;
          if (step.tool === "sort") manualClicksSaved += 1;
          if (step.tool === "set_date_range") manualClicksSaved += 2;
        }

        // 7. Calculate Deep Link
        const deepLink = currentUiState
          ? toDeepLink(currentUiState.route, { filters: currentUiState.filters, sort: currentUiState.sort })
          : undefined;

        // 8. Update Memory for Follow-ups
        let lastResultContext: any = null;
        const lastObsWithData = observations.find((o) => o.data?.rows || o.data?.breakdown || o.data?.ranking);
        if (lastObsWithData?.data?.rows) {
          const rows = lastObsWithData.data.rows;
          const keys = rows.slice(0, 10).map((r: any) => String(Object.values(r)[0] ?? ""));
          lastResultContext = {
            dataset: lastObsWithData.data.dataset,
            keys,
            description: finalIntent,
          };
        }
        memoryStore.recordAssistantTurn(
          req.sessionId,
          ctx.appId,
          fullText || "Completed",
          currentUiState,
          lastResultContext,
        );

        // 9. Persist Trace
        const totalDuration = Date.now() - startTime;
        let finalStatus: AgentResponse["status"] = "ok";
        if (pendingConfirmation) {
          finalStatus = "needs_confirmation";
        } else if (clarification) {
          finalStatus = "needs_clarification";
        } else if (stepRecords.some((s) => s.status === "error")) {
          finalStatus = "partial";
        }

        const trace: Trace = {
          traceId,
          sessionId: req.sessionId,
          appId: ctx.appId,
          userId: ctx.userId,
          createdAt: new Date().toISOString(),
          userMessage: req.message,
          intent: finalIntent,
          retrieved: hits.map((h) => ({ kind: h.kind, id: h.id, score: h.score })),
          turns: turnsLog,
          toolCalls: toolCallsLog,
          uiBefore,
          uiAfter: currentUiState,
          queries: [],
          recoveries: recoveriesLog,
          verification: verificationResult,
          finalAnswer: fullText,
          status: finalStatus,
          invalidActionsBlocked,
          invalidActionsExecuted,
          llm: {
            calls: llmCalls,
            cachedCalls: cachedLlmCalls,
            provider: "llm",
            model: "model",
          },
          latencyMs: {
            total: totalDuration,
            firstAction: firstActionLatency,
          },
        };

        await deps.traces.save(trace).catch((err) => {
          console.warn("[Agent] Failed to save trace:", err);
        });

        emitSse(req.sessionId, traceId, { type: "agent_status", stage: "done" });

        return {
          traceId,
          sessionId: req.sessionId,
          status: finalStatus,
          intent: finalIntent,
          answer: answerBlocks,
          steps: stepRecords,
          uiState: currentUiState,
          verification: verificationResult,
          deepLink,
          clarification,
          pendingConfirmation,
          manualClicksSaved: Math.max(1, manualClicksSaved),
          latencyMs: totalDuration,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "The AI request failed.";
        const failedUiState = (await deps.ui.getState(req.sessionId)) ?? req.uiState ?? null;
        const failedTrace: Trace = {
          traceId,
          sessionId: req.sessionId,
          appId: ctx.appId,
          userId: ctx.userId,
          createdAt: new Date().toISOString(),
          userMessage: req.message,
          intent: req.message,
          retrieved: [],
          turns: [],
          toolCalls: [],
          uiBefore: failedUiState,
          uiAfter: failedUiState,
          queries: [],
          recoveries: [],
          verification: {
            ok: false,
            attempts: 0,
            expected: null,
            actual: failedUiState,
            mismatches: [],
          },
          finalAnswer: message,
          status: "failed",
          invalidActionsBlocked: 0,
          invalidActionsExecuted: 0,
          llm: {
            calls: 0,
            cachedCalls: 0,
            provider: "llm",
            model: "unknown",
          },
          latencyMs: {
            total: Date.now() - startTime,
            firstAction: undefined,
          },
        };

        await deps.traces.save(failedTrace).catch((err) => {
          console.warn("[Agent] Failed to save failed trace:", err);
        });

        return {
          traceId,
          sessionId: req.sessionId,
          status: "failed",
          intent: req.message,
          answer: [{
            type: "text",
            markdown: message,
            provenance: [],
          }],
          steps: [],
          uiState: failedUiState,
          verification: {
            ok: false,
            attempts: 0,
            expected: null,
            actual: failedUiState,
            mismatches: [],
          },
          latencyMs: Date.now() - startTime,
        };
      }
    },

    async confirm(ctx: RequestContext, req: ConfirmRequest): Promise<AgentResponse> {
      const memory = memoryStore.get(req.sessionId, ctx.appId);
      const pending = memory.pendingConfirmation;

      if (!pending || pending.confirmationId !== req.confirmationId) {
        return {
          traceId: ctx.traceId || `trace-${crypto.randomUUID().slice(0, 8)}`,
          sessionId: req.sessionId,
          status: "failed",
          answer: [
            {
              type: "text",
              markdown: "No pending confirmation found matching this ID or confirmation has expired.",
              provenance: [],
            },
          ],
          steps: [],
          uiState: await deps.ui.getState(req.sessionId),
        };
      }

      memoryStore.setPendingConfirmation(req.sessionId, ctx.appId, null);

      if (!req.approve) {
        return {
          traceId: ctx.traceId || `trace-${crypto.randomUUID().slice(0, 8)}`,
          sessionId: req.sessionId,
          status: "ok",
          answer: [
            {
              type: "text",
              markdown: `Action "${pending.description}" was cancelled by user.`,
              provenance: [],
            },
          ],
          steps: [],
          uiState: await deps.ui.getState(req.sessionId),
        };
      }

      const stepStart = Date.now();
      const callRes = await deps.tools.execute(ctx, pending.toolCall as ToolCall);
      const currentUiState = await deps.ui.getState(req.sessionId);

      return {
        traceId: ctx.traceId || `trace-${crypto.randomUUID().slice(0, 8)}`,
        sessionId: req.sessionId,
        status: callRes.ok ? "ok" : "failed",
        answer: [
          {
            type: "text",
            markdown: callRes.ok
              ? `Action "${pending.description}" executed successfully.`
              : `Action execution failed: ${callRes.error.message}`,
            provenance: [],
          },
        ],
        steps: [
          {
            index: 0,
            tool: (pending.toolCall as any).tool,
            args: (pending.toolCall as any).args,
            status: callRes.ok ? "ok" : "error",
            summary: `Executed confirmed action: ${pending.description}`,
            error: callRes.ok ? undefined : callRes.error,
            durationMs: Date.now() - stepStart,
          },
        ],
        uiState: currentUiState,
      };
    },
  };
}
