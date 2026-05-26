/**
 * Replay-benchmark — execute triage.ts per (engine × issue) cell.
 *
 * Re-uses the full PII + Zod + secret-scan pipeline by spawning triage.ts as
 * a child process with `AI_TRIAGE_ENGINE` set. Each cell's output is appended
 * as one JSONL line to results/results-<engine>.jsonl. Already-completed
 * issue_ids are skipped on resume; engine errors land as discriminated-union
 * lines so scoring can read them without crashing.
 *
 * Usage:
 *   tsx replay/run.ts                                  # all engines, all issues
 *   tsx replay/run.ts --engines opencode               # one engine
 *   tsx replay/run.ts --engines opencode,claude        # subset
 *   tsx replay/run.ts --issues custom.json             # alt input
 *   tsx replay/run.ts --resume false                   # re-run all cells
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ENGINES,
    CellOutput,
    loadCellsJsonl,
    loadManifest,
    type Engine,
    type ReplayIssue,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_TIMEOUT_MS = 600_000;
const ENGINE_INNER_TIMEOUT_BUFFER_MS = 30_000;
const STDERR_TAIL_BYTES = 1000;
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

interface Args {
    engines: Engine[];
    issuesPath: string;
    fixturesDir: string;
    resultsDir: string;
    resume: boolean;
    timeoutMs: number;
    concurrency: number;
    anthropicModel: string;
}

function parseEngines(raw: string): Engine[] {
    const requested = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    const unknown = requested.filter(
        (s) => !(ENGINES as readonly string[]).includes(s),
    );

    if (unknown.length > 0) {
        throw new Error(
            `unknown engine(s): ${unknown.join(", ")}. Valid: ${ENGINES.join(", ")}`,
        );
    }

    return requested as Engine[];
}

function parseArgs(argv: readonly string[]): Args {
    const get = (flag: string): string | null => {
        const i = argv.indexOf(flag);

        return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
    };

    const enginesArg = get("--engines");
    const engines: Engine[] = enginesArg
        ? parseEngines(enginesArg)
        : [...ENGINES];

    return {
        engines,
        issuesPath: get("--issues") ?? resolve(__dirname, "issues.json"),
        fixturesDir: get("--fixtures-dir") ?? resolve(__dirname, "fixtures"),
        resultsDir: get("--results-dir") ?? resolve(__dirname, "results"),
        resume: get("--resume") !== "false",
        timeoutMs: Number(get("--timeout-ms") ?? String(DEFAULT_TIMEOUT_MS)),
        concurrency: Number(get("--concurrency") ?? "1"),
        anthropicModel:
            get("--model") ??
            process.env.AI_TRIAGE_ANTHROPIC_MODEL ??
            DEFAULT_ANTHROPIC_MODEL,
    };
}

/**
 * Bounded-concurrency map. Keeps `concurrency` workers busy pulling from a
 * shared index until all items are dispatched. Local index mutation is
 * contained — input/output are pure.
 *
 * Used instead of Promise.all-on-chunks to avoid tail-latency: if one cell
 * runs 5x longer than the others in its batch, chunked-await blocks; pool
 * keeps the other slots productive.
 */
async function poolMap<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
        while (true) {
            const idx = nextIndex;
            nextIndex += 1;

            if (idx >= items.length) {
                return;
            }

            results[idx] = await fn(items[idx], idx);
        }
    };

    const workerCount = Math.min(Math.max(concurrency, 1), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}

interface CollectedOutput {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

function spawnAndCollect(
    command: string,
    args: readonly string[],
    opts: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        timeoutMs: number;
        teeStderr: boolean;
    },
): Promise<CollectedOutput> {
    return new Promise((settle) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

        const child = spawn(command, [...args], {
            cwd: opts.cwd,
            env: opts.env,
            stdio: ["ignore", "pipe", "pipe"],
            signal: controller.signal,
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();

            if (opts.teeStderr) {
                process.stderr.write(chunk);
            }
        });

        const finish = (exitCode: number | null): void => {
            clearTimeout(timer);
            settle({
                exitCode,
                stdout,
                stderr,
                timedOut: controller.signal.aborted,
            });
        };

        child.on("close", finish);
        child.on("error", () => finish(null));
    });
}

const TRIAGE_PATH = resolve(__dirname, "..", "triage.ts");
const TRIAGE_CWD = resolve(__dirname, "..");

function tail(s: string, bytes: number): string {
    return s.trim().slice(-bytes);
}

interface SpawnTriageOpts {
    engine: Engine;
    fixturePath: string;
    issueId: number;
    timeoutMs: number;
    anthropicModel: string;
}

async function spawnTriage(opts: SpawnTriageOpts): Promise<CellOutput> {
    const { engine, fixturePath, issueId, timeoutMs, anthropicModel } = opts;

    const start = Date.now();
    const verbose = process.env.AI_TRIAGE_VERBOSE === "1";

    const result = await spawnAndCollect(
        "node",
        [TRIAGE_PATH, "--issue", fixturePath],
        {
            cwd: TRIAGE_CWD,
            env: {
                ...process.env,
                AI_TRIAGE_ENGINE: engine,
                AI_TRIAGE_TIMEOUT_MS: String(
                    timeoutMs - ENGINE_INNER_TIMEOUT_BUFFER_MS,
                ),
                // The replay sweep serialises cells within an engine, so the parallel-run
                // WAL race that motivates triage.ts's XDG isolation cannot happen here.
                // Let opencode read the host's OAuth tokens from ~/.config/opencode/.
                AI_TRIAGE_OPENCODE_USE_HOST_XDG: "1",
                AI_TRIAGE_ANTHROPIC_MODEL: anthropicModel,
            },
            timeoutMs,
            teeStderr: verbose,
        },
    );
    const wall = Date.now() - start;

    if (result.timedOut) {
        return {
            status: "timeout",
            engine,
            issue_id: issueId,
            wall_clock_ms: wall,
            message: `cell timed out after ${timeoutMs}ms`,
        };
    }

    if (result.exitCode !== 0) {
        return {
            status: "engine-error",
            engine,
            issue_id: issueId,
            wall_clock_ms: wall,
            message:
                tail(result.stderr, STDERR_TAIL_BYTES) ||
                tail(result.stdout, STDERR_TAIL_BYTES),
        };
    }

    try {
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

        return CellOutput.parse({ status: "ok", ...parsed });
    } catch (err) {
        return {
            status: "parse-error",
            engine,
            issue_id: issueId,
            wall_clock_ms: wall,
            message: `JSON.parse / schema failed: ${(err as Error).message}`,
        };
    }
}

function loadCompletedIssueIds(jsonlPath: string): Set<number> {
    // Only successful cells count as completed — failed lines get retried on resume.
    const cells = loadCellsJsonl(jsonlPath).filter((c) => c.status === "ok");

    return new Set(cells.map((c) => c.issue_id));
}

function materialiseFixtures(
    issues: readonly ReplayIssue[],
    fixturesDir: string,
): void {
    mkdirSync(fixturesDir, { recursive: true });

    for (const item of issues) {
        const fixturePath = join(
            fixturesDir,
            `${item.raw_issue.issue_id}.json`,
        );

        writeFileSync(fixturePath, JSON.stringify(item.raw_issue, null, 2));
    }
}

interface SweepResult {
    engine: Engine;
    ok: number;
    err: number;
}

async function sweepEngine(
    engine: Engine,
    issues: readonly ReplayIssue[],
    args: Args,
): Promise<SweepResult> {
    const resultsPath = join(args.resultsDir, `results-${engine}.jsonl`);

    const completed = args.resume
        ? loadCompletedIssueIds(resultsPath)
        : new Set<number>();

    const log = (msg: string): void => {
        process.stderr.write(`[run:${engine}] ${msg}\n`);
    };

    log(
        `resuming, ${completed.size}/${issues.length} already complete (concurrency=${args.concurrency})`,
    );

    const remaining = issues.filter(
        (i) => !completed.has(i.raw_issue.issue_id),
    );

    // Concurrent writers append to the same JSONL via fs.appendFileSync. POSIX
    // O_APPEND guarantees the write syscall is atomic for regular files, and
    // each line stays well under the page-size threshold, so interleaving lines
    // mid-write is not a concern.
    const cells = await poolMap(remaining, args.concurrency, async (item) => {
        const id = item.raw_issue.issue_id;
        const fixturePath = join(args.fixturesDir, `${id}.json`);

        log(`#${id} …`);

        // spawnTriage is structured to never throw, but the defensive wrap means
        // a future refactor (or upstream Zod/fs throw) doesn't abort the sweep.
        let cell: CellOutput;

        try {
            cell = await spawnTriage({
                engine,
                fixturePath,
                issueId: id,
                timeoutMs: args.timeoutMs,
                anthropicModel: args.anthropicModel,
            });
        } catch (err) {
            cell = {
                status: "spawn-error",
                engine,
                issue_id: id,
                wall_clock_ms: 0,
                message: `unexpected throw: ${err instanceof Error ? err.message : String(err)}`,
            };
        }

        appendFileSync(resultsPath, `${JSON.stringify(cell)}\n`);

        const verdict = cell.status === "ok" ? "ok" : `err(${cell.status})`;
        log(`  #${id} ${verdict} (${cell.wall_clock_ms}ms)`);

        return cell;
    });

    const ok = cells.filter((c) => c.status === "ok").length;
    const err = cells.length - ok;

    log(`done — ok=${ok} err=${err}`);

    return { engine, ok, err };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const log = (msg: string): void => {
        process.stderr.write(`[run] ${msg}\n`);
    };

    log(
        `engines=${args.engines.join(",")} model=${args.anthropicModel} issues=${args.issuesPath}`,
    );

    const manifest = loadManifest(args.issuesPath);
    const issues = manifest.issues;
    log(`loaded ${issues.length} issues`);

    mkdirSync(args.resultsDir, { recursive: true });
    materialiseFixtures(issues, args.fixturesDir);

    const summaries = await Promise.all(
        args.engines.map((engine) => sweepEngine(engine, issues, args)),
    );

    log("sweep complete:");

    for (const s of summaries) {
        log(`  ${s.engine}: ok=${s.ok} err=${s.err}`);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err: unknown) => {
        process.stderr.write(
            `\n[run error] ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
    });
}
