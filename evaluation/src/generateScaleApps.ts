import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppMetadata, RetrievalCase, validateAppMetadata, type RetrievalCase as RetrievalCaseType } from "@cab/contracts";
import { buildMetadataDocuments } from "../../backend/src/metadata/documents";

const SCALES = [100, 300, 1000] as const;
const PAGE_SAMPLES = 100;
const DOMAINS = [
  "Healthcare", "Retail", "Hospitality", "Education", "Finance",
  "Logistics", "Energy", "Agriculture", "Manufacturing", "Insurance",
];
const CONCEPTS = [
  "Patient Care", "Stock Control", "Order Tracking", "Revenue Analysis", "Service Quality",
  "Supply Planning", "Usage Reporting", "Account Review", "Delivery Status", "Capacity Planning",
  "Payment History", "Risk Monitoring", "Asset Maintenance", "Customer Support", "Performance Review",
  "Compliance Checks", "Resource Allocation", "Demand Forecast", "Incident Response", "Workflow Summary",
];

function createScaleApp(pageCount: number) {
  const appId = `scale${pageCount}`;
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const domain = DOMAINS[index % DOMAINS.length]!;
    const concept = CONCEPTS[Math.floor(index / DOMAINS.length) % CONCEPTS.length]!;
    const groupIndex = Math.floor(index / DOMAINS.length) * DOMAINS.length;
    const parentIndex = groupIndex + 1;
    const id = `page_${String(pageNumber).padStart(4, "0")}`;
    const pageName = `${domain} ${concept} ${String(pageNumber).padStart(4, "0")}`;
    const parent = index === groupIndex ? null : `page_${String(parentIndex).padStart(4, "0")}`;
    const widgetId = `widget_${String(pageNumber).padStart(4, "0")}`;
    const filterId = `status_${String(pageNumber).padStart(4, "0")}`;

    return {
      id,
      name: pageName,
      route: `/operations/${id}`,
      parent,
      description: `${domain} ${concept.toLowerCase()} records, status, amount and recent updates. Search this ${domain.toLowerCase()} operations page by its distinctive name.`,
      widgets: [{
        id: widgetId,
        name: `${pageName} records`,
        type: "table" as const,
        description: `Records and status for ${pageName}.`,
        dataset: "records",
        columns: [{ field: "record_id" }, { field: "service" }, { field: "status" }, { field: "amount" }, { field: "updated_on" }],
        sortable: ["record_id", "amount", "updated_on"],
        defaultSort: { field: "record_id", direction: "asc" as const },
      }],
      filters: [{
        id: filterId,
        label: `${pageName} status`,
        description: `Filter ${pageName} records by status.`,
        type: "enum" as const,
        field: "status",
        options: [
          { value: "Open", label: "Open" },
          { value: "Closed", label: "Closed" },
          { value: "Pending", label: "Pending" },
        ],
      }],
    };
  });

  const metadata = AppMetadata.parse({
    schemaVersion: 1,
    appId,
    name: `Synthetic Scale ${pageCount}`,
    description: `Synthetic multi-domain operations app containing ${pageCount} nested pages for retrieval evaluation.`,
    referenceDate: "2026-10-07",
    roles: ["admin", "staff", "viewer"],
    datasets: [{
      name: "records",
      label: "Operations records",
      description: "Shared records across varied business domains and operational workflows.",
      table: "records",
      timeField: "updated_on",
      fields: [
        { name: "record_id", label: "Record ID", type: "string", roles: ["key", "label"], synonyms: ["record number", "reference"] },
        { name: "service", label: "Service", type: "string", roles: ["dimension"], synonyms: ["domain", "department"] },
        { name: "status", label: "Status", type: "string", roles: ["dimension"], enumValues: ["Open", "Closed", "Pending"] },
        { name: "amount", label: "Amount", type: "number", roles: ["metric"], synonyms: ["value", "cost", "total"] },
        { name: "updated_on", label: "Updated on", type: "date", roles: ["time"], synonyms: ["date", "last updated"] },
      ],
    }],
    pages,
    actions: [],
  });
  const errors = validateAppMetadata(metadata);
  if (errors.length) throw new Error(`Generated ${appId} metadata is invalid: ${errors.join("; ")}`);
  return metadata;
}

function buildCases(appId: string, pageCount: number): RetrievalCaseType[] {
  const sampleCount = Math.min(pageCount, PAGE_SAMPLES);
  const selectedIndexes = Array.from({ length: sampleCount }, (_, index) =>
    Math.floor(index * pageCount / sampleCount));
  const cases: RetrievalCaseType[] = [];

  for (const index of selectedIndexes) {
    const pageNumber = index + 1;
    const pageId = `page_${String(pageNumber).padStart(4, "0")}`;
    const pageName = `${DOMAINS[index % DOMAINS.length]} ${CONCEPTS[Math.floor(index / DOMAINS.length) % CONCEPTS.length]} ${String(pageNumber).padStart(4, "0")}`;
    const queries = [
      { query: `Find the ${pageName} page`, goldIds: [pageId] },
      { query: `Show records on ${pageName}`, goldIds: [pageId] },
    ];
    for (const [variant, item] of queries.entries()) {
      cases.push(RetrievalCase.parse({
        id: `scale-${pageCount}-${String(pageNumber).padStart(4, "0")}-${variant + 1}`,
        appId: `scale${pageCount}`,
        query: item.query,
        goldIds: item.goldIds,
      }));
    }
  }
  return cases;
}

async function main(): Promise<void> {
  const metadataDir = path.resolve(process.cwd(), "..", "metadata");
  const corpusDir = path.resolve(process.cwd(), "corpus");
  await mkdir(metadataDir, { recursive: true });
  await mkdir(corpusDir, { recursive: true });

  const corpus: RetrievalCaseType[] = [];
  for (const pageCount of SCALES) {
    const metadata = createScaleApp(pageCount);
    const documents = buildMetadataDocuments(metadata);
    const target = path.join(metadataDir, `${metadata.appId}.json`);
    await writeFile(target, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    corpus.push(...buildCases(metadata.appId, pageCount));
    console.log(`${metadata.appId}: ${metadata.pages.length} valid pages, ${documents.length} retrieval documents, corpus samples prepared`);
  }
  const corpusFile = path.join(corpusDir, "scale-retrieval.jsonl");
  await writeFile(corpusFile, `${corpus.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  console.log(`Wrote ${corpus.length} retrieval cases to ${corpusFile}`);
}

void main().catch((error: unknown) => {
  console.error("[scale app generator]", error);
  process.exitCode = 1;
});
