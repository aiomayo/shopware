/**
 * Replay-benchmark — stratified issue selection.
 *
 * Picks N closed issues per `domain/*` label (last 6 months), excluding
 * security advisories, bot authors, and PRs. Derives ground truth from GitHub
 * state (labels + state_reason + timeline events) so the harness needs no
 * hand-labeling.
 *
 * Usage:
 *   tsx replay/select-issues.ts                                # 3 per domain, last 6 months
 *   tsx replay/select-issues.ts --per-domain 1                 # smoke test
 *   tsx replay/select-issues.ts --domains checkout,framework   # subset
 *   tsx replay/select-issues.ts --since 2026-01-01             # explicit cutoff
 *   tsx replay/select-issues.ts --out custom.json              # alt output
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { RawIssue, truncateRawIssueInput } from "../skill/input.ts";
import {
    ReplayIssue,
    ReplayManifest,
    REPLAY_MANIFEST_VERSION,
    DOMAIN_PREFIX,
    type Disposition,
    type PriorityHint,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PER_DOMAIN = 10;
const DEFAULT_LOOKBACK_MONTHS = 6;
const DEFAULT_REPO = "shopware/shopware";
const MIN_LIST_LIMIT = 30;
const LIST_LIMIT_MULTIPLIER = 3;

const BOT_AUTHORS = new Set([
    "dependabot[bot]",
    "github-actions[bot]",
    "renovate[bot]",
    "shopwareBot",
]);

const FEATURE_LABELS = new Set([
    "kind/feature",
    "triage/feature-request",
    "type/feature",
]);

const NOT_A_BUG_LABELS = new Set([
    "triage/not-a-bug",
    "type/question",
    "kind/question",
]);

interface Args {
    perDomain: number;
    domains: string[] | null;
    since: string;
    out: string;
    repo: string;
}

function parseArgs(argv: readonly string[]): Args {
    const get = (flag: string): string | null => {
        const i = argv.indexOf(flag);

        return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
    };

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - DEFAULT_LOOKBACK_MONTHS);

    return {
        perDomain: Number(get("--per-domain") ?? String(DEFAULT_PER_DOMAIN)),
        domains:
            get("--domains")
                ?.split(",")
                .map((s) => s.trim()) ?? null,
        since: get("--since") ?? sixMonthsAgo.toISOString().slice(0, 10),
        out: get("--out") ?? resolve(__dirname, "issues.json"),
        repo: get("--repo") ?? process.env.AI_TRIAGE_REPO ?? DEFAULT_REPO,
    };
}

function gh(args: readonly string[]): string {
    const result = spawnSync("gh", [...args], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
    });

    if (result.status !== 0) {
        throw new Error(
            `gh ${args.join(" ")} failed (exit=${result.status}): ${result.stderr.trim()}`,
        );
    }

    return result.stdout;
}

const RepoLabel = z.object({
    name: z.string(),
    description: z.string().nullable(),
});

export function listDomainLabels(repo: string): string[] {
    const raw = gh([
        "label",
        "list",
        "-R",
        repo,
        "--limit",
        "200",
        "--json",
        "name,description",
    ]);
    const labels = z.array(RepoLabel).parse(JSON.parse(raw));

    return labels
        .filter((l) => l.name.startsWith(DOMAIN_PREFIX))
        .filter(
            (l) =>
                !(l.description ?? "").toLowerCase().startsWith("deprecated"),
        )
        .map((l) => l.name)
        .sort();
}

export const IssueListItem = z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    labels: z.array(z.object({ name: z.string() })),
    closedAt: z.string().nullable(),
    stateReason: z.string().nullable(),
    url: z.string(),
    author: z.object({ login: z.string().nullable() }).nullable(),
});
export type IssueListItem = z.infer<typeof IssueListItem>;

function listClosedIssues(
    repo: string,
    label: string,
    since: string,
    limit: number,
): IssueListItem[] {
    const search = `closed:>=${since} is:issue is:closed label:"${label}"`;
    const raw = gh([
        "issue",
        "list",
        "-R",
        repo,
        "--state",
        "closed",
        "--search",
        search,
        "--limit",
        String(limit),
        "--json",
        "number,title,body,labels,closedAt,stateReason,url,author",
    ]);

    return z.array(IssueListItem).parse(JSON.parse(raw));
}

const TimelineEvent = z
    .object({
        event: z.string(),
        canonical: z.object({ number: z.number() }).optional(),
    })
    .passthrough();

function findDuplicateOf(repo: string, issueNumber: number): number | null {
    try {
        const raw = gh([
            "api",
            `repos/${repo}/issues/${issueNumber}/timeline`,
            "--paginate",
            "-H",
            "Accept: application/vnd.github+json",
        ]);
        const events = z.array(TimelineEvent).parse(JSON.parse(raw));
        const dup = events.find(
            (e) => e.event === "marked_as_duplicate" && e.canonical?.number,
        );

        return dup?.canonical?.number ?? null;
    } catch {
        // Older duplicates predate the `marked_as_duplicate` event type. Treat
        // unresolvable canonicals as no ground truth rather than failing selection.
        return null;
    }
}

export type Classification =
    | { kind: "kept"; issue: IssueListItem }
    | {
          kind: "excluded";
          reason: "security-label" | "bot-author" | "test-plan-title";
      };

export function classify(issue: IssueListItem): Classification {
    const labelNames = issue.labels.map((l) => l.name);
    const hasSecurityLabel = labelNames.some(
        (n) =>
            n.startsWith("sec/") ||
            n.startsWith("security/") ||
            n.toUpperCase().startsWith("CVE-"),
    );

    if (hasSecurityLabel) {
        return { kind: "excluded", reason: "security-label" };
    }

    if (issue.author?.login && BOT_AUTHORS.has(issue.author.login)) {
        return { kind: "excluded", reason: "bot-author" };
    }

    if (/\[Test Plan\]/i.test(issue.title)) {
        return { kind: "excluded", reason: "test-plan-title" };
    }

    return { kind: "kept", issue };
}

export function deriveDispositionHint(
    issue: IssueListItem,
): Disposition | null {
    const labelNames = issue.labels.map((l) => l.name);
    const isFeature = labelNames.some((n) => FEATURE_LABELS.has(n));
    const isNotABug = labelNames.some((n) => NOT_A_BUG_LABELS.has(n));

    // `gh issue list --json stateReason` returns the GraphQL enum form (uppercase
    // SCREAMING_SNAKE), not the REST `state_reason` field (lowercase snake_case).
    switch ((issue.stateReason ?? "").toLowerCase()) {
        case "completed":
            return isFeature ? "feature-request" : "valid-bug";
        case "duplicate":
            return "duplicate";
        case "not_planned":
        case "not planned":
            if (isFeature) {
                return "feature-request";
            }
            if (isNotABug) {
                return "not-a-bug";
            }
            return null;
        default:
            return null;
    }
}

/**
 * Maps Shopware `priority/*` labels to the skill's severity enum.
 *
 * Directional only — Shopware priority measures business urgency, not technical
 * severity (CLASSIFICATION.md). Scoring downstream caveats this.
 */
export function deriveSeverityHint(issue: IssueListItem): PriorityHint | null {
    const labelNames = new Set(issue.labels.map((l) => l.name));

    if (labelNames.has("priority/critical")) {
        return "critical";
    }
    if (labelNames.has("priority/high")) {
        return "high";
    }
    if (labelNames.has("priority/low")) {
        return "low";
    }

    return null;
}

function toReplayIssue(
    domain: string,
    repo: string,
    issue: IssueListItem,
): ReplayIssue {
    const isDuplicate = (issue.stateReason ?? "").toLowerCase() === "duplicate";
    const duplicateOf = isDuplicate
        ? findDuplicateOf(repo, issue.number)
        : null;

    // Run gh's full-body output through the same truncate the wrapper applies to
    // CI fetches — keeps issues.json bounded and aligned with what triage.ts will
    // see at run-time.
    const rawIssue = RawIssue.parse(
        truncateRawIssueInput({
            issue_id: issue.number,
            title: issue.title,
            body: issue.body,
            labels: issue.labels.map((l) => l.name),
            state: "closed",
        }),
    );

    return {
        raw_issue: rawIssue,
        expected: {
            domain,
            severity_hint: deriveSeverityHint(issue),
            disposition_hint: deriveDispositionHint(issue),
            duplicate_of: duplicateOf,
        },
        meta: {
            closed_at: issue.closedAt,
            state_reason: issue.stateReason,
            url: issue.url,
        },
    };
}

interface SelectionState {
    picked: ReplayIssue[];
    skipCounts: Readonly<Record<string, number>>;
}

interface SelectionOpts {
    perDomain: number;
    repo: string;
    since: string;
}

function selectForDomain(
    state: SelectionState,
    domain: string,
    opts: SelectionOpts,
): SelectionState {
    const seen = new Set(state.picked.map((p) => p.raw_issue.issue_id));
    const limit = Math.max(
        opts.perDomain * LIST_LIMIT_MULTIPLIER,
        MIN_LIST_LIMIT,
    );
    const candidates = listClosedIssues(opts.repo, domain, opts.since, limit);
    const classified = candidates.map(classify);

    const newSkips = classified
        .filter(
            (c): c is Extract<Classification, { kind: "excluded" }> =>
                c.kind === "excluded",
        )
        .map((c) => c.reason);

    const kept = classified
        .filter(
            (c): c is Extract<Classification, { kind: "kept" }> =>
                c.kind === "kept",
        )
        .map((c) => c.issue)
        .filter((i) => !seen.has(i.number))
        .slice(0, opts.perDomain)
        .map((i) => toReplayIssue(domain, opts.repo, i));

    return {
        picked: [...state.picked, ...kept],
        skipCounts: newSkips.reduce(
            (acc, reason) => ({ ...acc, [reason]: (acc[reason] ?? 0) + 1 }),
            state.skipCounts,
        ),
    };
}

function resolveDomains(
    allLabels: readonly string[],
    requested: string[] | null,
): string[] {
    if (requested === null) {
        return [...allLabels];
    }

    return allLabels.filter((label) =>
        requested.some(
            (name) => label === name || label === `${DOMAIN_PREFIX}${name}`,
        ),
    );
}

function writeJsonAtomic(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
}

function countByDomain(
    issues: readonly ReplayIssue[],
    domains: readonly string[],
): Record<string, number> {
    return Object.fromEntries(
        domains.map((d) => [
            d,
            issues.filter((i) => i.expected.domain === d).length,
        ]),
    );
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const log = (msg: string): void => {
        process.stderr.write(`[select] ${msg}\n`);
    };

    log(`repo=${args.repo} per-domain=${args.perDomain} since=${args.since}`);

    const allLabels = listDomainLabels(args.repo);
    log(
        `active domain/* labels on repo: ${allLabels.length} (${allLabels.join(", ")})`,
    );

    const domains = resolveDomains(allLabels, args.domains);
    log(`sampling ${domains.length} domain(s): ${domains.join(", ")}`);

    const opts: SelectionOpts = {
        perDomain: args.perDomain,
        repo: args.repo,
        since: args.since,
    };
    const final = domains.reduce<SelectionState>(
        (state, domain) => selectForDomain(state, domain, opts),
        { picked: [], skipCounts: {} },
    );

    const manifest: ReplayManifest = {
        schema_version: REPLAY_MANIFEST_VERSION,
        repo: args.repo,
        generated_at: new Date().toISOString(),
        domains_on_repo: allLabels,
        issues: final.picked,
    };
    writeJsonAtomic(args.out, manifest);

    log(`wrote ${final.picked.length} issues → ${args.out}`);
    log(`per-domain: ${JSON.stringify(countByDomain(final.picked, domains))}`);

    if (Object.keys(final.skipCounts).length > 0) {
        log(`excluded:   ${JSON.stringify(final.skipCounts)}`);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (err) {
        process.stderr.write(
            `\n[select error] ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
    }
}
