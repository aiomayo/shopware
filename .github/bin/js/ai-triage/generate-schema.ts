/**
 * Generate `schemas/triage-output.schema.json` from the Zod schema in triage.ts.
 *
 * Zod v4 ships `z.toJSONSchema()` natively — no extra dependency.
 *
 * Usage:
 *   npm run schema:generate              # write the file
 *   npm run schema:check                 # exit 1 if file would change (CI guard)
 *
 * The schema is consumed by:
 *   - codex `--output-schema` (engine-enforced JSON shape)
 *   - claude-code `--json-schema` (engine-enforced JSON shape)
 *
 * Drift between Zod and JSON Schema = engine-side validation passes a shape the
 * wrapper rejects (or vice versa). Generating from Zod eliminates the divergence.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TriageOutput } from "./skill/output.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "schemas/triage-output.schema.json");

const generated = z.toJSONSchema(TriageOutput);
const generatedJson = JSON.stringify(generated, null, 2) + "\n";

const mode = process.argv[2] ?? "write";

if (mode === "check") {
  const existing = readFileSync(schemaPath, "utf8");
  if (existing !== generatedJson) {
    process.stderr.write(`error: ${schemaPath} is out of sync with Zod schema in triage.ts\n`);
    process.stderr.write(`run \`npm run schema:generate\` to regenerate.\n`);
    process.exit(1);
  }
  process.stdout.write(`schema is in sync with Zod\n`);
} else {
  writeFileSync(schemaPath, generatedJson);
  process.stdout.write(`wrote ${schemaPath} (${generatedJson.length} bytes)\n`);
}
