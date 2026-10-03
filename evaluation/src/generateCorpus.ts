import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { EvalCase } from "@cab/contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function generateCorpus() {
  const corpus: Array<z.infer<typeof EvalCase>> = [
    {
      id: "hospital-navigate-low-stock",
      appId: "hospital",
      kind: "navigate",
      utterance: "Show medicines that are running low.",
      history: [],
      gold: {
        pageId: "medicines",
        filters: {
          stockLevel: { op: "eq", value: "low" },
        },
      },
    },
    {
      id: "hospital-operate-days-remaining",
      appId: "hospital",
      kind: "operate",
      utterance: "On the medicines page, show items that may run out within two days.",
      history: ["Show medicines that are running low."],
      gold: {
        pageId: "medicines",
        filters: {
          daysRemaining: { op: "lte", value: 2 },
        },
      },
    },
    {
      id: "hospital-analyze-month-compare",
      appId: "hospital",
      kind: "analyze",
      utterance: "Compare this month's medicine usage with last month.",
      history: [],
      gold: {
        pageId: "reports",
        numbers: [
          { label: "month_to_date_usage_vs_last_month", value: 0, tolerance: 0.05 },
        ],
      },
    },
    {
      id: "hotel-navigate-rooms",
      appId: "hotel",
      kind: "navigate",
      utterance: "Open the available rooms under INR 3000 for tomorrow.",
      history: [],
      gold: {
        pageId: "rooms",
        filters: {
          availability: { op: "eq", value: "Available" },
          price: { op: "lt", value: 3000 },
          stayDate: { op: "eq", value: "2026-10-08" },
        },
      },
    },
    {
      id: "hotel-compare-revenue",
      appId: "hotel",
      kind: "analyze",
      utterance: "Why did hotel revenue drop this month compared with last month?",
      history: [],
      gold: {
        pageId: "revenue",
        numbers: [
          { label: "revenue_vs_last_month", value: 0, tolerance: 0.05 },
        ],
      },
    },
    {
      id: "adversarial-invalid-filter",
      appId: "hospital",
      kind: "adversarial",
      utterance: "Go to the medicines page and set an invented filter called zombieStatus=critical.",
      history: [],
      gold: {
        pageId: "medicines",
        expectRefusal: true,
      },
    },
  ];

  return corpus.map((entry) => EvalCase.parse(entry));
}

export function writeCorpus(cases = generateCorpus(), outputPath = resolve(__dirname, "../corpus/eval.jsonl")) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const lines = cases.map((entry) => JSON.stringify(entry));
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  return outputPath;
}

export function writeGoldSubset(cases = generateCorpus().slice(0, 3), outputPath = resolve(__dirname, "../corpus/gold.jsonl")) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const lines = cases.map((entry) => JSON.stringify(entry));
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  return outputPath;
}

const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const cases = generateCorpus();
  writeCorpus(cases);
  writeGoldSubset(cases.slice(0, 3));
  console.log(`[eval] generated ${cases.length} corpus cases`);
}
