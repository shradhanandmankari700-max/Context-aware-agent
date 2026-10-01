// Usage: npm run check:metadata -- ../metadata/hospital.json
import { readFileSync } from "node:fs";
import { AppMetadata, validateAppMetadata } from "./index";

const files = process.argv.slice(2);
if (!files.length) { console.error("usage: check:metadata <file.json> [...]"); process.exit(2); }
let bad = 0;
for (const f of files) {
  const parsed = AppMetadata.safeParse(JSON.parse(readFileSync(f, "utf8")));
  if (!parsed.success) { bad++; console.error(`✗ ${f} (schema)`); parsed.error.issues.forEach((i) => console.error("  -", i.path.join("."), i.message)); continue; }
  const errs = validateAppMetadata(parsed.data);
  if (errs.length) { bad++; console.error(`✗ ${f}`); errs.forEach((e) => console.error("  -", e)); } else console.log(`✓ ${f}  (${parsed.data.pages.length} pages, ${parsed.data.datasets.length} datasets)`);
}
process.exit(bad ? 1 : 0);
