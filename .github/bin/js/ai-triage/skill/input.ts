/**
 * Skill-layer input contract for triage.
 *
 * Defines the shape the agent receives (the skill's `<input_format>` contract):
 *  - `RawIssue`: validated GitHub-issue input from `gh api`
 *  - `TemplateFields`: parsed Shopware-issue-template sections
 *  - `SkillInput`: the full input object the agent sees, wrapper-fed mode
 *  - `extractTemplateFields`: parse `### <Header>` sections from a body
 *
 * Side-effect-free imports. The Shopware-specific knowledge (template headers)
 * is policy and belongs to the skill — not the wrapper.
 *
 * Prompt-assembly mechanics (frontmatter strip, <input_json> wrap) live in
 * ./prompt.ts. They are wrapper-side adapters, not part of the skill's input
 * contract — native Agent Skills runtimes handle them differently.
 */

import { z } from "zod";

// -- Raw issue (wrapper-side input contract; what `gh api` returns) -------
//
// Hard caps below cap LLM-input cost and DoS exposure:
//   - `title` ≤ 500 chars (GitHub UI cap ~256; 500 = comfortable headroom)
//   - `body`  ≤ 16 KiB  (GitHub allows up to 65 KiB; bigger bodies are
//                         almost always log dumps that bloat token cost
//                         without adding signal — truncate before redaction)
//   - `labels` ≤ 50 entries × 100 chars each
//
// Truncation (rather than reject) is preferred: a 50 KB issue body with a
// useful first sentence is still triageable; failing the run forces a human
// to inspect for no defensive gain.

export const MAX_BODY_LEN = 16 * 1024; // 16 KiB
export const MAX_TITLE_LEN = 500;
export const MAX_LABEL_LEN = 100;
export const MAX_LABELS = 50;

export const RawIssue = z.object({
  issue_id: z.number().int().positive(),
  title: z.string().max(MAX_TITLE_LEN),
  body: z.string().max(MAX_BODY_LEN).nullable(),
  labels: z.array(z.string().max(MAX_LABEL_LEN)).max(MAX_LABELS),
});
export type RawIssue = z.infer<typeof RawIssue>;

/**
 * Truncate raw input fields to the schema caps before Zod parsing. Bodies that
 * exceed the cap are sliced and marked with `\n\n[truncated]` so the model sees
 * the deletion. Labels are dropped above MAX_LABELS, individual labels above
 * MAX_LABEL_LEN are sliced. Title is sliced.
 *
 * Returns a new object — does not mutate input. Caller uses RawIssue.parse() on
 * the result to apply the strict schema.
 */
export function truncateRawIssueInput(raw: {
  issue_id: unknown;
  title: unknown;
  body: unknown;
  labels: unknown;
}): unknown {
  const trim = (s: string, max: number): string =>
    s.length <= max ? s : s.slice(0, max - 16) + "\n\n[truncated]";
  return {
    issue_id: raw.issue_id,
    title: typeof raw.title === "string" ? raw.title.slice(0, MAX_TITLE_LEN) : raw.title,
    body: typeof raw.body === "string" ? trim(raw.body, MAX_BODY_LEN) : raw.body,
    labels: Array.isArray(raw.labels)
      ? raw.labels.slice(0, MAX_LABELS).map((l) => (typeof l === "string" ? l.slice(0, MAX_LABEL_LEN) : l))
      : raw.labels,
  };
}

// -- Template-field extraction (Shopware-issue-template specific) --------

export const TemplateFields = z.object({
  shopware_version: z.string().nullable(),
  affected_area: z.string().nullable(),
  actual_behaviour: z.string().nullable(),
  expected_behaviour: z.string().nullable(),
  reproduction_steps: z.string().nullable(),
});
export type TemplateFields = z.infer<typeof TemplateFields>;

const TEMPLATE_HEADERS = {
  shopware_version: "Shopware Version",
  affected_area: "Affected area / extension",
  actual_behaviour: "Actual behaviour",
  expected_behaviour: "Expected behaviour",
  reproduction_steps: "How to reproduce",
} as const;

const EMPTY_TEMPLATE_FIELDS: TemplateFields = {
  shopware_version: null,
  affected_area: null,
  actual_behaviour: null,
  expected_behaviour: null,
  reproduction_steps: null,
};

export function extractTemplateFields(body: string | null): TemplateFields {
  if (!body) return EMPTY_TEMPLATE_FIELDS;
  const section = (header: string): string | null => {
    const safe = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`### ${safe}\\s*\\n+(.*?)(?=\\n+###|$)`, "is");
    const m = body.match(re);
    if (!m) return null;
    const value = m[1].trim();
    return value && value !== "." && value !== "_No response_" ? value : null;
  };
  return {
    shopware_version: section(TEMPLATE_HEADERS.shopware_version),
    affected_area: section(TEMPLATE_HEADERS.affected_area),
    actual_behaviour: section(TEMPLATE_HEADERS.actual_behaviour),
    expected_behaviour: section(TEMPLATE_HEADERS.expected_behaviour),
    reproduction_steps: section(TEMPLATE_HEADERS.reproduction_steps),
  };
}

// -- Skill input (what the agent receives in <input_json>, wrapper-fed) --

export const SkillInput = z.object({
  issue_id: z.number().int().positive(),
  title: z.string().max(MAX_TITLE_LEN),
  body: z.string().max(MAX_BODY_LEN),
  labels: z.array(z.string().max(MAX_LABEL_LEN)).max(MAX_LABELS),
  template_fields: TemplateFields,
}).strict();
export type SkillInput = z.infer<typeof SkillInput>;
