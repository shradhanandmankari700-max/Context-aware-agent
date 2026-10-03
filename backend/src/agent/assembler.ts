import type {
  AnswerBlock,
  NarratorOutput,
  Provenance,
  QueryResult,
  AnalysisResult,
} from "@cab/contracts";

export interface ObservationRecord {
  step: number;
  tool: string;
  resultId?: string;
  data: any;
  meta?: any;
}

export function assembleAnswerBlocks(
  narratorOutput: NarratorOutput,
  observations: ObservationRecord[],
  defaultDataset = "dataset",
): AnswerBlock[] {
  // Build lookup index of observations by resultId / queryId
  const obsByResultId = new Map<string, ObservationRecord>();
  for (const obs of observations) {
    if (obs.resultId) obsByResultId.set(obs.resultId, obs);
    if (obs.meta?.resultId) obsByResultId.set(obs.meta.resultId, obs);
    if (obs.meta?.queryId) obsByResultId.set(obs.meta.queryId, obs);
    if (obs.data?.resultId) obsByResultId.set(obs.data.resultId, obs);
    if (obs.data?.queryId) obsByResultId.set(obs.data.queryId, obs);
  }

  const answerBlocks: AnswerBlock[] = [];

  for (const block of narratorOutput.blocks) {
    switch (block.type) {
      case "text": {
        const provenance: Provenance[] = [];
        for (const citeId of block.cites) {
          const obs = obsByResultId.get(citeId);
          if (obs) {
            provenance.push({
              resultId: citeId,
              dataset: obs.data?.dataset ?? defaultDataset,
              description: `Evidence from ${obs.tool} (${citeId})`,
              widgetId: obs.meta?.widgetId,
              pageId: obs.meta?.pageId,
            });
          }
        }
        answerBlocks.push({
          type: "text",
          markdown: block.markdown,
          provenance,
        });
        break;
      }

      case "table": {
        const obs = obsByResultId.get(block.resultId) ?? observations.find((o) => o.data?.rows);
        const queryRes = obs?.data as QueryResult | undefined;
        const columns = queryRes?.columns ?? (block.columns?.map((c) => ({ name: c, label: c })) ?? []);
        const rows = queryRes?.rows ?? [];

        const provenance: Provenance[] = [
          {
            resultId: block.resultId,
            dataset: queryRes?.dataset ?? defaultDataset,
            description: `Table data for ${queryRes?.dataset ?? block.title}`,
            widgetId: obs?.meta?.widgetId,
            pageId: obs?.meta?.pageId,
          },
        ];

        answerBlocks.push({
          type: "table",
          title: block.title,
          columns,
          rows,
          provenance,
        });
        break;
      }

      case "comparison": {
        const obs = obsByResultId.get(block.resultId) ?? observations.find((o) => o.data?.kind === "period_compare");
        const analysis = obs?.data as AnalysisResult | undefined;

        const aVal = analysis?.periods?.a.value ?? 0;
        const bVal = analysis?.periods?.b.value ?? 0;
        const pct = analysis?.pctChange ?? null;
        const note = analysis?.periods?.note;

        const provenance: Provenance[] = [
          {
            resultId: block.resultId,
            dataset: analysis?.dataset ?? defaultDataset,
            description: `Comparison analysis on ${analysis?.dataset ?? defaultDataset}`,
            widgetId: obs?.meta?.widgetId,
            pageId: obs?.meta?.pageId,
          },
        ];

        answerBlocks.push({
          type: "comparison",
          title: block.title,
          a: { label: analysis?.periods?.a ? `${analysis.periods.a.start} to ${analysis.periods.a.end}` : "Current", value: aVal },
          b: { label: analysis?.periods?.b ? `${analysis.periods.b.start} to ${analysis.periods.b.end}` : "Previous", value: bVal },
          pctChange: pct,
          note,
          provenance,
        });
        break;
      }

      case "chart": {
        const obs = obsByResultId.get(block.resultId) ?? observations.find((o) => o.data?.rows || o.data?.series || o.data?.breakdown);
        let chartData: Array<Record<string, unknown>> = [];
        let dataset = defaultDataset;

        if (obs?.data?.rows) {
          chartData = obs.data.rows;
          dataset = obs.data.dataset ?? defaultDataset;
        } else if (obs?.data?.series) {
          chartData = obs.data.series.map((s: any) => ({
            [block.xKey]: s.period,
            [block.yKeys[0] ?? "value"]: s.value,
            ...(s.key ?? {}),
          }));
          dataset = obs.data.dataset ?? defaultDataset;
        } else if (obs?.data?.breakdown) {
          chartData = obs.data.breakdown.map((b: any) => ({
            [block.xKey]: b.key ? Object.values(b.key)[0] : "Item",
            current: b.a,
            previous: b.b,
            absChange: b.abs,
          }));
          dataset = obs.data.dataset ?? defaultDataset;
        }

        const provenance: Provenance[] = [
          {
            resultId: block.resultId,
            dataset,
            description: `Chart visualization (${block.title})`,
            widgetId: obs?.meta?.widgetId,
            pageId: obs?.meta?.pageId,
          },
        ];

        answerBlocks.push({
          type: "chart",
          kind: block.kind,
          title: block.title,
          xKey: block.xKey,
          yKeys: block.yKeys,
          data: chartData,
          provenance,
        });
        break;
      }

      case "kpi": {
        const obs = obsByResultId.get(block.resultId);
        let val: string | number = 0;
        if (obs?.data) {
          // Resolve simple dot path
          const parts = block.valuePath.split(".");
          let current: any = obs.data;
          for (const p of parts) {
            if (current && typeof current === "object") current = current[p];
          }
          if (typeof current === "string" || typeof current === "number") {
            val = current;
          }
        }

        const provenance: Provenance[] = [
          {
            resultId: block.resultId,
            dataset: obs?.data?.dataset ?? defaultDataset,
            description: `KPI metric (${block.label})`,
            widgetId: obs?.meta?.widgetId,
            pageId: obs?.meta?.pageId,
          },
        ];

        answerBlocks.push({
          type: "kpi",
          label: block.label,
          value: val,
          provenance,
        });
        break;
      }
    }
  }

  // Fallback: if no answer blocks were created, produce a summary text block
  if (answerBlocks.length === 0) {
    answerBlocks.push({
      type: "text",
      markdown: "Task completed successfully.",
      provenance: [],
    });
  }

  return answerBlocks;
}
