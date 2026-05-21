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
import { SkillInput, RawIssue, extractTemplateFields, detectLanguage, truncateRawIssueInput } from "./skill/input.ts";
import { formatPromptWithInput, stripFrontmatter } from "./skill/prompt.ts";
import { TriageOutput, parseJsonFromText, truncateOversizedFields, assertNoSecretsInOutput } from "./skill/output.ts";

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
//
// The engine layer is task-agnostic on purpose: `runOpencode`, `runCodex`,
// `runClaude` all return raw text. `runEngine` is generic over an output Zod
// schema — it parses + validates + scans for secret-content, then returns the
// validated value with usage telemetry. A second task (ai-pr-review, etc.)
// drops in by importing `runEngine` with its own schema; nothing in the engine
// runners depends on `TriageOutput`. When the second task lands, the engine
// runners + `spawnAndWait` + `buildChildEnv` move to `lib/` unchanged.

type Engine = "opencode" | "codex" | "claude";

interface EngineResult<TOutput> {
  output: TOutput;
  wallClockMs: number;
  engine: Engine;
  usage: UsageStats;
}

/**
 * Per-engine token + cost telemetry, harvested from each engine's structured
 * output channel. `null` fields are emitted when an engine doesn't report that
 * dimension (opencode emits tokens but not cost; codex reports both; claude
 * reports both via `--output-format json`). Surfacing usage in the result
 * makes per-run cost auditable in the workflow summary.
 */
interface UsageStats {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  total_cost_usd: number | null;
  /** Free-form provider-specific extras (e.g. cache_read_tokens) — never `undefined`. */
  raw: Record<string, unknown>;
}

const EMPTY_USAGE: UsageStats = {
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  total_cost_usd: null,
  raw: {},
};

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
export function buildChildEnv(engine: Engine, xdgDir: string): NodeJS.ProcessEnv {
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
 *   2. {type: "text", part: {text: "<message>"}}                  — opencode 1.15.5 verified
 *   3. {type: "message", role: "assistant", content: [{text:...}]} — content-array (legacy/future)
 *   4. {type: "complete", message: "<text>"}                       — terminal event (legacy/future)
 *
 * Verified shape (opencode 1.15.5, captured 2026-05-20):
 *   {"type":"text", "timestamp":..., "sessionID":"ses_...", "part":{"id":"prt_...",
 *    "messageID":"msg_...", "sessionID":"...", "type":"text", "text":"<JSON output>",
 *    "time":{...}}}
 *
 * Strategy: collect every matching event, return the LAST one. If opencode emits
 * a shape we don't recognise, we throw "no assistant message found" loudly
 * rather than silently misparse. When opencode publishes a typed SDK or schema,
 * replace this with a Zod-validated event union.
 */
// -- Usage extractors ----------------------------------------------------
//
// Each engine reports token + cost telemetry differently. These extractors
// tolerate schema additions (use defensive optional chaining) and return
// EMPTY_USAGE when nothing is found. They never throw — usage telemetry is
// "nice to have" alongside the triage result, not load-bearing.
//
// Surface: the parsed UsageStats lands in the wrapper's top-level JSON output
// and gets summarised in the workflow's GITHUB_STEP_SUMMARY so per-run cost
// is auditable without downloading the artifact.

/**
 * opencode `--format json` emits events; the terminal event carries usage
 * info per the upstream wire format (varies across minor versions, like the
 * final-message shape). Best-effort: scan every JSON line for token-shaped
 * fields and surface the last match.
 */
export function extractOpencodeUsage(stdout: string): UsageStats {
  let input: number | null = null;
  let output: number | null = null;
  let cost: number | null = null;
  const raw: Record<string, unknown> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let evt: unknown;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    if (typeof evt !== "object" || evt === null) continue;
    const rec = evt as Record<string, unknown>;
    // Many opencode events nest tokens under `tokens: {...}` or `usage: {...}`.
    const tokenBlock = (rec.tokens ?? rec.usage) as Record<string, unknown> | undefined;
    if (tokenBlock && typeof tokenBlock === "object") {
      const ip = pickNumber(tokenBlock, ["input", "prompt", "input_tokens", "prompt_tokens"]);
      const op = pickNumber(tokenBlock, ["output", "completion", "output_tokens", "completion_tokens"]);
      if (ip !== null) input = ip;
      if (op !== null) output = op;
      Object.assign(raw, tokenBlock);
    }
    const costNum = pickNumber(rec, ["cost", "total_cost_usd", "cost_usd"]);
    if (costNum !== null) cost = costNum;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input !== null && output !== null ? input + output : null,
    total_cost_usd: cost,
    raw,
  };
}

/**
 * codex emits usage to stderr as `token usage: ...` lines in its event log.
 * Tolerant best-effort regex against the visible format on 0.131.x.
 */
export function extractCodexUsage(stderrAndStdout: string): UsageStats {
  // Visible format: `tokens: input=12345 output=678 total=13023`
  let input: number | null = null;
  let output: number | null = null;
  let total: number | null = null;
  const re = /\btokens?:?\s*(?:input[=:\s]+(\d+))?[\s,]*(?:output[=:\s]+(\d+))?[\s,]*(?:total[=:\s]+(\d+))?/gi;
  for (const m of stderrAndStdout.matchAll(re)) {
    if (m[1]) input = Math.max(input ?? 0, Number(m[1]));
    if (m[2]) output = Math.max(output ?? 0, Number(m[2]));
    if (m[3]) total = Math.max(total ?? 0, Number(m[3]));
  }
  // codex doesn't surface cost in stderr; leave as null.
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total ?? (input !== null && output !== null ? input + output : null),
    total_cost_usd: null,
    raw: {},
  };
}

/**
 * claude `--output-format json` envelope shape (verified against
 * @anthropic-ai/claude-code@2.1.144):
 *   { result, total_cost_usd, usage: { input_tokens, output_tokens,
 *     cache_read_input_tokens?, cache_creation_input_tokens? }, ... }
 * Future fields fall into `raw` for the workflow summary.
 */
export function extractClaudeUsage(envelopeRaw: unknown): UsageStats {
  if (typeof envelopeRaw !== "object" || envelopeRaw === null) return EMPTY_USAGE;
  const rec = envelopeRaw as Record<string, unknown>;
  const usage = rec.usage;
  const cost = pickNumber(rec, ["total_cost_usd", "cost_usd"]);
  let input: number | null = null;
  let output: number | null = null;
  const raw: Record<string, unknown> = {};
  if (typeof usage === "object" && usage !== null) {
    const u = usage as Record<string, unknown>;
    input = pickNumber(u, ["input_tokens", "prompt_tokens"]);
    output = pickNumber(u, ["output_tokens", "completion_tokens"]);
    for (const k of Object.keys(u)) {
      if (k !== "input_tokens" && k !== "output_tokens" && k !== "prompt_tokens" && k !== "completion_tokens") {
        raw[k] = u[k];
      }
    }
  }
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input !== null && output !== null ? input + output : null,
    total_cost_usd: cost,
    raw,
  };
}

function pickNumber(obj: Record<string, unknown>, keys: ReadonlyArray<string>): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function extractOpencodeFinalMessage(stdout: string): string {
  const candidates: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let evt: unknown;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    if (typeof evt !== "object" || evt === null) continue;
    const rec = evt as Record<string, unknown>;

    // Shape 1 (opencode 1.15.5 — VERIFIED): {type:"text", part:{type:"text", text:"..."}}.
    if (rec["type"] === "text" && typeof rec["part"] === "object" && rec["part"] !== null) {
      const part = rec["part"] as Record<string, unknown>;
      if (typeof part["text"] === "string") {
        candidates.push(part["text"]);
        continue;
      }
    }
    // Legacy / future shapes — kept as defensive fallbacks. Drop these once we have
    // a stable opencode schema reference and pin against it.
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
async function runOpencode(prompt: string, repoRoot: string, xdgDir: string): Promise<{ finalText: string; usage: UsageStats }> {
  // opencode is multi-provider — model must be passed as `provider/name` (e.g. `openai/gpt-5.5`
  // or `anthropic/claude-sonnet-4-6`). opencode reads OPENAI_API_KEY and ANTHROPIC_API_KEY from
  // env and picks the right one based on the provider prefix. Default is Anthropic Sonnet because
  // the only secret we have right now is ANTHROPIC; flip to OpenAI by setting AI_TRIAGE_OPENCODE_MODEL.
  const model = env.AI_TRIAGE_OPENCODE_MODEL;
  const reasoning = env.AI_TRIAGE_REASONING;
  const timeoutMs = env.AI_TRIAGE_TIMEOUT_MS;

  // Argv vs stdin trade-off (opencode 1.15.5):
  //   opencode `run` accepts the message ONLY as a positional argv — it has no
  //   `--prompt-file`, `--stdin`, or `-` mode. The other two engines (codex,
  //   claude) take prompt via stdin so it never appears in `ps auxww` /
  //   /proc/<pid>/cmdline. opencode does not offer that path.
  //
  //   Residual risk: the assembled prompt (skill body + redacted issue) is
  //   visible to any process able to read /proc on the runner during
  //   opencode's lifetime. Defence-in-depth in place:
  //     1. Prompt content is PII-redacted upstream (triage.ts main()).
  //     2. Body is hard-capped at MAX_BODY_LEN (16 KiB) → assembled prompt
  //        stays well under Linux ARG_MAX (~128 KiB), eliminating the
  //        previously documented E2BIG crash mode.
  //     3. GitHub-hosted runners are ephemeral and single-tenant per job.
  //   Move to stdin when opencode ships a stdin/file-prompt mode.
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
  const finalText = extractOpencodeFinalMessage(stdout);
  const usage = extractOpencodeUsage(stdout);
  return { finalText, usage };
}

async function runCodex(prompt: string, repoRoot: string, schemaPath: string, xdgDir: string): Promise<{ finalText: string; usage: UsageStats }> {
  // codex is OpenAI-only.
  const model = env.AI_TRIAGE_CODEX_MODEL;
  const reasoning = env.AI_TRIAGE_REASONING;
  const timeoutMs = env.AI_TRIAGE_TIMEOUT_MS;

  // codex supports --output-last-message (writes final assistant message to a file)
  // AND --output-schema (engine enforces JSON schema). Belt + braces with Zod validation in main.
  const lastMsgFile = join(xdgDir, "codex-last-message.txt");

  const { stdout, stderr } = await spawnAndWait("codex", [
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
  const finalText = readFileSync(lastMsgFile, "utf8");
  const usage = extractCodexUsage(stdout + "\n" + stderr);
  return { finalText, usage };
}

// Claude --output-format json wraps the final assistant text in one of two
// envelope shapes depending on CLI version. The discriminated union surfaces
// drift loudly via Zod rather than the previous typeof+as cast ladder.
export const ClaudeEnvelope = z.union([
  z.object({ result: z.string() }),
  z.object({ result: z.object({ text: z.string() }) }),
]);

async function runClaude(prompt: string, repoRoot: string, schemaPath: string, xdgDir: string): Promise<{ finalText: string; usage: UsageStats }> {
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
    // Narrow allowlist — least-privilege defence-in-depth.
    //   - `gh` limited to read-only issue/PR/api surface; `gh secret list`, `gh auth status -t`,
    //     `gh issue create` are blocked even if the token's scope would permit them.
    //   - `git` limited to inspection subcommands; `git push`, `git config`, `git remote` blocked.
    //   - `head` / `tail` removed: a prompt-injected agent could otherwise read /proc/self/environ
    //     and emit secrets into the structured output (Zod fails-strict + post-output secret scan
    //     catches it as a second line of defence). The `Read` tool is path-confined to the repo.
    //   - `ls` is permitted to match SKILL.md `allowed-tools` (was previously a drift bug —
    //     the skill expected `ls`, the wrapper rejected it).
    "--allowedTools", [
      "Bash(rg:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git diff:*)",
      "Bash(git blame:*)",
      "Bash(gh issue view:*)",
      "Bash(gh issue list:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr list:*)",
      "Bash(gh api repos/*/issues/*:*)",
      "Bash(gh api repos/*/pulls/*:*)",
      "Bash(find:*)",
      "Bash(ls:*)",
      "Read",
      "Glob",
      "Grep",
    ].join(","),
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
  const finalText = typeof envelope.result === "string" ? envelope.result : envelope.result.text;
  // claude `--output-format json` envelope carries usage + total_cost_usd alongside
  // the result; harvest both for the per-run summary. Tolerant to schema additions.
  const usage = extractClaudeUsage(envelopeRaw);
  return { finalText, usage };
}

/**
 * Engine-layer orchestrator. Task-agnostic by design: the caller passes the
 * Zod schema for its output type, and `runEngine` does prompt assembly, engine
 * spawn, JSON extraction, lenient normalisation, strict validation, secret-
 * content scan, and usage harvest. A second task (ai-pr-review, etc.) calls
 * `runEngine` with its own `PrReviewOutput` schema; nothing in this function
 * is triage-specific.
 *
 * The `normalize` callback exists for the codex/claude path where engine-side
 * schema enforcement is loose enough that we still need a pre-Zod cleanup
 * (today's `truncateOversizedFields`). Pass an identity fn if none is needed.
 *
 * The `validate` callback is the secret-content scan — task-specific
 * (different tasks may have different output sensitivities). Pass a no-op fn
 * if not applicable.
 */
async function runEngine<TOutput>(args: {
  skillPath: string;
  schemaPath: string;
  repoRoot: string;
  input: unknown;
  outputSchema: z.ZodType<TOutput>;
  normalize?: (parsed: unknown) => void;
  validate?: (output: TOutput) => void;
}): Promise<EngineResult<TOutput>> {
  const engine = env.AI_TRIAGE_ENGINE;
  // Read the SKILL.md (Agent Skills format), strip its YAML frontmatter, then
  // wrap with the agent input as `<input_json>` tags per the skill's contract.
  const skillFile = readFileSync(args.skillPath, "utf8");
  const skillBody = stripFrontmatter(skillFile);
  // Cast: `input` is opaque to the engine layer; the wrapper-skill contract is
  // task-specific. Each task validates its own input shape before calling.
  const fullPrompt = formatPromptWithInput(skillBody, args.input as SkillInput);

  // Per-run isolated XDG dir; cleaned up in finally. Prevents opencode SQLite WAL
  // contention and any analogous engine-state corruption between parallel runs.
  const xdgDir = mkdtempSync(join(tmpdir(), `ai-triage-${engine}-`));

  const start = Date.now();
  try {
    let raw: { finalText: string; usage: UsageStats };
    switch (engine) {
      case "opencode": raw = await runOpencode(fullPrompt, args.repoRoot, xdgDir); break;
      case "codex": raw = await runCodex(fullPrompt, args.repoRoot, args.schemaPath, xdgDir); break;
      case "claude": raw = await runClaude(fullPrompt, args.repoRoot, args.schemaPath, xdgDir); break;
      default: {
        const _exhaustive: never = engine;
        throw new Error(`unreachable: unknown engine ${String(_exhaustive)}`);
      }
    }
    const parsedJson = parseJsonFromText(raw.finalText, engine);
    args.normalize?.(parsedJson);
    const output = args.outputSchema.parse(parsedJson);
    args.validate?.(output);
    return { output, wallClockMs: Date.now() - start, engine, usage: raw.usage };
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
    // Truncate oversized fields BEFORE Zod parses, so a 100 KB body becomes
    // a 16 KB body + `[truncated]` marker instead of failing the run.
    raw = RawIssue.parse(truncateRawIssueInput(JSON.parse(readFileSync(issuePath, "utf8"))));
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

  // Redact PII across title, body, AND labels. Labels are attacker-influenceable
  // (any maintainer applies them, but in a large OSS repo "any maintainer" is a
  // wide circle) — the previous code skipped them, leaving a direct prompt-injection
  // surface (label text is concatenated into the JSON the model sees).
  const titleResult = redactPii(raw.title);
  const bodyResult = redactPii(raw.body ?? "");
  const labelResults = raw.labels.map((l) => redactPii(l));
  // Merge counts across title + body + labels so the run summary reflects every
  // redaction site, not just the body's.
  const redactionCounts: Record<string, number> = {};
  for (const result of [titleResult, bodyResult, ...labelResults]) {
    for (const [k, n] of Object.entries(result.counts)) {
      redactionCounts[k] = (redactionCounts[k] ?? 0) + n;
    }
  }
  const redactedBody = bodyResult.redacted;
  const redactedTitle = titleResult.redacted;
  const redactedLabels = labelResults.map((r) => r.redacted);

  // Build + runtime-validate the skill input. Zod parse catches bugs like
  // "I accidentally passed raw.title instead of the redacted title" — the one
  // wrapper-skill boundary that was previously unvalidated.
  const skillInput = SkillInput.parse({
    issue_id: raw.issue_id,
    title: redactedTitle,
    body: redactedBody,
    labels: redactedLabels,
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
  const schemaPath = resolve(__dirname, "schemas/triage-output.schema.json");

  const result = await runEngine({
    skillPath,
    schemaPath,
    repoRoot,
    input: skillInput,
    outputSchema: TriageOutput,
    normalize: truncateOversizedFields,
    validate: assertNoSecretsInOutput,
  });

  const usageBits: string[] = [];
  if (result.usage.input_tokens !== null) usageBits.push(`in=${result.usage.input_tokens}`);
  if (result.usage.output_tokens !== null) usageBits.push(`out=${result.usage.output_tokens}`);
  if (result.usage.total_tokens !== null) usageBits.push(`total=${result.usage.total_tokens}`);
  if (result.usage.total_cost_usd !== null) usageBits.push(`cost=$${result.usage.total_cost_usd.toFixed(4)}`);
  const usageSummary = usageBits.length > 0 ? ` tokens[${usageBits.join(" ")}]` : "";
  const summary = `engine=${result.engine} issue=#${raw.issue_id} disposition=${result.output.disposition} severity=${result.output.severity} labels=${result.output.suggested_labels.join(",")} confidence=${result.output.confidence.toFixed(2)} duplicate_of=${result.output.duplicate_of ?? "-"} size=${result.output.change_size_estimate} wall_s=${(result.wallClockMs / 1000).toFixed(1)}${usageSummary}`;
  process.stderr.write(`\n${summary}\n`);

  console.log(JSON.stringify({
    issue_id: raw.issue_id,
    engine: result.engine,
    wall_clock_ms: result.wallClockMs,
    usage: result.usage,
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
