/**
 * AI Triage Agent — Shopware AI Tooling.
 *
 * Pipeline: load issue (file or live fetch) → PII-redact → spawn `codex exec`
 *   from sw1-root with full shell + gh tool access → parse final JSON message → print.
 *
 * Usage:
 *   # local replay from a fixture
 *   npx tsx triage.ts --issue issue-16599.json
 *
 *   # live fetch via gh CLI (CI-friendly)
 *   npx tsx triage.ts --issue-number 16599
 *
 *   # override repo for live fetch
 *   AI_TRIAGE_REPO=shopware/shopware npx tsx triage.ts --issue-number 16599
 *
 * Env:
 *   CODEX_MODEL              default: gpt-5.5 (current frontier agentic-coding model)
 *   CODEX_REASONING_EFFORT   default: medium (low|medium|high|xhigh — triage doesn't need xhigh)
 *   CODEX_TIMEOUT_MS         default: 600000 (10 min — agentic loops take longer)
 *   AI_TRIAGE_VERBOSE        set to 1 to print intermediate stages + stream codex stderr
 *   AI_TRIAGE_REPO_ROOT      default: ../../../.. (resolved from script dir to sw1 repo root)
 *   AI_TRIAGE_REPO           default: shopware/shopware (for --issue-number live fetch)
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.env.AI_TRIAGE_VERBOSE === "1";

// -- Types ---------------------------------------------------------------

const RawIssue = z.object({
  issue_id: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.string()),
  state: z.string().optional(),
});
type RawIssue = z.infer<typeof RawIssue>;

const TriageOutput = z.object({
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
type TriageOutput = z.infer<typeof TriageOutput>;

// -- PII Redactor (minimal, Sprint-0 only) -------------------------------

const PII_PATTERNS: Array<{ type: string; regex: RegExp; replacement: string }> = [
  { type: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[REDACTED_EMAIL]" },
  { type: "iban", regex: /\b[A-Z]{2}\d{2}[ ]?(?:\d{4}[ ]?){2,7}\d{1,4}\b/g, replacement: "[REDACTED_IBAN]" },
  { type: "stripe_key", regex: /\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_STRIPE_KEY]" },
  { type: "user_path", regex: /\/Users\/[A-Za-z0-9._-]+/g, replacement: "/Users/[REDACTED_USER]" },
  { type: "github_token", regex: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { type: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9-]{20,}\b/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  { type: "openai_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9-]{20,}\b/g, replacement: "[REDACTED_OPENAI_KEY]" },
];

function redactPii(text: string): { redacted: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let redacted = text;
  for (const { type, regex, replacement } of PII_PATTERNS) {
    const matches = redacted.match(regex);
    if (matches) {
      counts[type] = matches.length;
      redacted = redacted.replace(regex, replacement);
    }
  }
  return { redacted, counts };
}

// -- Template field extractor --------------------------------------------

function extractTemplateFields(body: string | null): {
  shopware_version: string | null;
  affected_area: string | null;
  actual_behaviour: string | null;
  expected_behaviour: string | null;
  reproduction_steps: string | null;
} {
  const empty = {
    shopware_version: null,
    affected_area: null,
    actual_behaviour: null,
    expected_behaviour: null,
    reproduction_steps: null,
  };
  if (!body) return empty;
  const section = (header: string): string | null => {
    const re = new RegExp(`### ${header}\\s*\\n+(.*?)(?=\\n+###|$)`, "is");
    const m = body.match(re);
    if (!m) return null;
    const value = m[1].trim();
    return value && value !== "." && value !== "_No response_" ? value : null;
  };
  return {
    shopware_version: section("Shopware Version"),
    affected_area: section("Affected area / extension"),
    actual_behaviour: section("Actual behaviour"),
    expected_behaviour: section("Expected behaviour"),
    reproduction_steps: section("How to reproduce"),
  };
}

// -- Codex CLI runner ----------------------------------------------------

interface CodexResult {
  output: TriageOutput;
  wallClockMs: number;
  rawStdout: string;
}

function extractFinalJson(stdout: string): string {
  /**
   * Codex emits its final JSON as the LAST message in the conversation.
   * The stdout transcript has the format:
   *
   *   ...session metadata...
   *   user
   *   <user prompt>
   *   codex
   *   <agent intermediate output>
   *   exec
   *   <tool call + output>
   *   ...
   *   codex
   *   <final JSON>
   *   tokens used
   *   <count>
   *
   * We find the LAST "codex\n" block before "tokens used" and extract the
   * largest JSON object from it.
   */
  // Try simple greedy: find the LAST top-level JSON object in the stdout.
  // We scan from the end for matched braces.
  const trimmed = stdout.trimEnd();
  // Drop trailing "tokens used\nN" lines.
  const tokensIdx = trimmed.lastIndexOf("tokens used");
  const searchText = tokensIdx >= 0 ? trimmed.slice(0, tokensIdx) : trimmed;

  // Find last "}" then walk back to matching "{".
  let end = searchText.lastIndexOf("}");
  if (end === -1) throw new Error("No closing brace in codex stdout");
  let depth = 0;
  let start = -1;
  for (let i = end; i >= 0; i--) {
    const ch = searchText[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) { start = i; break; }
    }
  }
  if (start === -1) throw new Error("Unbalanced braces in codex stdout");
  return searchText.slice(start, end + 1);
}

async function runCodex(promptPath: string, repoRoot: string, input: object): Promise<CodexResult> {
  const model = process.env.CODEX_MODEL ?? "gpt-5.5";
  const reasoningEffort = process.env.CODEX_REASONING_EFFORT ?? "medium";
  const timeoutMs = Number(process.env.CODEX_TIMEOUT_MS ?? 600_000);
  // workspace-write is needed for network_access (gh CLI for issue/PR lookups).
  // The triage prompt explicitly forbids writes — codex has no motivation to write,
  // and any accidental write would land in the local working copy (uncommitted, easy to discard).
  // gpt-5.5 defaults to xhigh reasoning; we cap it at medium for triage to keep latency + cost reasonable.
  const args = [
    "exec",
    "--model", model,
    "--sandbox", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", `model_reasoning_effort=${reasoningEffort}`,
    "--skip-git-repo-check",
  ];

  const promptBody = readFileSync(promptPath, "utf8");
  const stdin = `${promptBody}\n\n<input_json>\n${JSON.stringify(input, null, 2)}\n</input_json>\n`;

  if (VERBOSE) {
    process.stderr.write(`\n[codex] cwd=${repoRoot}\n`);
    process.stderr.write(`[codex] spawning: codex ${args.join(" ")}\n`);
    process.stderr.write(`[codex] stdin bytes: ${stdin.length}, timeout ${timeoutMs}ms\n\n`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  const child = spawn("codex", args, {
    stdio: ["pipe", "pipe", "pipe"],
    signal: controller.signal,
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
    },
  });

  child.stdin.write(stdin);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stdout += s;
    if (VERBOSE) process.stderr.write(s);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stderr += s;
    if (VERBOSE) process.stderr.write(s);
  });

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.on("exit", (code) => resolveExit(code ?? -1));
      child.on("error", (err) => rejectExit(err));
    });
  } finally {
    clearTimeout(timer);
  }

  const wallClockMs = Date.now() - start;
  if (controller.signal.aborted) {
    throw new Error(`codex timed out after ${timeoutMs}ms (wall=${wallClockMs}ms)`);
  }
  if (exitCode !== 0) {
    throw new Error(`codex exited with ${exitCode}: ${stderr || stdout}`);
  }

  const jsonStr = extractFinalJson(stdout);
  const parsed = TriageOutput.parse(JSON.parse(jsonStr));
  return { output: parsed, wallClockMs, rawStdout: stdout };
}

// -- Main ----------------------------------------------------------------

function detectLanguage(body: string | null): "en" | "de" | "fr" | "unknown" {
  if (!body) return "unknown";
  const lc = body.toLowerCase();
  if (/\b(ist|nicht|wird|sich|werden|sollte|haben|kann)\b/.test(lc)) return "de";
  if (/\b(est|pas|nous|vous|sont|être)\b/.test(lc)) return "fr";
  return "en";
}

function fetchIssueLive(issueNumber: number): RawIssue {
  const repo = process.env.AI_TRIAGE_REPO ?? "shopware/shopware";
  if (VERBOSE) process.stderr.write(`[fetch] gh api repos/${repo}/issues/${issueNumber}\n`);
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo}/issues/${issueNumber}`,
      "--jq",
      "{issue_id: .number, title: .title, body: .body, labels: [.labels[].name], state: .state}",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`gh api failed (exit=${result.status}): ${result.stderr}`);
  }
  return RawIssue.parse(JSON.parse(result.stdout));
}

async function main() {
  const args = process.argv.slice(2);
  const issuePathIdx = args.indexOf("--issue");
  const issueNumberIdx = args.indexOf("--issue-number");

  let raw: RawIssue;
  if (issuePathIdx !== -1 && args[issuePathIdx + 1]) {
    const issuePath = resolve(args[issuePathIdx + 1]);
    raw = RawIssue.parse(JSON.parse(readFileSync(issuePath, "utf8")));
  } else if (issueNumberIdx !== -1 && args[issueNumberIdx + 1]) {
    const issueNumber = Number(args[issueNumberIdx + 1]);
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      process.stderr.write(`error: --issue-number must be a positive integer, got "${args[issueNumberIdx + 1]}"\n`);
      process.exit(2);
    }
    raw = fetchIssueLive(issueNumber);
  } else {
    process.stderr.write("usage: npx tsx triage.ts --issue <path-to-issue.json>\n");
    process.stderr.write("   or: npx tsx triage.ts --issue-number <N>\n");
    process.exit(2);
  }

  const { redacted: redactedBody, counts: redactionCounts } = redactPii(raw.body ?? "");
  const { redacted: redactedTitle } = redactPii(raw.title);
  const templateFields = extractTemplateFields(redactedBody);
  const language = detectLanguage(redactedBody);

  const codexInput = {
    issue_id: raw.issue_id,
    title: redactedTitle,
    body: redactedBody,
    labels: raw.labels,
    language_detected: language,
    template_fields: templateFields,
  };

  if (VERBOSE) {
    process.stderr.write(`\n[redactor] counts: ${JSON.stringify(redactionCounts)}\n`);
    process.stderr.write(`[redactor] template_fields: ${JSON.stringify(templateFields, null, 2)}\n`);
  }

  const promptPath = resolve(__dirname, "prompts/implementer.md");
  const repoRoot = resolve(__dirname, process.env.AI_TRIAGE_REPO_ROOT ?? "../../../..");

  const result = await runCodex(promptPath, repoRoot, codexInput);

  const summary = `issue=#${raw.issue_id} disposition=${result.output.disposition} severity=${result.output.severity} labels=${result.output.suggested_labels.join(",")} confidence=${result.output.confidence.toFixed(2)} duplicate_of=${result.output.duplicate_of ?? "-"} size=${result.output.change_size_estimate} wall_s=${(result.wallClockMs / 1000).toFixed(1)}`;
  process.stderr.write(`\n${summary}\n`);

  console.log(JSON.stringify({
    issue_id: raw.issue_id,
    wall_clock_ms: result.wallClockMs,
    redaction_counts: redactionCounts,
    template_fields: templateFields,
    language_detected: language,
    triage: result.output,
  }, null, 2));
}

main().catch((err: unknown) => {
  process.stderr.write(`\n[triage error] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
