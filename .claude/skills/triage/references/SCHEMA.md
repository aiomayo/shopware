# Output Schema — Field Rules

The strict JSON Schema is published at the URL in this skill's `output-schema-url` frontmatter metadata (currently `https://github.com/shopware/shopware/blob/trunk/.github/bin/js/ai-triage/schemas/triage-output.schema.json`). It is generated from the Zod source of truth in `skill/output.ts:TriageOutput`. This document describes the field semantics in prose.

## JSON shape

```json
{
  "disposition": "valid-bug | duplicate | needs-info | not-a-bug | feature-request",
  "severity": "low | medium | high | critical",
  "suggested_labels": ["domain/..."],
  "confidence": 0.0,
  "reasoning": "2-5 sentences referencing concrete paths, commit SHAs, related issue/PR numbers.",
  "evidence_quotes": ["verbatim spans from the input or your shell output"],
  "duplicate_of": null,
  "missing_template_fields": [],
  "affected_paths": ["src/Core/Content/ImportExport/Service/ImportExportService.php"],
  "related_issues": [12345, 12346],
  "related_prs": [12347],
  "recent_commits_in_area": ["abc1234 fix: ..."],
  "change_size_estimate": "quick-fix | small | medium | large | unknown"
}
```

## Field rules

| Field | Required | Constraints |
|---|---|---|
| `disposition` | yes | One enum value — see references/CLASSIFICATION.md |
| `severity` | yes | One enum value — see references/CLASSIFICATION.md |
| `suggested_labels` | yes | 1–2 entries from references/DOMAINS.md |
| `confidence` | yes | Number 0.0–1.0 (see calibration in CLASSIFICATION.md) |
| `reasoning` | yes | 2–5 sentences, max 2000 chars, must reference shell findings |
| `evidence_quotes` | yes | 1–5 verbatim spans, max 500 chars each (wrapper truncates overshoots) |
| `duplicate_of` | yes | Plain integer issue number (e.g. `15800` — NOT `"15800"`, NOT `"#15800"`) if `disposition == "duplicate"`, else `null` |
| `missing_template_fields` | yes | Informational — empty array if all template sections present |
| `affected_paths` | yes | File paths you identified via `rg`/`find` (empty array if none found) |
| `related_issues` | yes | Array of plain integers (e.g. `[12345, 12346]` — NOT `["#12345"]`, NOT `["12345"]`). Related but NOT `duplicate_of`. |
| `related_prs` | yes | Array of plain integers — merged PR numbers, same shape rule as `related_issues` |
| `recent_commits_in_area` | yes | Short `git log --oneline` entries, max 200 chars each |
| `change_size_estimate` | yes | One enum: `quick-fix` (<30 LOC single file), `small` (single component), `medium` (cross-component), `large` (architectural), `unknown` |

## Emission rules

**Emit the JSON object as your final message — no markdown code fence, no preamble, no trailing prose.** Many engines validate against the schema at the CLI level (`--output-schema` / `--json-schema`) and will refuse outputs that don't match.
