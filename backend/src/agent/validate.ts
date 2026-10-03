import type {
  AgentTurn,
  AppMetadata,
  ErrorCode,
  Filter,
  Page,
  ToolCall,
  UiState,
} from "@cab/contracts";
import { defaultOps, getDataset, getPage, getWidget, isDateToken } from "@cab/contracts";

export interface PlanValidationError {
  stepIndex: number;
  code: ErrorCode;
  message: string;
  candidates?: string[];
}

export interface PlanValidationResult {
  ok: boolean;
  errors: PlanValidationError[];
  normalizedTurn: AgentTurn;
  destructiveActions: Array<{ stepIndex: number; actionId: string; description: string }>;
}

function stringSimilarity(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (q === t) return 1.0;
  if (t.includes(q) || q.includes(t)) return 0.8;

  const d: number[][] = [];
  for (let i = 0; i <= q.length; i++) d[i] = [i];
  for (let j = 0; j <= t.length; j++) d[0]![j] = j;

  for (let i = 1; i <= q.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = q[i - 1] === t[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }

  const maxLen = Math.max(q.length, t.length);
  return maxLen === 0 ? 1 : 1 - d[q.length]![t.length]! / maxLen;
}

export function findCandidates(
  query: string,
  pool: Array<{ id: string; synonyms?: string[] }>,
  limit = 3,
): string[] {
  const scored = pool.map((item) => {
    let best = stringSimilarity(query, item.id);
    for (const syn of item.synonyms ?? []) {
      const s = stringSimilarity(query, syn);
      if (s > best) best = s;
    }
    return { id: item.id, score: best };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((s) => s.score >= 0.25)
    .slice(0, limit)
    .map((s) => s.id);
}

function resolvePage(app: AppMetadata, target: string): Page | undefined {
  const byIdOrRoute = getPage(app, target);
  if (byIdOrRoute) return byIdOrRoute;

  const lower = target.toLowerCase().trim();
  return app.pages.find((p) => p.name.toLowerCase() === lower);
}

function isRoleAllowed(userRole: string, allowedRoles?: string[]): boolean {
  if (userRole === "admin") return true;
  if (!allowedRoles || allowedRoles.length === 0) return true;
  return allowedRoles.includes(userRole);
}

const DB_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function validatePlan(
  app: AppMetadata,
  ui: UiState | null,
  role: string,
  turn: AgentTurn,
): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const destructiveActions: Array<{ stepIndex: number; actionId: string; description: string }> = [];

  // Deep clone steps for normalization
  const normalizedSteps: ToolCall[] = JSON.parse(JSON.stringify(turn.steps));

  // Track active page through turn steps
  let activePageId: string | undefined = ui?.pageId;

  for (let idx = 0; idx < normalizedSteps.length; idx++) {
    const step = normalizedSteps[idx]!;

    switch (step.tool) {
      case "navigate": {
        const target = step.args.target;
        const page = resolvePage(app, target);
        if (!page) {
          const pagePool = app.pages.map((p) => ({ id: p.id, synonyms: [p.name, p.route] }));
          errors.push({
            stepIndex: idx,
            code: "PAGE_NOT_FOUND",
            message: `Page "${target}" not found in application "${app.name}"`,
            candidates: findCandidates(target, pagePool),
          });
        } else {
          if (!isRoleAllowed(role, page.allowedRoles)) {
            errors.push({
              stepIndex: idx,
              code: "FORBIDDEN",
              message: `Role "${role}" is not authorized to access page "${page.id}"`,
            });
          }
          activePageId = page.id;
        }
        break;
      }

      case "set_filter": {
        const pageId = step.args.pageId ?? activePageId;
        if (!pageId) {
          errors.push({
            stepIndex: idx,
            code: "PAGE_NOT_FOUND",
            message: `Target page for set_filter could not be determined. Please navigate first or specify pageId.`,
          });
          break;
        }

        const page = resolvePage(app, pageId);
        if (!page) {
          const pagePool = app.pages.map((p) => ({ id: p.id, synonyms: [p.name, p.route] }));
          errors.push({
            stepIndex: idx,
            code: "PAGE_NOT_FOUND",
            message: `Page "${pageId}" not found`,
            candidates: findCandidates(pageId, pagePool),
          });
          break;
        }

        const filterId = step.args.filterId;
        const filter = page.filters.find((f) => f.id === filterId);
        if (!filter) {
          const filterPool = page.filters.map((f) => ({ id: f.id, synonyms: [f.label, ...(f.synonyms ?? [])] }));
          errors.push({
            stepIndex: idx,
            code: "FILTER_NOT_FOUND",
            message: `Filter "${filterId}" does not exist on page "${page.id}"`,
            candidates: findCandidates(filterId, filterPool),
          });
          break;
        }

        // Check if filter is disabled in UI (failure demo)
        if (ui?.disabledFilters?.includes(filterId)) {
          const otherFilters = page.filters.filter((f) => !ui.disabledFilters.includes(f.id)).map((f) => f.id);
          errors.push({
            stepIndex: idx,
            code: "FILTER_UNAVAILABLE",
            message: `Filter "${filterId}" is currently disabled in the UI`,
            candidates: otherFilters,
          });
          break;
        }

        // Check operator
        const op: string = step.args.op ?? (defaultOps(filter.type)[0] as string);
        const allowedOps: readonly string[] = (filter.operators ?? defaultOps(filter.type)) as readonly string[];
        if (!allowedOps.includes(op)) {
          errors.push({
            stepIndex: idx,
            code: "INVALID_OPERATOR",
            message: `Operator "${op}" is not allowed for filter "${filterId}" of type "${filter.type}". Allowed: ${allowedOps.join(", ")}`,
            candidates: [...allowedOps],
          });
        }

        // Check value according to filter type
        validateFilterValue(idx, filter, step.args.value, errors, (normalizedVal) => {
          step.args.value = normalizedVal as any;
        });

        break;
      }

      case "clear_filter": {
        const pageId = step.args.pageId ?? activePageId;
        if (!pageId) {
          errors.push({
            stepIndex: idx,
            code: "PAGE_NOT_FOUND",
            message: `Target page for clear_filter could not be determined.`,
          });
          break;
        }

        const page = resolvePage(app, pageId);
        if (!page) {
          errors.push({
            stepIndex: idx,
            code: "PAGE_NOT_FOUND",
            message: `Page "${pageId}" not found`,
          });
          break;
        }

        const filterId = step.args.filterId;
        const filter = page.filters.find((f) => f.id === filterId);
        if (!filter) {
          const filterPool = page.filters.map((f) => ({ id: f.id, synonyms: [f.label, ...(f.synonyms ?? [])] }));
          errors.push({
            stepIndex: idx,
            code: "FILTER_NOT_FOUND",
            message: `Filter "${filterId}" does not exist on page "${page.id}"`,
            candidates: findCandidates(filterId, filterPool),
          });
        }
        break;
      }

      case "set_date_range": {
        const pageId = activePageId;
        const page = pageId ? resolvePage(app, pageId) : undefined;
        const filterId = step.args.filterId;

        if (filterId && page) {
          const filter = page.filters.find((f) => f.id === filterId);
          if (!filter) {
            errors.push({
              stepIndex: idx,
              code: "FILTER_NOT_FOUND",
              message: `Filter "${filterId}" not found on page "${page.id}"`,
            });
          } else if (filter.type !== "date" && filter.type !== "dateRange") {
            errors.push({
              stepIndex: idx,
              code: "INVALID_FILTER_VALUE",
              message: `Filter "${filterId}" is not a date or dateRange filter (type: ${filter.type})`,
            });
          }
        }

        if (step.args.token && !isDateToken(step.args.token)) {
          errors.push({
            stepIndex: idx,
            code: "INVALID_FILTER_VALUE",
            message: `"${step.args.token}" is not a recognized DateToken`,
          });
        }

        if (step.args.start && !ISO_DATE_REGEX.test(step.args.start)) {
          errors.push({
            stepIndex: idx,
            code: "INVALID_FILTER_VALUE",
            message: `start date "${step.args.start}" must be in YYYY-MM-DD format`,
          });
        }

        if (step.args.end && !ISO_DATE_REGEX.test(step.args.end)) {
          errors.push({
            stepIndex: idx,
            code: "INVALID_FILTER_VALUE",
            message: `end date "${step.args.end}" must be in YYYY-MM-DD format`,
          });
        }
        break;
      }

      case "sort": {
        const widgetId = step.args.widgetId;
        const field = step.args.field;

        if (widgetId) {
          const widgetInfo = getWidget(app, widgetId);
          if (!widgetInfo) {
            errors.push({
              stepIndex: idx,
              code: "WIDGET_NOT_FOUND",
              message: `Widget "${widgetId}" not found in application`,
            });
          } else {
            if (!widgetInfo.widget.sortable.includes(field)) {
              errors.push({
                stepIndex: idx,
                code: "FIELD_NOT_ALLOWED",
                message: `Field "${field}" is not sortable on widget "${widgetId}". Sortable fields: ${widgetInfo.widget.sortable.join(", ")}`,
                candidates: [...widgetInfo.widget.sortable],
              });
            }
          }
        } else if (activePageId) {
          const page = resolvePage(app, activePageId);
          const candidateWidgets = page?.widgets.filter((w) => w.sortable.includes(field));
          if (!candidateWidgets || candidateWidgets.length === 0) {
            const allSortable = page?.widgets.flatMap((w) => w.sortable) ?? [];
            errors.push({
              stepIndex: idx,
              code: "FIELD_NOT_ALLOWED",
              message: `Field "${field}" is not sortable on active page "${activePageId}"`,
              candidates: [...new Set(allSortable)],
            });
          }
        }
        break;
      }

      case "get_widget_data": {
        const widgetId = step.args.widgetId;
        const widgetInfo = getWidget(app, widgetId);
        if (!widgetInfo) {
          errors.push({
            stepIndex: idx,
            code: "WIDGET_NOT_FOUND",
            message: `Widget "${widgetId}" not found in application`,
          });
        }
        break;
      }

      case "query_business_data": {
        const spec = step.args.spec;
        const dataset = getDataset(app, spec.dataset);
        if (!dataset) {
          errors.push({
            stepIndex: idx,
            code: "DATASET_NOT_FOUND",
            message: `Dataset "${spec.dataset}" not found in application`,
            candidates: app.datasets.map((d) => d.name),
          });
          break;
        }

        const validFields = new Set(dataset.fields.map((f) => f.name));

        // Validate select fields
        for (const sel of spec.select ?? []) {
          if (!DB_NAME_REGEX.test(sel) || !validFields.has(sel)) {
            errors.push({
              stepIndex: idx,
              code: "FIELD_NOT_ALLOWED",
              message: `Selected field "${sel}" does not exist in dataset "${dataset.name}"`,
              candidates: Array.from(validFields),
            });
          }
        }

        // Validate where condition fields
        for (const cond of spec.where ?? []) {
          if (!DB_NAME_REGEX.test(cond.field) || !validFields.has(cond.field)) {
            errors.push({
              stepIndex: idx,
              code: "FIELD_NOT_ALLOWED",
              message: `Condition field "${cond.field}" does not exist in dataset "${dataset.name}"`,
              candidates: Array.from(validFields),
            });
          }
        }

        // Validate groupBy fields
        for (const g of spec.groupBy ?? []) {
          if (!DB_NAME_REGEX.test(g.field) || !validFields.has(g.field)) {
            errors.push({
              stepIndex: idx,
              code: "FIELD_NOT_ALLOWED",
              message: `Group-by field "${g.field}" does not exist in dataset "${dataset.name}"`,
              candidates: Array.from(validFields),
            });
          }
        }

        // Validate metrics fields
        const metricAliases = new Set<string>();
        for (const m of spec.metrics ?? []) {
          if (!DB_NAME_REGEX.test(m.field) || !validFields.has(m.field)) {
            errors.push({
              stepIndex: idx,
              code: "FIELD_NOT_ALLOWED",
              message: `Metric field "${m.field}" does not exist in dataset "${dataset.name}"`,
              candidates: Array.from(validFields),
            });
          }
          if (m.as) metricAliases.add(m.as);
        }

        // Validate orderBy fields
        for (const ord of spec.orderBy ?? []) {
          if (!validFields.has(ord.field) && !metricAliases.has(ord.field)) {
            errors.push({
              stepIndex: idx,
              code: "FIELD_NOT_ALLOWED",
              message: `Order-by field "${ord.field}" is neither a valid dataset field nor a metric alias in "${dataset.name}"`,
              candidates: Array.from(validFields),
            });
          }
        }
        break;
      }

      case "run_analysis": {
        const spec = step.args.spec;
        const dataset = getDataset(app, spec.dataset);
        if (!dataset) {
          errors.push({
            stepIndex: idx,
            code: "DATASET_NOT_FOUND",
            message: `Dataset "${spec.dataset}" not found in application`,
            candidates: app.datasets.map((d) => d.name),
          });
          break;
        }

        const validFields = new Set(dataset.fields.map((f) => f.name));
        if (!validFields.has(spec.metric.field)) {
          errors.push({
            stepIndex: idx,
            code: "FIELD_NOT_ALLOWED",
            message: `Metric field "${spec.metric.field}" not found in dataset "${dataset.name}"`,
            candidates: Array.from(validFields),
          });
        }

        if (spec.dateField && !validFields.has(spec.dateField)) {
          errors.push({
            stepIndex: idx,
            code: "FIELD_NOT_ALLOWED",
            message: `Date field "${spec.dateField}" not found in dataset "${dataset.name}"`,
            candidates: Array.from(validFields),
          });
        }

        if ("breakdownBy" in spec && spec.breakdownBy) {
          for (const b of spec.breakdownBy) {
            if (!validFields.has(b)) {
              errors.push({
                stepIndex: idx,
                code: "FIELD_NOT_ALLOWED",
                message: `Breakdown field "${b}" not found in dataset "${dataset.name}"`,
                candidates: Array.from(validFields),
              });
            }
          }
        }

        if ("by" in spec && spec.by && !validFields.has(spec.by)) {
          errors.push({
            stepIndex: idx,
            code: "FIELD_NOT_ALLOWED",
            message: `Rank by field "${spec.by}" not found in dataset "${dataset.name}"`,
            candidates: Array.from(validFields),
          });
        }
        break;
      }

      case "invoke_app_action": {
        const actionId = step.args.actionId;
        const action = app.actions.find((a) => a.id === actionId);
        if (!action) {
          errors.push({
            stepIndex: idx,
            code: "FORBIDDEN",
            message: `Application action "${actionId}" not found`,
            candidates: app.actions.map((a) => a.id),
          });
          break;
        }

        if (!isRoleAllowed(role, [action.requiredRole])) {
          errors.push({
            stepIndex: idx,
            code: "FORBIDDEN",
            message: `Action "${actionId}" requires role "${action.requiredRole}", current role is "${role}"`,
          });
        }

        if (action.destructive) {
          destructiveActions.push({
            stepIndex: idx,
            actionId: action.id,
            description: action.description || action.label,
          });
        }
        break;
      }

      case "get_page_details": {
        const page = resolvePage(app, step.args.pageId);
        if (!page) {
          errors.push({
            stepIndex: idx,
            code: "PAGE_NOT_FOUND",
            message: `Page "${step.args.pageId}" not found`,
            candidates: app.pages.map((p) => p.id),
          });
        }
        break;
      }

      case "get_available_filters": {
        if (step.args.pageId) {
          const page = resolvePage(app, step.args.pageId);
          if (!page) {
            errors.push({
              stepIndex: idx,
              code: "PAGE_NOT_FOUND",
              message: `Page "${step.args.pageId}" not found`,
              candidates: app.pages.map((p) => p.id),
            });
          }
        }
        break;
      }

      default:
        break;
    }
  }

  const normalizedTurn: AgentTurn = {
    ...turn,
    steps: normalizedSteps,
  };

  return {
    ok: errors.length === 0,
    errors,
    normalizedTurn,
    destructiveActions,
  };
}

function validateFilterValue(
  stepIndex: number,
  filter: Filter,
  value: unknown,
  errors: PlanValidationError[],
  onNormalize: (normalizedValue: unknown) => void,
): void {
  if (filter.type === "enum") {
    const options = filter.options ?? [];
    const validValues = options.map((o) => o.value);

    function normalizeSingle(val: unknown): string | null {
      const s = String(val).toLowerCase().trim();
      for (const opt of options) {
        if (opt.value.toLowerCase() === s) return opt.value;
        if (opt.label.toLowerCase() === s) return opt.value;
        if (opt.synonyms?.some((syn) => syn.toLowerCase() === s)) return opt.value;
      }
      return null;
    }

    if (Array.isArray(value)) {
      const normalizedArr: string[] = [];
      for (const item of value) {
        const norm = normalizeSingle(item);
        if (!norm) {
          errors.push({
            stepIndex,
            code: "INVALID_FILTER_VALUE",
            message: `Value "${item}" is not a valid option for enum filter "${filter.id}". Allowed options: ${validValues.join(", ")}`,
            candidates: validValues,
          });
        } else {
          normalizedArr.push(norm);
        }
      }
      onNormalize(normalizedArr);
    } else {
      const norm = normalizeSingle(value);
      if (!norm) {
        errors.push({
          stepIndex,
          code: "INVALID_FILTER_VALUE",
          message: `Value "${value}" is not a valid option for enum filter "${filter.id}". Allowed options: ${validValues.join(", ")}`,
          candidates: validValues,
        });
      } else {
        onNormalize(norm);
      }
    }
    return;
  }

  if (filter.type === "number") {
    const isNum = (v: unknown) => typeof v === "number" || (!isNaN(Number(v)) && String(v).trim() !== "");
    if (Array.isArray(value)) {
      if (!value.every(isNum)) {
        errors.push({
          stepIndex,
          code: "INVALID_FILTER_VALUE",
          message: `Filter "${filter.id}" expects numeric values`,
        });
      }
    } else if (!isNum(value)) {
      errors.push({
        stepIndex,
        code: "INVALID_FILTER_VALUE",
        message: `Filter "${filter.id}" expects a numeric value, got "${value}"`,
      });
    }
    return;
  }

  if (filter.type === "date" || filter.type === "dateRange") {
    const isDateOrToken = (v: unknown) => isDateToken(v) || (typeof v === "string" && ISO_DATE_REGEX.test(v));
    if (Array.isArray(value)) {
      if (!value.every(isDateOrToken)) {
        errors.push({
          stepIndex,
          code: "INVALID_FILTER_VALUE",
          message: `Filter "${filter.id}" expects ISO dates (YYYY-MM-DD) or DateTokens`,
        });
      }
    } else if (!isDateOrToken(value)) {
      errors.push({
        stepIndex,
        code: "INVALID_FILTER_VALUE",
        message: `Filter "${filter.id}" expects an ISO date (YYYY-MM-DD) or DateToken, got "${value}"`,
      });
    }
    return;
  }

  if (filter.type === "boolean") {
    const isBool = (v: unknown) => typeof v === "boolean" || v === "true" || v === "false";
    if (!isBool(value)) {
      errors.push({
        stepIndex,
        code: "INVALID_FILTER_VALUE",
        message: `Filter "${filter.id}" expects a boolean value, got "${value}"`,
      });
    }
  }
}
