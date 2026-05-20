/**
 * Skill-layer input contract for triage.
 *
 * Defines the shape the agent receives (the skill's `<input_format>` contract):
 *  - `RawIssue`: validated GitHub-issue input from `gh api`
 *  - `TemplateFields`: parsed Shopware-issue-template sections
 *  - `SkillInput`: the full input object the agent sees, wrapper-fed mode
 *  - `extractTemplateFields`: parse `### <Header>` sections from a body
 *  - `detectLanguage`: en/de/fr classifier (word-list heuristic)
 *
 * Side-effect-free imports. The Shopware-specific knowledge (template headers,
 * language word lists) is policy and belongs to the skill — not the wrapper.
 *
 * Prompt-assembly mechanics (frontmatter strip, <input_json> wrap) live in
 * ./prompt.ts. They are wrapper-side adapters, not part of the skill's input
 * contract — native Agent Skills runtimes handle them differently.
 */

import { z } from "zod";

// -- Raw issue (wrapper-side input contract; what `gh api` returns) -------

export const RawIssue = z.object({
  issue_id: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.string()),
  state: z.string().optional(),
});
export type RawIssue = z.infer<typeof RawIssue>;

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

// -- Language detection (universal utility) ------------------------------

export const DetectedLanguage = z.enum(["en", "de", "fr", "unknown"]);
export type DetectedLanguage = z.infer<typeof DetectedLanguage>;

export function detectLanguage(body: string | null): DetectedLanguage {
  if (!body) return "unknown";
  const lc = body.toLowerCase();
  if (/\b(ist|nicht|wird|sich|werden|sollte|haben|kann)\b/.test(lc)) return "de";
  if (/\b(est|pas|nous|vous|sont|être)\b/.test(lc)) return "fr";
  return "en";
}

// -- Skill input (what the agent receives in <input_json>, wrapper-fed) --

export const SkillInput = z.object({
  issue_id: z.number(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  language_detected: DetectedLanguage,
  template_fields: TemplateFields,
});
export type SkillInput = z.infer<typeof SkillInput>;
