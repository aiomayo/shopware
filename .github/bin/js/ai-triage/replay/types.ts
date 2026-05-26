/**
 * Shared schemas + constants for the replay harness.
 *
 * Wherever possible, foundation schemas (`RawIssue`, `TriageOutput`) are
 * imported instead of redeclared so the wrapper-skill contract stays the
 * single source of truth.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { RawIssue } from "../skill/input.ts";
import { TriageOutput } from "../skill/output.ts";

export const ENGINES = ["opencode", "codex", "claude"] as const;
export type Engine = (typeof ENGINES)[number];

export const DOMAIN_PREFIX = "domain/";
export const VOCAB_VIOLATION_COL = "<vocab-violation>";
export const MISSING_COL = "<missing>";

export const Disposition = TriageOutput.shape.disposition;
export type Disposition = z.infer<typeof Disposition>;

export const Severity = TriageOutput.shape.severity;
export type Severity = z.infer<typeof Severity>;

// Shopware uses three priority buckets — no `medium`. Distinct from `Severity`
// (which has 4) because priority labels measure business urgency, not
// technical impact. See `.claude/skills/triage/references/CLASSIFICATION.md`.
export const PriorityHint = z.enum(["low", "high", "critical"]);
export type PriorityHint = z.infer<typeof PriorityHint>;

export const ReplayIssue = z.object({
    raw_issue: RawIssue,
    expected: z.object({
        domain: z.string(),
        severity_hint: PriorityHint.nullable(),
        disposition_hint: Disposition.nullable(),
        duplicate_of: z.number().nullable(),
    }),
    meta: z.object({
        closed_at: z.string().nullable(),
        state_reason: z.string().nullable(),
        url: z.string(),
    }),
});
export type ReplayIssue = z.infer<typeof ReplayIssue>;

export const REPLAY_MANIFEST_VERSION = 1;

export const ReplayManifest = z.object({
    schema_version: z.literal(REPLAY_MANIFEST_VERSION),
    repo: z.string(),
    generated_at: z.string(),
    domains_on_repo: z.array(z.string()),
    issues: z.array(ReplayIssue),
});
export type ReplayManifest = z.infer<typeof ReplayManifest>;

/**
 * Reads + version-checks a `replay/issues.json` manifest. Throws with a
 * humanised hint if the file is the pre-v1 raw-array format or the version
 * field is wrong / missing — Zod's default error here is opaque.
 */
export function loadManifest(path: string): ReplayManifest {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;

    if (Array.isArray(raw)) {
        throw new Error(
            `${path} is the pre-v1 bare-array format. Re-run \`replay:select\` to regenerate.`,
        );
    }

    const version = (raw as { schema_version?: unknown })?.schema_version;
    if (version !== REPLAY_MANIFEST_VERSION) {
        throw new Error(
            `${path} schema_version is ${JSON.stringify(version)}, expected ${REPLAY_MANIFEST_VERSION}. ` +
                `Re-run \`replay:select\` to regenerate.`,
        );
    }

    return ReplayManifest.parse(raw);
}

const UsagePayload = z.object({
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
    total_tokens: z.number().nullable(),
    total_cost_usd: z.number().nullable(),
});

/**
 * One JSONL line emitted by run.ts. Discriminated by `status` — every consumer
 * narrows on it before touching the engine output.
 */
export const CellOutput = z.discriminatedUnion("status", [
    z
        .object({
            status: z.literal("ok"),
            issue_id: z.number(),
            engine: z.string(),
            wall_clock_ms: z.number(),
            triage: TriageOutput,
            usage: UsagePayload.optional(),
        })
        .passthrough(),
    z
        .object({
            status: z.enum([
                "spawn-error",
                "engine-error",
                "timeout",
                "parse-error",
                "missing",
            ]),
            issue_id: z.number(),
            engine: z.string(),
            wall_clock_ms: z.number(),
            message: z.string(),
        })
        .passthrough(),
]);
export type CellOutput = z.infer<typeof CellOutput>;
export type OkCell = Extract<CellOutput, { status: "ok" }>;

export function loadCellsJsonl(path: string): CellOutput[] {
    if (!existsSync(path)) {
        return [];
    }

    let skipped = 0;
    const cells = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line, index) => {
            try {
                return [CellOutput.parse(JSON.parse(line))];
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(
                    `[loadCellsJsonl] ${path}:${index + 1} skipped — ${msg.slice(0, 200)}\n`,
                );
                skipped += 1;
                return [];
            }
        });

    if (skipped > 0) {
        process.stderr.write(
            `[loadCellsJsonl] ${skipped} line(s) dropped from ${path}\n`,
        );
    }

    return cells;
}
