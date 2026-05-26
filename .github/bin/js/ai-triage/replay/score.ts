/**
 * Replay-benchmark — scoring + report generation.
 *
 * Joins issues.json (ground truth) with results-<engine>.jsonl (CellOutput
 * lines from run.ts), grades each cell on four axes, and emits
 * `reports/replay-YYYY-MM-DD.md` — the committed markdown summary.
 *
 * Scoring caveats — see the report header for the full version:
 *   - Domain      : hard ground truth (maintainer-set label)
 *   - Disposition : derived from state_reason; ambiguous cases skipped
 *   - Duplicate   : recall only (no negative ground truth)
 *   - Severity    : DIRECTIONAL ONLY — priority/* ≠ technical severity
 *
 * Usage:
 *   tsx replay/score.ts                              # default paths
 *   tsx replay/score.ts --date 2026-05-26            # override report date
 *   tsx replay/score.ts --results-dir custom/path
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ENGINES,
    DOMAIN_PREFIX,
    VOCAB_VIOLATION_COL,
    MISSING_COL,
    loadCellsJsonl,
    loadManifest,
    type Engine,
    type OkCell,
    type ReplayIssue,
    type Disposition,
    type Severity,
    CellOutput,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DOMAIN_PASS_THRESHOLD = 0.7;
const COST_PER_ISSUE_PASS_USD = 0.1;

interface Args {
    issuesPath: string;
    resultsDir: string;
    reportsDir: string;
    date: string;
}

function parseArgs(argv: readonly string[]): Args {
    const get = (flag: string): string | null => {
        const i = argv.indexOf(flag);

        return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
    };

    return {
        issuesPath: get("--issues") ?? resolve(__dirname, "issues.json"),
        resultsDir: get("--results-dir") ?? resolve(__dirname, "results"),
        reportsDir: get("--reports-dir") ?? resolve(__dirname, "..", "reports"),
        date: get("--date") ?? new Date().toISOString().slice(0, 10),
    };
}

type Match<T> =
    | { kind: "scored"; expected: T; actual: T; correct: boolean }
    | { kind: "skipped" };

interface ScoredCell {
    status: "scored";
    engine: Engine;
    issueId: number;
    expectedDomain: string;
    suggestedLabels: readonly string[];
    domainMatch: boolean;
    domainInVocab: boolean;
    disposition: Match<Disposition>;
    severity: Match<Severity>;
    duplicate: Match<number | null>;
    confidence: number;
    costUsd: number | null;
    wallMs: number;
}

interface FailedCell {
    status: "failed";
    engine: Engine;
    issueId: number;
    expectedDomain: string;
    reason: string;
    message: string | null;
}

type Cell = ScoredCell | FailedCell;

function makeMatch<T, U>(expected: T | null, actual: U): Match<T | U> {
    if (expected === null) {
        return { kind: "skipped" };
    }

    return {
        kind: "scored",
        expected,
        actual,
        correct: (expected as unknown) === actual,
    };
}

function scoreOk(
    engine: Engine,
    issue: ReplayIssue,
    cell: OkCell,
    realDomains: ReadonlySet<string>,
): ScoredCell {
    const expected = issue.expected;
    const suggestedDomains = cell.triage.suggested_labels.filter((l) =>
        l.startsWith(DOMAIN_PREFIX),
    );

    const domainMatch = suggestedDomains.includes(expected.domain);
    const domainInVocab = suggestedDomains.every((l) => realDomains.has(l));

    return {
        status: "scored",
        engine,
        issueId: issue.raw_issue.issue_id,
        expectedDomain: expected.domain,
        suggestedLabels: cell.triage.suggested_labels,
        domainMatch,
        domainInVocab,
        disposition: makeMatch(
            expected.disposition_hint,
            cell.triage.disposition,
        ),
        severity: makeMatch(expected.severity_hint, cell.triage.severity),
        duplicate: makeMatch(expected.duplicate_of, cell.triage.duplicate_of),
        confidence: cell.triage.confidence,
        costUsd: cell.usage?.total_cost_usd ?? null,
        wallMs: cell.wall_clock_ms,
    };
}

function scoreIssue(
    engine: Engine,
    issue: ReplayIssue,
    cell: CellOutput | undefined,
    realDomains: ReadonlySet<string>,
): Cell {
    if (!cell) {
        return {
            status: "failed",
            engine,
            issueId: issue.raw_issue.issue_id,
            expectedDomain: issue.expected.domain,
            reason: "missing",
            message: null,
        };
    }

    if (cell.status !== "ok") {
        return {
            status: "failed",
            engine,
            issueId: issue.raw_issue.issue_id,
            expectedDomain: issue.expected.domain,
            reason: cell.status,
            message: cell.message,
        };
    }

    return scoreOk(engine, issue, cell, realDomains);
}

interface EngineMetrics {
    engine: Engine;
    total: number;
    scored: number;
    failed: number;
    domainMatchRate: number;
    vocabViolations: number;
    criticalFalsePositives: number;
    dispositionRate: number;
    dispositionN: number;
    severityRate: number;
    severityN: number;
    duplicateRecall: number;
    duplicateN: number;
    meanConfCorrect: number | null;
    meanConfWrong: number | null;
    totalCostUsd: number;
    costPerIssueUsd: number | null;
    wallP50s: number;
    wallP95s: number;
}

function mean(xs: readonly number[]): number | null {
    if (xs.length === 0) {
        return null;
    }

    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(sortedAsc: readonly number[], p: number): number {
    if (sortedAsc.length === 0) {
        return 0;
    }

    const idx = Math.min(
        sortedAsc.length - 1,
        Math.floor((sortedAsc.length - 1) * p),
    );

    return sortedAsc[idx];
}

function rateOf<T>(items: readonly T[], pred: (t: T) => boolean): number {
    if (items.length === 0) {
        return 0;
    }

    return items.filter(pred).length / items.length;
}

function scoredOnly(cells: readonly Cell[]): ScoredCell[] {
    return cells.filter((c): c is ScoredCell => c.status === "scored");
}

function aggregate(engine: Engine, cells: readonly Cell[]): EngineMetrics {
    const scored = scoredOnly(cells);

    const dispScored = scored.filter((c) => c.disposition.kind === "scored");
    const sevScored = scored.filter((c) => c.severity.kind === "scored");
    const dupScored = scored.filter((c) => c.duplicate.kind === "scored");

    const correctConfs = scored
        .filter((c) => c.domainMatch)
        .map((c) => c.confidence);
    const wrongConfs = scored
        .filter((c) => !c.domainMatch)
        .map((c) => c.confidence);

    const walls = scored.map((c) => c.wallMs / 1000).sort((a, b) => a - b);
    const totalCost = scored.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);

    const criticalFP = scored.filter(
        (c) =>
            c.severity.kind === "scored" &&
            c.severity.actual === "critical" &&
            c.severity.expected !== "critical",
    ).length;

    return {
        engine,
        total: cells.length,
        scored: scored.length,
        failed: cells.length - scored.length,
        domainMatchRate: rateOf(scored, (c) => c.domainMatch),
        vocabViolations: scored.filter((c) => !c.domainInVocab).length,
        criticalFalsePositives: criticalFP,
        dispositionRate: rateOf(
            dispScored,
            (c) => c.disposition.kind === "scored" && c.disposition.correct,
        ),
        dispositionN: dispScored.length,
        severityRate: rateOf(
            sevScored,
            (c) => c.severity.kind === "scored" && c.severity.correct,
        ),
        severityN: sevScored.length,
        duplicateRecall: rateOf(
            dupScored,
            (c) => c.duplicate.kind === "scored" && c.duplicate.correct,
        ),
        duplicateN: dupScored.length,
        meanConfCorrect: mean(correctConfs),
        meanConfWrong: mean(wrongConfs),
        totalCostUsd: totalCost,
        costPerIssueUsd: scored.length === 0 ? null : totalCost / scored.length,
        wallP50s: percentile(walls, 0.5),
        wallP95s: percentile(walls, 0.95),
    };
}

function pickConfusionColumn(
    cell: ScoredCell,
    realDomains: ReadonlySet<string>,
): string {
    const first = cell.suggestedLabels.find((l) => l.startsWith(DOMAIN_PREFIX));

    if (!first) {
        return MISSING_COL;
    }
    if (!realDomains.has(first)) {
        return VOCAB_VIOLATION_COL;
    }

    return first;
}

function buildConfusionMatrix(
    cells: readonly Cell[],
    realDomains: ReadonlySet<string>,
): Map<string, Map<string, number>> {
    const matrix = new Map<string, Map<string, number>>();

    for (const cell of scoredOnly(cells)) {
        const col = pickConfusionColumn(cell, realDomains);
        const row =
            matrix.get(cell.expectedDomain) ?? new Map<string, number>();

        row.set(col, (row.get(col) ?? 0) + 1);
        matrix.set(cell.expectedDomain, row);
    }

    return matrix;
}

function pct(x: number): string {
    return `${(x * 100).toFixed(1)}%`;
}

function passMark(passed: boolean): string {
    return passed ? "PASS" : "FAIL";
}

function renderCaveats(): string {
    return [
        "## Scoring caveats",
        "",
        "- **Domain**: hard ground truth (maintainer-set label).",
        "- **Disposition**: derived from GitHub `state_reason` + label hints; ambiguous cases skipped.",
        "- **Duplicate**: recall only — no negative ground truth; false-positives on `disposition=duplicate` not scored.",
        "- **Severity**: DIRECTIONAL ONLY. Shopware `priority/*` measures business urgency, not technical severity (per `CLASSIFICATION.md`). Treat numbers as a smell test, not benchmark-grade.",
    ].join("\n");
}

function renderVocabDrift(
    skill: ReadonlySet<string>,
    repo: ReadonlySet<string>,
): string {
    const skillOnly = [...skill].filter((d) => !repo.has(d)).sort();
    const repoOnly = [...repo].filter((d) => !skill.has(d)).sort();

    if (skillOnly.length === 0 && repoOnly.length === 0) {
        return "";
    }

    const fmt = (xs: string[]): string =>
        xs.map((s) => `\`${s}\``).join(", ") || "_none_";

    return [
        "## Vocabulary drift — `DOMAINS.md` vs. repo labels",
        "",
        "The agent's allowed vocabulary (`DOMAINS.md`) differs from the repository's actual `domain/*` label set. Suggestions emitting labels not present on the repo are counted as vocab-violations and cannot match any real issue.",
        "",
        `- In \`DOMAINS.md\` but not on repo (${skillOnly.length}): ${fmt(skillOnly)}`,
        `- On repo but not in \`DOMAINS.md\` (${repoOnly.length}): ${fmt(repoOnly)}`,
    ].join("\n");
}

function renderGoNoGo(metrics: readonly EngineMetrics[]): string {
    const engines = metrics.map((m) => m.engine);
    const row = (label: string, values: readonly string[]): string =>
        `| ${label} | ${values.join(" | ")} |`;

    const domainCell = (m: EngineMetrics): string =>
        `${passMark(m.domainMatchRate >= DOMAIN_PASS_THRESHOLD)} ${pct(m.domainMatchRate)}`;

    const criticalCell = (m: EngineMetrics): string =>
        `${passMark(m.criticalFalsePositives === 0)} ${m.criticalFalsePositives}`;

    const costCell = (m: EngineMetrics): string => {
        if (m.costPerIssueUsd === null) {
            return "n/a";
        }

        const passed =
            m.costPerIssueUsd > 0 &&
            m.costPerIssueUsd < COST_PER_ISSUE_PASS_USD;

        return `${passMark(passed)} $${m.costPerIssueUsd.toFixed(4)}`;
    };

    return [
        "## Go/no-go criteria",
        "",
        "From `ai-triage-idea.md`. Per-engine pass/fail:",
        "",
        `| Criterion | ${engines.join(" | ")} |`,
        `|---|${engines.map(() => "---").join("|")}|`,
        row(
            `Domain match ≥ ${pct(DOMAIN_PASS_THRESHOLD)}`,
            metrics.map(domainCell),
        ),
        row(
            "Zero `severity=critical` false-positives",
            metrics.map(criticalCell),
        ),
        row(
            `Cost / issue < $${COST_PER_ISSUE_PASS_USD.toFixed(2)}`,
            metrics.map(costCell),
        ),
    ].join("\n");
}

function renderSummary(metrics: readonly EngineMetrics[]): string {
    const engines = metrics.map((m) => m.engine);
    const row = (label: string, vals: readonly (string | number)[]): string =>
        `| ${label} | ${vals.join(" | ")} |`;

    return [
        "## Per-engine summary",
        "",
        `| Metric | ${engines.join(" | ")} |`,
        `|---|${engines.map(() => "---").join("|")}|`,
        row(
            "total",
            metrics.map((m) => m.total),
        ),
        row(
            "scored",
            metrics.map((m) => m.scored),
        ),
        row(
            "failed",
            metrics.map((m) => m.failed),
        ),
        row(
            "domain_match",
            metrics.map((m) => pct(m.domainMatchRate)),
        ),
        row(
            "domain_vocab_violations",
            metrics.map((m) => m.vocabViolations),
        ),
        row(
            "disposition_match (n)",
            metrics.map(
                (m) => `${pct(m.dispositionRate)} (n=${m.dispositionN})`,
            ),
        ),
        row(
            "severity_match* (n)",
            metrics.map((m) => `${pct(m.severityRate)} (n=${m.severityN})`),
        ),
        row(
            "duplicate_recall (n)",
            metrics.map((m) => `${pct(m.duplicateRecall)} (n=${m.duplicateN})`),
        ),
        row(
            "mean_conf (correct)",
            metrics.map((m) => m.meanConfCorrect?.toFixed(2) ?? "—"),
        ),
        row(
            "mean_conf (wrong)",
            metrics.map((m) => m.meanConfWrong?.toFixed(2) ?? "—"),
        ),
        row(
            "cost_total_usd",
            metrics.map((m) => `$${m.totalCostUsd.toFixed(4)}`),
        ),
        row(
            "cost_per_issue_usd",
            metrics.map((m) =>
                m.costPerIssueUsd === null
                    ? "—"
                    : `$${m.costPerIssueUsd.toFixed(4)}`,
            ),
        ),
        row(
            "wall_p50_s",
            metrics.map((m) => m.wallP50s.toFixed(1)),
        ),
        row(
            "wall_p95_s",
            metrics.map((m) => m.wallP95s.toFixed(1)),
        ),
        "",
        "\\* severity is directional only — see scoring caveats",
    ].join("\n");
}

function renderConfusionMatrix(
    engine: Engine,
    cells: readonly Cell[],
    realDomains: ReadonlySet<string>,
): string {
    const domains = [...realDomains].sort();
    const matrix = buildConfusionMatrix(cells, realDomains);
    const cols = [...domains, "<vocab-violation>", "<missing>"];

    const dataRows = domains
        .map((expected) => {
            const row = matrix.get(expected);
            const counts = cols.map((col) => row?.get(col) ?? 0);

            if (counts.every((v) => v === 0)) {
                return null;
            }

            return `| \`${expected.replace(DOMAIN_PREFIX, "")}\` | ${counts.join(" | ")} |`;
        })
        .filter((line): line is string => line !== null);

    return [
        `<details><summary>Confusion matrix — ${engine}</summary>`,
        "",
        "Rows = expected (real maintainer-set label). Columns = agent's first suggested `domain/*` label.",
        "",
        `| expected ↓ \\ actual → | ${cols.map((c) => `\`${c.replace(DOMAIN_PREFIX, "")}\``).join(" | ")} |`,
        `|---|${cols.map(() => "---").join("|")}|`,
        ...dataRows,
        "",
        "</details>",
    ].join("\n");
}

function renderEngineErrors(engine: Engine, cells: readonly Cell[]): string {
    const failed = cells.filter((c): c is FailedCell => c.status === "failed");

    if (failed.length === 0) {
        return `### ${engine} (0)\n\n_None._`;
    }

    const lines = failed
        .slice(0, 10)
        .map(
            (c) =>
                `- #${c.issueId} \`${c.reason}\` — ${(c.message ?? "").slice(0, 200).replace(/\n/g, " ")}`,
        );

    const overflow =
        failed.length > 10 ? [`- _… and ${failed.length - 10} more_`] : [];

    return [`### ${engine} (${failed.length})`, "", ...lines, ...overflow].join(
        "\n",
    );
}

function renderReport(
    date: string,
    issues: readonly ReplayIssue[],
    perEngine: ReadonlyMap<Engine, readonly Cell[]>,
    metrics: readonly EngineMetrics[],
    realDomains: ReadonlySet<string>,
    skillDomains: ReadonlySet<string>,
): string {
    const engines = [...perEngine.keys()];
    const header = [
        `# AI Triage Replay Benchmark — ${date}`,
        "",
        `**Sample**: ${issues.length} closed issues, stratified by \`domain/*\` label, last 6 months.`,
        `**Engines**: ${engines.join(", ")}.`,
    ].join("\n");

    const sections = [
        header,
        renderCaveats(),
        renderVocabDrift(skillDomains, realDomains),
        renderGoNoGo(metrics),
        renderSummary(metrics),
        ...engines.map((e) =>
            renderConfusionMatrix(e, perEngine.get(e)!, realDomains),
        ),
        "## Engine errors\n",
        ...engines.map((e) => renderEngineErrors(e, perEngine.get(e)!)),
        "## Recommendation\n",
        "_(Author to write 1–2 paragraphs interpreting the numbers above and recommending go / partial-go / no-go on shadow rollout. Reference the go/no-go table.)_",
    ];

    return sections.filter((s) => s !== "").join("\n\n") + "\n";
}

const DOMAINS_MD_PATH = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    ".claude/skills/triage/references/DOMAINS.md",
);

function parseSkillDomains(domainsMdPath: string): Set<string> {
    const text = readFileSync(domainsMdPath, "utf8");

    return new Set(
        [...text.matchAll(/`(domain\/[a-z0-9-]+)`/g)].map((m) => m[1]),
    );
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));

    const manifest = loadManifest(args.issuesPath);
    const issues = manifest.issues;
    const realDomains = new Set(manifest.domains_on_repo);
    const skillDomains = parseSkillDomains(DOMAINS_MD_PATH);

    const perEngine = new Map<Engine, Cell[]>();

    for (const engine of ENGINES) {
        const path = join(args.resultsDir, `results-${engine}.jsonl`);
        const cells = loadCellsJsonl(path);

        if (cells.length === 0) {
            continue;
        }

        const cellsById = new Map(cells.map((c) => [c.issue_id, c]));
        const scored = issues.map((issue) =>
            scoreIssue(
                engine,
                issue,
                cellsById.get(issue.raw_issue.issue_id),
                realDomains,
            ),
        );
        perEngine.set(engine, scored);
    }

    if (perEngine.size === 0) {
        throw new Error(
            `no results found in ${args.resultsDir} — run replay:run first`,
        );
    }

    const metrics = [...perEngine.entries()].map(([engine, cells]) =>
        aggregate(engine, cells),
    );

    mkdirSync(args.reportsDir, { recursive: true });

    const mdPath = join(args.reportsDir, `replay-${args.date}.md`);

    writeFileSync(
        mdPath,
        renderReport(
            args.date,
            issues,
            perEngine,
            metrics,
            realDomains,
            skillDomains,
        ),
    );

    process.stderr.write(`\n[score] wrote ${mdPath}\n`);

    for (const m of metrics) {
        process.stderr.write(
            `[score] ${m.engine}: domain=${pct(m.domainMatchRate)} scored=${m.scored}/${m.total} cost=$${m.totalCostUsd.toFixed(2)}\n`,
        );
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (err) {
        process.stderr.write(
            `\n[score error] ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
    }
}
