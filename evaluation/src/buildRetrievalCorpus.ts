import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AppMetadata, RetrievalCase, type RetrievalCase as RetrievalCaseType } from "@cab/contracts";
import hospitalJson from "../../metadata/hospital.json";
import hotelJson from "../../metadata/hotel.json";
import { buildMetadataDocuments } from "../../backend/src/metadata/documents";

const manuallyReviewed: Record<string, RetrievalCaseType[]> = {
  hospital: [
    { id: "manual-hospital-001", appId: "hospital", query: "Where can I see medicines that are running low?", goldIds: ["stockLevel", "medicines", "medicineStock", "daysRemaining"] },
    { id: "manual-hospital-002", appId: "hospital", query: "Find medicines that may run out within two days", goldIds: ["daysRemaining", "medicines", "medicineStock", "stockLevel"] },
    { id: "manual-hospital-003", appId: "hospital", query: "Show the pharmacy inventory", goldIds: ["inventory", "medicines", "medicineStock", "purchases"] },
    { id: "manual-hospital-004", appId: "hospital", query: "Where are medicine purchase orders?", goldIds: ["purchases", "purchaseOrders", "orderStatus"] },
    { id: "manual-hospital-005", appId: "hospital", query: "Find medicines expiring soon", goldIds: ["expiryDate", "medicines", "medicineStock"] },
    { id: "manual-hospital-006", appId: "hospital", query: "Show patient admissions by ward", goldIds: ["patients", "patientList", "ward", "admittedOn"] },
    { id: "manual-hospital-007", appId: "hospital", query: "Find patients who are still admitted", goldIds: ["patients", "patientList", "patientStatus"] },
    { id: "manual-hospital-008", appId: "hospital", query: "Where can I see the weekly medicine usage chart?", goldIds: ["weeklyUsage", "dashboard", "medicine_usage"] },
    { id: "manual-hospital-009", appId: "hospital", query: "Show monthly medicine consumption", goldIds: ["monthlyUsage", "reports", "medicine_usage"] },
    { id: "manual-hospital-010", appId: "hospital", query: "Find prescriptions grouped by diagnosis", goldIds: ["prescriptionsByDiagnosis", "reports", "prescriptions"] },
    { id: "manual-hospital-011", appId: "hospital", query: "Filter inventory to antibiotics", goldIds: ["category", "medicines", "medicineStock"] },
    { id: "manual-hospital-012", appId: "hospital", query: "Show the stock shortage preset", goldIds: ["stockLevel", "medicines", "daysRemaining"] },
    { id: "manual-hospital-013", appId: "hospital", query: "Find medicine quantity left in inventory", goldIds: ["medicines.stock", "medicineStock", "medicines"] },
    { id: "manual-hospital-014", appId: "hospital", query: "Search by drug or medication name", goldIds: ["medicines.medicine", "medicineStock", "medicines"] },
    { id: "manual-hospital-015", appId: "hospital", query: "Where are delayed supplier orders?", goldIds: ["orderStatus", "purchaseOrders", "purchases"] },
    { id: "manual-hospital-016", appId: "hospital", query: "Show the patient register", goldIds: ["patients", "patientList"] },
    { id: "manual-hospital-017", appId: "hospital", query: "Filter patients by ICU ward", goldIds: ["ward", "patients", "patientList"] },
    { id: "manual-hospital-018", appId: "hospital", query: "Show the date range for medicine usage reports", goldIds: ["reportPeriod", "reports", "monthlyUsage"] },
    { id: "manual-hospital-019", appId: "hospital", query: "Find stock snapshots over time", goldIds: ["stock_history", "reports"] },
    { id: "manual-hospital-020", appId: "hospital", query: "How much medicine is dispensed each day?", goldIds: ["medicine_usage.quantity", "medicine_usage", "weeklyUsage", "monthlyUsage"] },
    { id: "manual-hospital-021", appId: "hospital", query: "Show prescription quantity and diagnosis", goldIds: ["prescriptions.quantity", "prescriptions.diagnosis", "prescriptionsByDiagnosis"] },
    { id: "manual-hospital-022", appId: "hospital", query: "Filter purchase orders by delivery status", goldIds: ["orderStatus", "purchases", "purchaseOrders"] },
    { id: "manual-hospital-023", appId: "hospital", query: "When was this medicine ordered?", goldIds: ["purchases.order_date", "orderDate", "purchaseOrders"] },
    { id: "manual-hospital-024", appId: "hospital", query: "How many days of supply remain?", goldIds: ["medicines.days_remaining", "daysRemaining", "stockLevel"] },
    { id: "manual-hospital-025", appId: "hospital", query: "Open the hospital dashboard", goldIds: ["dashboard", "kpiMedicines", "kpiLowStock"] },
    { id: "manual-hospital-026", appId: "hospital", query: "Find the number of medicines being tracked", goldIds: ["kpiMedicines", "dashboard", "medicines"] },
    { id: "manual-hospital-027", appId: "hospital", query: "Show medicines with less than five days remaining", goldIds: ["kpiLowStock", "daysRemaining", "stockLevel", "medicines"] },
    { id: "manual-hospital-028", appId: "hospital", query: "Filter the admission list by admission date", goldIds: ["admittedOn", "patients", "patientList"] },
    { id: "manual-hospital-029", appId: "hospital", query: "Where can I discard expired medicine stock?", goldIds: ["discardExpiredStock", "medicines", "expiryDate"] },
    { id: "manual-hospital-030", appId: "hospital", query: "Show the date of each patient's admission", goldIds: ["patients.admitted_on", "admittedOn", "patientList"] },
  ],
  hotel: [
    { id: "manual-hotel-001", appId: "hotel", query: "Find rooms cheaper than 3000 tomorrow", goldIds: ["rooms", "price", "stayDate", "roomList"] },
    { id: "manual-hotel-002", appId: "hotel", query: "Show available rooms for tonight", goldIds: ["rooms", "availability", "stayDate", "roomList"] },
    { id: "manual-hotel-003", appId: "hotel", query: "Where can I filter rooms by type?", goldIds: ["rooms", "roomType", "roomList"] },
    { id: "manual-hotel-004", appId: "hotel", query: "Find the room price or nightly rate", goldIds: ["room_availability.price", "price", "rooms"] },
    { id: "manual-hotel-005", appId: "hotel", query: "Show occupied rooms for a selected date", goldIds: ["availability", "stayDate", "rooms", "roomList"] },
    { id: "manual-hotel-006", appId: "hotel", query: "Where can I see guest bookings?", goldIds: ["bookings", "bookingList", "bookingStatus"] },
    { id: "manual-hotel-007", appId: "hotel", query: "Find cancelled reservations", goldIds: ["bookingStatus", "bookings", "bookingList"] },
    { id: "manual-hotel-008", appId: "hotel", query: "Filter bookings by corporate channel", goldIds: ["channel", "bookings", "bookingList"] },
    { id: "manual-hotel-009", appId: "hotel", query: "Show check-in dates for reservations", goldIds: ["checkIn", "bookings", "bookingList"] },
    { id: "manual-hotel-010", appId: "hotel", query: "Where is the hotel revenue dashboard?", goldIds: ["dashboard", "kpiRevenue", "revenueTrend"] },
    { id: "manual-hotel-011", appId: "hotel", query: "Show the revenue trend over time", goldIds: ["revenueTrend", "dashboard", "revenue"] },
    { id: "manual-hotel-012", appId: "hotel", query: "Find daily revenue by category", goldIds: ["revenueByCategory", "revenue", "revenueCategory"] },
    { id: "manual-hotel-013", appId: "hotel", query: "Filter revenue to restaurant sales", goldIds: ["revenueCategory", "revenue", "revenueByCategory"] },
    { id: "manual-hotel-014", appId: "hotel", query: "Show monthly room booking income", goldIds: ["revenueTrend", "revenueByCategory", "revenue"] },
    { id: "manual-hotel-015", appId: "hotel", query: "Where can I see occupancy history?", goldIds: ["occupancy_history", "dashboard", "revenueTrend"] },
    { id: "manual-hotel-016", appId: "hotel", query: "Find the number of occupied rooms per day", goldIds: ["occupancy_history.occupied_rooms", "occupancy_history", "dashboard"] },
    { id: "manual-hotel-017", appId: "hotel", query: "Show the total rooms available in the hotel", goldIds: ["occupancy_history.total_rooms", "occupancy_history"] },
    { id: "manual-hotel-018", appId: "hotel", query: "Filter revenue by date range", goldIds: ["revenuePeriod", "revenue", "revenueByCategory"] },
    { id: "manual-hotel-019", appId: "hotel", query: "Show room availability status", goldIds: ["availability", "room_availability.status", "rooms"] },
    { id: "manual-hotel-020", appId: "hotel", query: "Find standard, deluxe, or suite rooms", goldIds: ["roomType", "rooms", "room_availability.room_type"] },
    { id: "manual-hotel-021", appId: "hotel", query: "Show the booking amount and guest name", goldIds: ["bookings.amount", "bookings.guest", "bookingList"] },
    { id: "manual-hotel-022", appId: "hotel", query: "Where can I cancel a booking?", goldIds: ["cancelBooking", "bookings", "bookingList"] },
    { id: "manual-hotel-023", appId: "hotel", query: "Find rooms with a rate below 2500", goldIds: ["rooms", "price", "roomList"] },
    { id: "manual-hotel-024", appId: "hotel", query: "Show hotel revenue from spa services", goldIds: ["revenueCategory", "revenue", "revenueByCategory"] },
    { id: "manual-hotel-025", appId: "hotel", query: "Find a reservation's check-out date", goldIds: ["bookings.check_out", "bookingList", "bookings"] },
    { id: "manual-hotel-026", appId: "hotel", query: "Where can I view room nights and nightly prices?", goldIds: ["room_availability", "rooms", "roomList"] },
    { id: "manual-hotel-027", appId: "hotel", query: "Show confirmed reservations", goldIds: ["bookingStatus", "bookings", "bookingList"] },
    { id: "manual-hotel-028", appId: "hotel", query: "Find direct bookings", goldIds: ["channel", "bookings", "bookingList"] },
    { id: "manual-hotel-029", appId: "hotel", query: "Show the total revenue KPI", goldIds: ["kpiRevenue", "dashboard", "revenue"] },
    { id: "manual-hotel-030", appId: "hotel", query: "Find today's room availability", goldIds: ["rooms", "stayDate", "availability", "roomList"] },
  ],
};

const queryForms = [
  (name: string) => `Find ${name}`,
  (name: string) => `Show me ${name}`,
  (name: string) => `Where can I see ${name}?`,
  (name: string) => `Open the ${name}`,
  (name: string) => `Search for ${name}`,
  (name: string) => `I need information about ${name}`,
];

function generatedQueries(
  appId: string,
  appName: string,
  metadata: ReturnType<typeof AppMetadata.parse>,
): RetrievalCaseType[] {
  const pagesById = new Map(metadata.pages.map((page) => [page.id, page]));
  const datasetByName = new Map(metadata.datasets.map((dataset) => [dataset.name, dataset]));
  const targets = buildMetadataDocuments(metadata).map((document) => {
    const page = document.pageId ? pagesById.get(document.pageId) : undefined;
    const dataset = document.kind === "dataset"
      ? datasetByName.get(document.id)
      : document.kind === "field"
        ? datasetByName.get(document.id.split(".")[0]!)
        : undefined;
    const subject = document.kind === "field"
      ? `${dataset?.label ?? ""} ${document.name}`.trim()
      : document.kind === "dataset"
        ? document.name
        : document.name;
    const contextual = page ? `${subject} on the ${page.name} page` : `${subject} in ${appName}`;
    const queries = queryForms.map((form) => form(contextual));
    if (document.kind === "filter" && page) {
      queries.push(`Filter the ${page.name} page by ${document.name}`);
    }
    if (document.kind === "widget" && page) {
      queries.push(`Show ${document.name} on ${page.name}`);
    }
    if (document.kind === "action") {
      queries.push(`How do I ${document.description.replace(/[.?!]+$/, "").toLowerCase()}?`);
    }
    return { id: document.id, queries };
  });

  const selected: RetrievalCaseType[] = [];
  const seen = new Set<string>();
  let round = 0;
  while (selected.length < 170) {
    let added = false;
    for (const target of targets) {
      const query = target.queries[round % target.queries.length]!;
      const key = query.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push({
        id: `generated-${appId}-${String(selected.length + 1).padStart(3, "0")}`,
        appId,
        query,
        goldIds: [target.id],
      });
      added = true;
      if (selected.length === 170) break;
    }
    if (!added && round > 20) {
      throw new Error(`Not enough distinct metadata-derived queries to complete the ${appId} corpus`);
    }
    round++;
  }
  return selected;
}

async function main(): Promise<void> {
  const apps = [
    AppMetadata.parse(hospitalJson),
    AppMetadata.parse(hotelJson),
  ];
  const cases = apps.flatMap((metadata) => {
    const validIds = new Set(buildMetadataDocuments(metadata).map((document) => document.id));
    const manualCases = manuallyReviewed[metadata.appId]!;
    for (const item of manualCases) {
      const unknownIds = item.goldIds.filter((id) => !validIds.has(id));
      if (unknownIds.length) {
        throw new Error(`${item.id} references unknown ${metadata.appId} gold ids: ${unknownIds.join(", ")}`);
      }
    }
    return [...manualCases, ...generatedQueries(metadata.appId, metadata.name, metadata)];
  });
  const validated = cases.map((item) => RetrievalCase.parse(item));
  const output = `${validated.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const target = path.resolve(process.cwd(), "corpus", "retrieval.jsonl");
  await writeFile(target, output, "utf8");
  for (const app of apps) {
    console.log(`${app.appId}: ${validated.filter((item) => item.appId === app.appId).length} cases (${manuallyReviewed[app.appId]!.length} manually reviewed)`);
  }
  console.log(`Wrote ${target}`);
}

void main().catch((error: unknown) => {
  console.error("[retrieval corpus]", error);
  process.exitCode = 1;
});
