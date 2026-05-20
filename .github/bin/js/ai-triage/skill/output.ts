/**
 * Skill-layer output contract for triage.
 *
 * Exports:
 *  - TriageOutput: Zod schema (single source of truth; the JSON Schema in
 *    schemas/triage-output.schema.json is generated from this)
 *  - parseJsonFromText: extract a JSON object from an agent's text response
 *
 * Side-effect-free: no env-var reads at module load. A consumer (MCP server,
 * Lambda, alternative CLI) can import these without triggering the wrapper's
 * env validation. The wrapper composes them; this file is the skill-shaped
 * portable contract.
 */

import { z } from "zod";

export const TriageOutput = z.object({
  disposition: z.enum(["valid-bug", "duplicate", "needs-info", "not-a-bug", "feature-request"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  suggested_labels: z.array(z.string()).min(1).max(2),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(2000),
  evidence_quotes: z.array(z.string().max(300)).min(1).max(5),
  duplicate_of: z.number().nullable(),
  missing_template_fields: z.array(z.string()),
  affected_paths: z.array(z.string()),
  related_issues: z.array(z.number()),
  related_prs: z.array(z.number()),
  recent_commits_in_area: z.array(z.string().max(200)),
  change_size_estimate: z.enum(["quick-fix", "small", "medium", "large", "unknown"]),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

/**
 * Extract a JSON object from an agent's text response.
 *
 * Each engine emits its final message via a structured channel (codex
 * `--output-last-message`, claude `--output-format json` result envelope,
 * opencode `--format json` assistant event), so the input here is the agent's
 * own answer — not a transcript with adversarial wrapping. Tool-output
 * injection in the issue body cannot reach this code path.
 *
 * Strategy: strip optional ```json``` fence, then take the substring from the
 * first `{` to the last `}`. JSON.parse fails loudly on malformed input;
 * we wrap the error with a snippet for debugging.
 *
 * NOTE: a previous implementation tried a string-aware reverse brace walker.
 * Reverse scanning cannot correctly determine whether a `"` is escaped (you
 * need the preceding `\` count, which lies *before* the `"` in scan order),
 * so the walker silently mis-parsed JSON whose string values contained `}`.
 * Forward greedy match avoids the issue.
 */
export function parseJsonFromText(text: string, label: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new Error(`${label}: no JSON object found in text (len=${text.length}, head: ${text.slice(0, 200)})`);
  }
  const jsonStr = candidate.slice(first, last + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`${label}: JSON.parse failed: ${(err as Error).message}\nextracted (${jsonStr.length}B): ${jsonStr.slice(0, 500)}`);
  }
}
