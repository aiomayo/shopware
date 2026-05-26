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

const MAX_EVIDENCE_QUOTE_LEN = 500;
const MAX_EVIDENCE_QUOTES = 5;
const MAX_RECENT_COMMIT_LEN = 200;
const MAX_REASONING_LEN = 2000;

// `.strict()` rejects unknown keys at parse time instead of silently stripping
// them. This matches what codex `--output-schema` and claude `--json-schema`
// already enforce engine-side — without `.strict()` the Zod-on-opencode path
// would accept (and discard) a prompt-injected `{...valid_fields, exfiltrated_env: ...}`
// payload silently. The asymmetry between three consumers of one schema was the
// gap; this closes it.
export const TriageOutput = z.object({
  disposition: z.enum(["valid-bug", "duplicate", "needs-info", "not-a-bug", "feature-request"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  suggested_labels: z.array(z.string()).min(1).max(2),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(MAX_REASONING_LEN),
  evidence_quotes: z.array(z.string().max(MAX_EVIDENCE_QUOTE_LEN)).min(1).max(MAX_EVIDENCE_QUOTES),
  duplicate_of: z.number().nullable(),
  missing_template_fields: z.array(z.string()),
  affected_paths: z.array(z.string()),
  related_issues: z.array(z.number()),
  related_prs: z.array(z.number()),
  recent_commits_in_area: z.array(z.string().max(MAX_RECENT_COMMIT_LEN)),
  change_size_estimate: z.enum(["quick-fix", "small", "medium", "large", "unknown"]),
}).strict();
export type TriageOutput = z.infer<typeof TriageOutput>;

/**
 * Defence-in-depth scan over the *content* of a parsed TriageOutput for
 * secret-shaped strings. Zod validates shape, not content — a prompt-injected
 * agent that places `sk-ant-…` inside a valid `reasoning` field passes Zod
 * cleanly. Combined with the input-side PII redactor + the post-run
 * `redact-stream.ts`, this is the third line of defence: if a secret reaches
 * the validated output, fail loudly with a redacted snippet so the run is
 * visibly broken instead of silently uploading the artifact.
 *
 * Patterns are deliberately narrower than the full PII redactor — we only
 * flag categories that are *exclusively* secrets (no email/phone/CC, which
 * are PII but not credentials). False-positive cost on legitimate triage
 * output is therefore near zero.
 *
 * Throws SecretInOutputError if any match. The error message is sanitised
 * (prefix + length only) — the secret itself is NOT included in the message
 * to avoid re-leaking via stderr.
 */
const OUTPUT_SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "anthropic_key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai_key", regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "github_token", regex: /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/ },
  { name: "aws_access_key", regex: /(?:AKIA|ASIA)[A-Z0-9]{16}/ },
  { name: "stripe_key", regex: /(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: "google_api_key", regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "slack_token", regex: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "shopware_integration_key", regex: /SWIA[A-Z0-9]{20,}/ },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "private_key_block", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/ },
];

export class SecretInOutputError extends Error {
  readonly patternName: string;
  constructor(patternName: string) {
    super(`output contains ${patternName}-shaped string — refusing to emit (prompt-injection suspected)`);
    this.name = "SecretInOutputError";
    this.patternName = patternName;
  }
}

export function assertNoSecretsInOutput(output: TriageOutput): void {
  const serialised = JSON.stringify(output);
  for (const { name, regex } of OUTPUT_SECRET_PATTERNS) {
    if (regex.test(serialised)) {
      throw new SecretInOutputError(name);
    }
  }
}

/**
 * Lenient normalisation before strict Zod validation.
 *
 * Two classes of agent-output drift this corrects:
 *
 *  1. **Oversized string fields** (reasoning / evidence_quotes / recent_commits)
 *     — engine-side schema enforcement (codex `--output-schema`, claude
 *     `--json-schema`) catches this at the model level for those engines,
 *     but opencode has no equivalent flag and occasionally overshoots.
 *     Truncated with a "…[truncated]" marker.
 *
 *  2. **Issue/PR refs as strings instead of numbers** (related_issues /
 *     related_prs / duplicate_of) — observed in real runs: the agent
 *     sometimes emits `"#14229"` or `"14229"` instead of `14229`. Strip a
 *     leading `#`, then coerce to a finite integer. Non-parseable values
 *     pass through unchanged → Zod will throw loudly downstream.
 *
 * Mutates the input in place. Caller passes the parsed-but-not-validated JSON.
 */
export function truncateOversizedFields(parsed: unknown): void {
  if (typeof parsed !== "object" || parsed === null) return;
  const obj = parsed as Record<string, unknown>;

  const SUFFIX = "…[truncated]"; // 12 chars in JS string-length
  const truncate = (s: string, max: number): string =>
    s.length <= max ? s : s.slice(0, max - SUFFIX.length) + SUFFIX;

  if (typeof obj.reasoning === "string") {
    obj.reasoning = truncate(obj.reasoning, MAX_REASONING_LEN);
  }
  if (Array.isArray(obj.evidence_quotes)) {
    // Cap array length AND per-quote length. Agents occasionally emit 6-10
    // quotes; keep the first MAX_EVIDENCE_QUOTES (agents typically order by
    // perceived relevance).
    obj.evidence_quotes = obj.evidence_quotes
      .slice(0, MAX_EVIDENCE_QUOTES)
      .map((q) => (typeof q === "string" ? truncate(q, MAX_EVIDENCE_QUOTE_LEN) : q));
  }
  if (Array.isArray(obj.recent_commits_in_area)) {
    obj.recent_commits_in_area = obj.recent_commits_in_area.map((c) =>
      typeof c === "string" ? truncate(c, MAX_RECENT_COMMIT_LEN) : c,
    );
  }

  // Coerce issue/PR refs from string to number. Accepts `"14229"` and `"#14229"`;
  // leaves non-parseable values untouched so Zod surfaces them.
  const toIssueNumber = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const trimmed = v.trim().replace(/^#/, "");
    if (!/^\d+$/.test(trimmed)) return v;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : v;
  };
  if (Array.isArray(obj.related_issues)) {
    obj.related_issues = obj.related_issues.map(toIssueNumber);
  }
  if (Array.isArray(obj.related_prs)) {
    obj.related_prs = obj.related_prs.map(toIssueNumber);
  }
  if (typeof obj.duplicate_of === "string") {
    obj.duplicate_of = toIssueNumber(obj.duplicate_of);
  }
}

/**
 * Extract a JSON object from an agent's text response.
 *
 * Each engine emits its final message via a structured channel (codex
 * `--output-last-message`, claude `--output-format json` result envelope,
 * opencode `--format json` assistant event), so the input here is the agent's
 * own answer — not a transcript with adversarial wrapping. Tool-output
 * injection in the issue body cannot reach this code path.
 *
 * Strategy: strip optional ```json``` fence, then walk forward from the first
 * `{` tracking string state + escapes, returning the substring at the depth-0
 * close brace. This handles:
 *   - braces inside JSON string values (string-aware)
 *   - prose AFTER the JSON object (`{...} note: ...`) — common with opencode,
 *     where the agent's final message is not envelope-wrapped
 *   - prose BEFORE the JSON object
 *   - nested objects of arbitrary depth
 *
 * Earlier "first { to last }" implementation broke on the prose-after-JSON case
 * because `lastIndexOf("}")` picked up a `}` in the trailing prose. Forward
 * scan avoids the lookahead problem the reverse-walker tried to fix and is
 * O(n) on input length.
 */
function extractFirstJsonObject(text: string): string | null {
  const first = text.indexOf("{");
  if (first === -1) return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = first; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(first, i + 1);
    }
  }
  return null; // unterminated
}

export function parseJsonFromText(text: string, label: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const jsonStr = extractFirstJsonObject(candidate);
  if (jsonStr === null) {
    throw new Error(`${label}: no JSON object found in text (len=${text.length}, head: ${text.slice(0, 200)})`);
  }
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`${label}: JSON.parse failed: ${(err as Error).message}\nextracted (${jsonStr.length}B): ${jsonStr.slice(0, 500)}`);
  }
}
