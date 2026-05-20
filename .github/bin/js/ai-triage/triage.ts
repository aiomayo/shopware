/**
 * AI Triage Agent — Shopware AI Tooling.
 *
 * Pipeline: load issue (file or live fetch) → PII-redact → spawn agentic CLI
 *   (opencode / codex / claude) from sw1-root with full shell + gh tool access
 *   → extract the agent's final message via the engine's structured-output mode
 *   → JSON-parse → Zod-validate → print.
 *
 * Each engine runs in an isolated XDG_DATA_HOME directory so parallel runs cannot
 * race on opencode's SQLite WAL (or any other per-engine state cache). The temp
 * directory is removed on exit.
 *
 * Usage (Node 22 LTS+ runs TypeScript directly via `node script.ts`, no transpiler needed):
 *   # local replay from a fixture
 *   npm run triage -- --issue issue-16599.json
 *
 *   # live fetch via gh CLI (CI-friendly)
 *   npm run triage -- --issue-number 16599
 *
 *   # switch engine (CI default: opencode; devs can pick whatever they have)
 *   AI_TRIAGE_ENGINE=codex    npm run triage -- --issue-number 16599
 *   AI_TRIAGE_ENGINE=opencode npm run triage -- --issue-number 16599
 *   AI_TRIAGE_ENGINE=claude   npm run triage -- --issue-number 16599
 *
 *   # override repo for live fetch
 *   AI_TRIAGE_REPO=shopware/shopware npm run triage -- --issue-number 16599
 *
 * Env (engine-scoped models so cross-engine eval cannot mismatch):
 *   AI_TRIAGE_ENGINE          default: opencode (opencode|codex|claude)
 *   AI_TRIAGE_OPENCODE_MODEL  default: anthropic/claude-sonnet-4-6 (provider/name; opencode is multi-provider —
 *                                                     use openai/gpt-5.5 once an OpenAI key is available)
 *   AI_TRIAGE_CODEX_MODEL     default: gpt-5.5 (codex is OpenAI-only)
 *   AI_TRIAGE_ANTHROPIC_MODEL default: claude-sonnet-4-6 (used by claude engine)
 *   AI_TRIAGE_REASONING       default: medium (opencode + codex; ignored by claude)
 *   AI_TRIAGE_TIMEOUT_MS      default: 600000 (10 min — agentic loops take longer)
 *   AI_TRIAGE_GH_TIMEOUT_MS   default: 30000 (gh api fetch timeout)
 *   AI_TRIAGE_MAX_BUDGET_USD  default: 1.50 (claude-only, hard cap per run; no-op under OAuth subscription)
 *   AI_TRIAGE_VERBOSE         set to 1 to stream engine stdout/stderr (off by default)
 *   AI_TRIAGE_REPO_ROOT       default: ../../../.. (resolved from script dir to sw1 repo root)
 *   AI_TRIAGE_REPO            default: shopware/shopware (for --issue-number live fetch)
 *   AI_TRIAGE_PREFER_SUBSCRIPTION  set to 1 with engine=claude to force OAuth (Claude Code subscription)
 *                                  instead of API key — useful for local devs who have both
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { redactPii } from "./pii-patterns.ts";
import { SkillInput, RawIssue, extractTemplateFields, detectLanguage } from "./skill/input.ts";
import { formatPromptWithInput, stripFrontmatter } from "./skill/prompt.ts";
import { TriageOutput, parseJsonFromText } from "./skill/output.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- Env schema ----------------------------------------------------------
//
// Centralised env-var parsing with Zod. Catches typos (unknown vars are ignored;
// known vars with bad shapes throw at startup with a clear error) and silent
// `Number(undefined) === NaN` footguns. Defaults live here as the single source
// of truth.
//
// Parsed once at module load — this file is a CLI entry point, not a library.
// Importing it for tests that only exercise skill/* helpers is fine because
// every env var has a default, so parsing always succeeds with stock CI defaults.

const EnvSchema = z.object({
  AI_TRIAGE_ENGINE: z.enum(["opencode", "codex", "claude"]).default("opencode"),
  AI_TRIAGE_OPENCODE_MODEL: z.string().regex(/^[a-z0-9-]+\/[a-z0-9.-]+$/i, "must be provider/name (e.g. anthropic/claude-sonnet-4-6)").default("anthropic/claude-sonnet-4-6"),
  AI_TRIAGE_CODEX_MODEL: z.string().min(1).default("gpt-5.5"),
  AI_TRIAGE_ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-6"),
  AI_TRIAGE_REASONING: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  AI_TRIAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  AI_TRIAGE_GH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AI_TRIAGE_MAX_BUDGET_USD: z.coerce.number().positive().default(1.5),
  AI_TRIAGE_VERBOSE: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  AI_TRIAGE_REPO_ROOT: z.string().default("../../../.."),
  AI_TRIAGE_REPO: z.string().default("shopware/shopware"),
  AI_TRIAGE_PREFER_SUBSCRIPTION: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
});

const env = EnvSchema.parse(process.env);
const VERBOSE = env.AI_TRIAGE_VERBOSE;

// -- Engine layer --------------------------------------------------------

type Engine = "opencode" | "codex" | "claude";

interface EngineResult {
  output: TriageOutput;
  wallClockMs: number;
  engine: Engine;
}

export function parseEngine(raw: string | undefined): Engine {
  const v = (raw ?? "opencode").toLowerCase();
  if (v === "opencode" || v === "codex" || v === "claude") return v;
  throw new Error(`AI_TRIAGE_ENGINE must be opencode|codex|claude (got "${raw}")`);
}

/**
 * Run a child process with a hard timeout. Returns stdout/stderr and exit code,
 * or throws a descriptive error on timeout / spawn failure / EPIPE.
 *
 * Lifecycle fixes baked in:
 *  - `child.stdin.end(stdin)` combines write + close (handles backpressure correctly)
 *  - `child.stdin.on('error', ...)` swallows EPIPE if engine crashes before reading stdin
 *  - `child.on('close', ...)` ensures stdout/stderr have been fully flushed before we read
 *  - AbortError → translated to a clear "timed out" message (the previous code path was dead)
 */
async function spawnAndWait(
  command: string,
  args: ReadonlyArray<string>,
  opts: {
    stdin?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    label: string; // for error messages
  },
): Promise<{ stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const start = Date.now();

  if (VERBOSE) {
    process.stderr.write(`\n[${opts.label}] spawn ${command} (timeout=${opts.timeoutMs}ms, cwd=${opts.cwd})\n`);
  }

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: controller.signal,
      cwd: opts.cwd,
      env: opts.env,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`failed to spawn ${command}: ${(err as Error).message}`);
  }

  // Catch EPIPE from a child that died before reading stdin; the real cause surfaces via exit code.
  child.stdin?.on("error", () => { /* surfaced via close handler */ });

  if (opts.stdin !== undefined) {
    child.stdin?.end(opts.stdin);
  } else {
    child.stdin?.end();
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stdout += s;
    if (VERBOSE) process.stderr.write(s);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stderr += s;
    if (VERBOSE) process.stderr.write(s);
  });

  try {
    const code = await new Promise<number>((resolveExit, rejectExit) => {
      child.on("close", (c) => resolveExit(c ?? -1));
      child.on("error", (err) => rejectExit(err));
    });
    if (code !== 0) {
      throw new Error(`${opts.label} exited with ${code}: ${stderr.trim() || stdout.trim().slice(-500)}`);
    }
    return { stdout, stderr };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${opts.label} timed out after ${opts.timeoutMs}ms (wall=${Date.now() - start}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the env that every engine subprocess inherits. Includes credentials for the
 * selected engine, GH auth for the agent's `gh` tool, and locale so umlauts in German
 * issue bodies aren't mangled. Per-run isolated XDG dirs ensure opencode's SQLite WAL
 * cache (and any analogous engine state) doesn't race across parallel runs.
 */
function buildChildEnv(engine: Engine, xdgDir: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // USER + LOGNAME — Claude Code on macOS reads the username to look up its OAuth
    // credentials in the user's Keychain. Without USER, `claude login` state is invisible
    // and the agent reports "Not logged in · Please run /login" even when the host has
    // a valid Claude Code subscription. Empirically confirmed by env bisection.
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
    // Provider keys — only the one for the selected engine is meaningful; passing both is harmless.
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    // GitHub auth for the agent's `gh` tool. GH_REPO + AI_TRIAGE_REPO let the agent default to the right repo.
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_REPO: process.env.GH_REPO ?? env.AI_TRIAGE_REPO,
    AI_TRIAGE_REPO: env.AI_TRIAGE_REPO,
    // Codex-specific.
    CODEX_HOME: process.env.CODEX_HOME,
    // XDG defaults stay inherited from the user's host config:
    //   - XDG_CONFIG_HOME: where `gh` stores its OAuth (~/.config/gh)
    //   - XDG_DATA_HOME: where `claude` stores its CLI auth state (~/.local/share/claude)
    //   - XDG_CACHE_HOME: read-mostly, no contention
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  // opencode stores SQLite WAL state under XDG_DATA_HOME/opencode and account/OAuth
  // state under XDG_CONFIG_HOME/opencode. Parallel runs (or local triage co-running
  // with an interactive opencode session) would race on those DBs and could read
  // the dev's auth tokens. Give opencode its own per-run XDG roots.
  // codex and claude store auth in other locations (~/.codex, ~/.local/share/claude
  // = host XDG_DATA_HOME, macOS Keychain) and need the host values to find them.
  if (engine === "opencode") {
    childEnv.XDG_DATA_HOME = xdgDir;
    childEnv.XDG_CONFIG_HOME = xdgDir;
    childEnv.XDG_CACHE_HOME = xdgDir;
  }
  // AI_TRIAGE_PREFER_SUBSCRIPTION=1 with engine=claude forces Claude Code to use OAuth
  // credentials (claude login) instead of the API key, even if ANTHROPIC_API_KEY is in env.
  // Useful for local devs who have both a Claude.ai Pro/Max subscription and an API key.
  if (engine === "claude" && env.AI_TRIAGE_PREFER_SUBSCRIPTION) {
    delete childEnv.ANTHROPIC_API_KEY;
  }
  return childEnv;
}

/**
 * Parse opencode's `--format json` stream (JSONL events) and return the assistant's
 * final visible text.
 *
 * opencode (verified against 1.15.5) emits events of various types over its agentic
 * loop. The final assistant answer arrives in one of these shapes — we tolerate all
 * four because opencode's event schema is not formally documented and the JSON
 * field names have drifted across versions:
 *
 *   1. {role: "assistant", content: "<text>"}                      — flat string
 *   2. {type: "message", role: "assistant", content: [{text:...}]} — content-array
 *   3. {type: "complete", message: "<text>"}                       — terminal event
 *   4. {type: "text", text: "<text>"}                              — streaming text
 *
 * Strategy: collect every matching event, return the LAST one. This is fragile —
 * if opencode 1.16 emits a new shape we don't recognise, we'd throw "no assistant
 * message found" loudly rather than silently misparse. When opencode publishes a
 * typed SDK or schema, replace this with a Zod-validated event union.
 *
 * Bound the candidate list (~bytes parsed) implicitly via opencode's own output
 * volume — the function does not impose a hard cap, but each candidate is a single
 * JSONL line so memory pressure is bounded by opencode's own behaviour.
 */
export function extractOpencodeFinalMessage(stdout: string): string {
  const candidates: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let evt: unknown;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    if (typeof evt !== "object" || evt === null) continue;
    const rec = evt as Record<string, unknown>;
    // Common shapes across opencode versions.
    if (rec["role"] === "assistant" && typeof rec["content"] === "string") {
      candidates.push(rec["content"] as string);
    } else if (rec["type"] === "message" && rec["role"] === "assistant" && Array.isArray(rec["content"])) {
      const parts = (rec["content"] as Array<unknown>)
        .map((p) => (typeof p === "object" && p !== null && typeof (p as Record<string, unknown>)["text"] === "string"
          ? ((p as Record<string, unknown>)["text"] as string) : null))
        .filter((s): s is string => s !== null);
      if (parts.length > 0) candidates.push(parts.join(""));
    } else if (rec["type"] === "complete" && typeof rec["message"] === "string") {
      candidates.push(rec["message"] as string);
    } else if (rec["type"] === "text" && typeof rec["text"] === "string") {
      candidates.push(rec["text"] as string);
    }
  }
  if (candidates.length === 0) {
    throw new Error(`no assistant message found in opencode JSON stream (got ${stdout.length} bytes, ${stdout.split(/\r?\n/).length} lines)`);
  }
  return candidates[candidates.length - 1];
}

// parseJsonFromText now lives in ./skill/output.ts (imported at top of file).

/**
 * Engine runners return raw text (the agent's final-message string). Schema-parsing
 * is the task layer's concern (`main()` calls `parseJsonFromText` + `TriageOutput.parse`),
 * keeping the engine layer task-agnostic. When a second skill lands (ai-pr-review,
 * ai-adr-review), these runners can be extracted to `lib/` and reused without
 * the schema being baked into the engine signature.
 */
async function runOpencode(prompt: string, repoRoot: string, xdgDir: string): Promise<string> {
  // opencode is multi-provider — model must be passed as `provider/name` (e.g. `openai/gpt-5.5`
  // or `anthropic/claude-sonnet-4-6`). opencode reads OPENAI_API_KEY and ANTHROPIC_API_KEY from
  // env and picks the right one based on the provider prefix. Default is Anthropic Sonnet because
  // the only secret we have right now is ANTHROPIC; flip to OpenAI by setting AI_TRIAGE_OPENCODE_MODEL.
  const model = env.AI_TRIAGE_OPENCODE_MODEL;
  const reasoning = env.AI_TRIAGE_REASONING;
  const timeoutMs = env.AI_TRIAGE_TIMEOUT_MS;

  // opencode emits structured JSONL events with --format json, which we parse for the
  // assistant's final message text. Attacker-controlled tool output can no longer
  // forge the final-answer channel (P1 002 fix).
  const { stdout } = await spawnAndWait("opencode", [
    "run",
    "--model", model,
    "--variant", reasoning,
    "--format", "json",
    "--dangerously-skip-permissions",
    "--dir", repoRoot,
    prompt,
  ], {
    cwd: repoRoot,
    env: buildChildEnv("opencode", xdgDir),
    timeoutMs,
    label: "opencode",
  });
  return extractOpencodeFinalMessage(stdout);
}

async function runCodex(prompt: string, repoRoot: string, schemaPath: string, xdgDir: string): Promise<string> {
  // codex is OpenAI-only.
  const model = env.AI_TRIAGE_CODEX_MODEL;
  const reasoning = env.AI_TRIAGE_REASONING;
  const timeoutMs = env.AI_TRIAGE_TIMEOUT_MS;

  // codex supports --output-last-message (writes final assistant message to a file)
  // AND --output-schema (engine enforces JSON schema). Belt + braces with Zod validation in main.
  const lastMsgFile = join(xdgDir, "codex-last-message.txt");

  await spawnAndWait("codex", [
    "exec",
    "--model", model,
    "--sandbox", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", `model_reasoning_effort=${reasoning}`,
    "--skip-git-repo-check",
    "--output-schema", schemaPath,
    "--output-last-message", lastMsgFile,
  ], {
    stdin: prompt,
    cwd: repoRoot,
    env: buildChildEnv("codex", xdgDir),
    timeoutMs,
    label: "codex",
  });
  return readFileSync(lastMsgFile, "utf8");
}

// Claude --output-format json wraps the final assistant text in one of two
// envelope shapes depending on CLI version. The discriminated union surfaces
// drift loudly via Zod rather than the previous typeof+as cast ladder.
const ClaudeEnvelope = z.union([
  z.object({ result: z.string() }),
  z.object({ result: z.object({ text: z.string() }) }),
]);

async function runClaude(prompt: string, repoRoot: string, schemaPath: string, xdgDir: string): Promise<string> {
  const model = env.AI_TRIAGE_ANTHROPIC_MODEL;
  const timeoutMs = env.AI_TRIAGE_TIMEOUT_MS;
  const maxBudgetUsd = env.AI_TRIAGE_MAX_BUDGET_USD;
  const schema = readFileSync(schemaPath, "utf8").trim();

  // claude-code: --output-format json (single envelope) + --json-schema (engine enforces
  // the schema) + --max-budget-usd (hard cost cap; no-op under OAuth subscription).
  // --no-session-persistence keeps the run stateless. Prompt is fed via stdin to avoid
  // exposure in `ps auxww` / process accounting; "-" tells claude to read prompt from stdin.
  const { stdout } = await spawnAndWait("claude", [
    "-p", "-",
    "--model", model,
    "--output-format", "json",
    "--json-schema", schema,
    "--no-session-persistence",
    "--max-budget-usd", String(maxBudgetUsd),
    "--allowedTools", "Bash(rg:*),Bash(git:*),Bash(gh:*),Bash(find:*),Bash(head:*),Bash(tail:*),Read,Glob,Grep",
    "--add-dir", repoRoot,
  ], {
    stdin: prompt,
    cwd: repoRoot,
    env: buildChildEnv("claude", xdgDir),
    timeoutMs,
    label: "claude",
  });

  let envelopeRaw: unknown;
  try { envelopeRaw = JSON.parse(stdout.trim()); } catch (err) {
    throw new Error(`claude: failed to parse output envelope: ${(err as Error).message}\nstdout tail: ${stdout.slice(-500)}`);
  }
  const envelope = ClaudeEnvelope.parse(envelopeRaw);
  return typeof envelope.result === "string" ? envelope.result : envelope.result.text;
}

async function runEngine(skillPath: string, repoRoot: string, input: SkillInput): Promise<EngineResult> {
  const engine = env.AI_TRIAGE_ENGINE;
  const schemaPath = resolve(__dirname, "schemas/triage-output.schema.json");
  // Read the SKILL.md (Agent Skills format), strip its YAML frontmatter, then
  // wrap with the agent input as `<input_json>` tags per the skill's contract.
  const skillFile = readFileSync(skillPath, "utf8");
  const skillBody = stripFrontmatter(skillFile);
  const fullPrompt = formatPromptWithInput(skillBody, input);

  // Per-run isolated XDG dir; cleaned up in finally. Prevents opencode SQLite WAL
  // contention and any analogous engine-state corruption between parallel runs.
  const xdgDir = mkdtempSync(join(tmpdir(), `ai-triage-${engine}-`));

  const start = Date.now();
  try {
    let finalText: string;
    switch (engine) {
      case "opencode": finalText = await runOpencode(fullPrompt, repoRoot, xdgDir); break;
      case "codex": finalText = await runCodex(fullPrompt, repoRoot, schemaPath, xdgDir); break;
      case "claude": finalText = await runClaude(fullPrompt, repoRoot, schemaPath, xdgDir); break;
    }
    // Task-layer validation — the engine layer is task-agnostic; the schema lives here.
    // When a second skill (ai-pr-review etc.) lands, the engine runners extract to lib/
    // unchanged, and that task's main() validates against its own Zod schema instead.
    const parsedJson = parseJsonFromText(finalText, engine);
    const output = TriageOutput.parse(parsedJson);
    return { output, wallClockMs: Date.now() - start, engine };
  } finally {
    try { rmSync(xdgDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// -- Main ----------------------------------------------------------------

function fetchIssueLive(issueNumber: number): RawIssue {
  const repo = env.AI_TRIAGE_REPO;
  const ghTimeout = env.AI_TRIAGE_GH_TIMEOUT_MS;
  if (VERBOSE) process.stderr.write(`[fetch] gh api repos/${repo}/issues/${issueNumber} (timeout=${ghTimeout}ms)\n`);
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo}/issues/${issueNumber}`,
      "--jq",
      "{issue_id: .number, title: .title, body: .body, labels: [.labels[].name], state: .state}",
    ],
    { encoding: "utf8", timeout: ghTimeout },
  );
  if (result.status === null) {
    throw new Error(`gh api timed out after ${ghTimeout}ms (or was killed by signal: ${result.signal ?? "unknown"})`);
  }
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
    if (!Number.isFinite(issueNumber) || issueNumber <= 0 || !Number.isInteger(issueNumber)) {
      process.stderr.write(`error: --issue-number must be a positive integer, got "${args[issueNumberIdx + 1]}"\n`);
      process.exit(2);
    }
    raw = fetchIssueLive(issueNumber);
  } else {
    process.stderr.write("usage: npm run triage -- --issue <path-to-issue.json>\n");
    process.stderr.write("   or: npm run triage -- --issue-number <N>\n");
    process.exit(2);
  }

  const { redacted: redactedBody, counts: redactionCounts } = redactPii(raw.body ?? "");
  const { redacted: redactedTitle } = redactPii(raw.title);
  // Build + runtime-validate the skill input. Zod parse catches bugs like
  // "I accidentally passed raw.title instead of the redacted title" — the one
  // wrapper-skill boundary that was previously unvalidated.
  const skillInput = SkillInput.parse({
    issue_id: raw.issue_id,
    title: redactedTitle,
    body: redactedBody,
    labels: raw.labels,
    language_detected: detectLanguage(redactedBody),
    template_fields: extractTemplateFields(redactedBody),
  });

  if (VERBOSE) {
    process.stderr.write(`\n[redactor] counts: ${JSON.stringify(redactionCounts)}\n`);
    process.stderr.write(`[redactor] template_fields: ${JSON.stringify(skillInput.template_fields, null, 2)}\n`);
  }

  const repoRoot = resolve(__dirname, env.AI_TRIAGE_REPO_ROOT);
  // Agent Skills convention: skills live at `<project-root>/.claude/skills/<name>/SKILL.md`.
  // This is the same path Claude Code, opencode, Codex CLI auto-load — so the wrapper and
  // local interactive use share one source of truth.
  const skillPath = resolve(repoRoot, ".claude/skills/triage/SKILL.md");

  const result = await runEngine(skillPath, repoRoot, skillInput);

  const summary = `engine=${result.engine} issue=#${raw.issue_id} disposition=${result.output.disposition} severity=${result.output.severity} labels=${result.output.suggested_labels.join(",")} confidence=${result.output.confidence.toFixed(2)} duplicate_of=${result.output.duplicate_of ?? "-"} size=${result.output.change_size_estimate} wall_s=${(result.wallClockMs / 1000).toFixed(1)}`;
  process.stderr.write(`\n${summary}\n`);

  console.log(JSON.stringify({
    issue_id: raw.issue_id,
    engine: result.engine,
    wall_clock_ms: result.wallClockMs,
    redaction_counts: redactionCounts,
    template_fields: skillInput.template_fields,
    language_detected: skillInput.language_detected,
    triage: result.output,
  }, null, 2));
}

// Only run main() when invoked as the entry point — not when imported for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`\n[triage error] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
