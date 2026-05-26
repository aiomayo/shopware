# AI Triage — Replay Benchmark

Offline evaluation harness: re-runs the triage agent against historical
closed issues whose ground-truth labels were set by maintainers, then scores
the agent's output against that ground truth. Produces a committed report
that decides whether to wire the agent into a real `issues.opened` trigger.

This is a **dev tool**, not a CI workflow. The committed report under
`../reports/` is the artefact-of-record.

## Pipeline

```
.claude/skills/triage/references/DOMAINS.md   ← skill's allowed label vocab
            │
            ▼
  replay:select  ────►  replay/issues.json  (stratified sample + ground truth)
            │
            ▼
  replay:run     ────►  replay/results/results-<engine>.jsonl   (one line per cell)
            │
            ▼
  replay:score   ────►  ../reports/replay-YYYY-MM-DD.md  (committed)
```

`issues.json`, `fixtures/`, and `results/` are gitignored. The committed
artefact is the report under `../reports/`.

## Quick start

End-to-end smoke run (~5 min, ~$0.30):

```bash
cd .github/bin/js/ai-triage

# 1. Pick 10 issues across 3 domains (sanity sample)
npm run replay:select -- --per-domain 1 --domains checkout,framework,inventory

# 2. Run one engine to keep cost minimal
npm run replay:run -- --engines opencode

# 3. Render report
npm run replay:score
```

Full run (~30 min, ~$8):

```bash
npm run replay:all     # = select && run && score, defaults
```

## Per-script reference

### `replay:select`

Queries `gh` for closed issues with `domain/*` labels in the last 6 months,
stratified evenly across active domains. Excludes security advisories,
bot-authored issues, and `[Test Plan]` titles.

```
Flags:
  --per-domain <N>           default: 10
  --domains <a,b,c>          default: all active domain/* labels on repo
  --since <YYYY-MM-DD>       default: 6 months ago
  --out <path>               default: replay/issues.json
  --repo <owner/name>        default: $AI_TRIAGE_REPO or shopware/shopware
```

Ground truth derivation per issue:
| Field | Source | Caveat |
|---|---|---|
| `domain` | issue's maintainer-set `domain/*` label | hard ground truth |
| `severity_hint` | `priority/{critical,high,low}` label | **directional only** — priority ≠ severity |
| `disposition_hint` | `state_reason` + `kind/*` labels | `not_planned` ambiguous → null |
| `duplicate_of` | timeline `marked_as_duplicate` event | absent for older duplicates |

### `replay:run`

Spawns `triage.ts` once per (engine × issue), re-using the full PII redaction

- Zod validation + secret-scan pipeline. Per-engine output is appended to
  `results-<engine>.jsonl`. Idempotent — already-completed `issue_id`s are
  skipped on resume.

```
Flags:
  --engines <a,b,c>          default: opencode,codex,claude
  --issues <path>            default: replay/issues.json
  --fixtures-dir <path>      default: replay/fixtures
  --results-dir <path>       default: replay/results
  --resume <bool>            default: true
  --timeout-ms <N>           default: 600000 (10 min per cell)
  --concurrency <N>          default: 1 (cells per engine in parallel)
```

Failure modes (each becomes one JSONL line with `status` ≠ `"ok"`):
`spawn-error`, `engine-error`, `timeout`, `parse-error`. None abort the sweep.

Engines run in parallel (one subprocess per engine). Within an engine,
`--concurrency` controls how many cells run at once. Recommended values:

- **claude**: 3–6 (Claude Code subscription rate-limits at ~50 req / 5 min).
- **codex**: 3–6 (OpenAI API quota dependent).
- **opencode**: keep at 1. Concurrent opencode instances share `XDG_DATA_HOME`
  and would race on the SQLite WAL.

Live diagnostics during a sweep: set `AI_TRIAGE_VERBOSE=1` to tee child stderr to your terminal (noisy but useful when debugging a stuck cell).

### `replay:score`

Joins `issues.json` (ground truth) with `results-<engine>.jsonl` (agent
output) per engine, grades each cell on four axes, aggregates into a
markdown report.

```
Flags:
  --issues <path>            default: replay/issues.json
  --results-dir <path>       default: replay/results
  --reports-dir <path>       default: ../reports
  --date <YYYY-MM-DD>        default: today
```

Metrics:

- **Domain match** (hard): expected label ∈ agent's `suggested_labels`.
- **Vocab-violation count**: agent emitted a `domain/*` label that doesn't
  exist on the repo (DOMAINS.md drift). Cannot match any real issue.
- **Disposition match**: agent's disposition vs. derived hint; only scored
  on issues where `state_reason` is unambiguous.
- **Severity match** (directional caveat): agent's severity vs. priority
  hint. Treat as a smell test only — Shopware `priority/*` ≠ technical
  severity per `CLASSIFICATION.md`.
- **Duplicate recall**: when timeline gave us a canonical issue, did the
  agent identify it? Recall only — no negative ground truth.
- **Confidence calibration**: mean confidence on correct vs. wrong cells.
- **Cost + wall**: per-engine totals and per-cell p50/p95.

## Interpreting the report

The go/no-go table at the top of the markdown report applies the four
criteria from `ai-triage-idea.md`:

1. Domain match ≥ 70%
2. Zero false-positive `severity=critical`
3. Cost/issue < $0.10

Each criterion is per-engine. If at least one engine passes all three, the
recommendation paragraph should propose shadow rollout with that engine
(`AI_TRIAGE_OPENCODE_MODEL` already supports swapping the underlying model).

The confusion matrices (collapsed by default) surface common error modes:
mass leakage from one row to another column means the prompt or DOMAINS.md
is conflating two domains.

## Cost

| Engine   | Default model                 | Cost/cell | 30 cells |
| -------- | ----------------------------- | --------- | -------- |
| opencode | `anthropic/claude-sonnet-4-6` | ~$0.05    | ~$1.50   |
| codex    | `gpt-5.5`                     | ~$0.04    | ~$1.20   |
| claude   | `claude-sonnet-4-6`           | ~$0.05    | ~$1.50   |

Total ≈ $4–8 for the default 3-engine × 30-issue run. Pre-flight smoke run
with `--per-domain 1` and one engine ≈ $0.10–0.30.
