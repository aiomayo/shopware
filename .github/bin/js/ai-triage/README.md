# AI Triage Agent — Shopware AI Tooling

> **For the conceptual approach, the extensibility model (PR review, ADR review, release notes), and the trade-offs, read [`OVERVIEW.md`](./OVERVIEW.md) first.** This README focuses on operating the tool.

Agentic GitHub-issue triage for Shopware 6. Runs `gpt-5.5` via the OpenAI Codex CLI with full shell + GitHub-API access (read-only intent). For each input issue, the agent:

1. Identifies the affected code area via `rg` and `find`
2. Checks recent commits in that area via `git log`
3. Searches for related issues and fix-PRs via `gh`
4. Emits a structured JSON triage decision (disposition, severity, suggested domain labels, evidence, affected paths, related PRs, confidence)

The output is **read-only**: the agent does not post comments, label, or modify state. Consumers can use the JSON to drive comment-posting, dashboards, or human review queues.

## Layout

```
.github/bin/js/ai-triage/
├── package.json                            npm deps (zod, tsx)
├── tsconfig.json                           strict TS, ESM, Node 22
├── AGENTS.md                               project-local rules for agents
├── README.md                               this file
├── triage.ts                               main entry — fetch, redact, run codex, validate
├── prompts/
│   └── implementer.md                      structured implementer-pass prompt (XML format)
└── schemas/
    └── triage-output.schema.json           JSON Schema for the output (mirror of Zod schema in triage.ts)
```

## Local usage

Requires Node 22+, `gh` CLI authenticated, and Codex CLI v0.130+ logged in via ChatGPT Business OAuth (`codex login status`).

```bash
cd .github/bin/js/ai-triage
npm install

# Live fetch (recommended for one-off runs):
npx tsx triage.ts --issue-number 16599

# Local replay from a JSON fixture (for batch eval / regression):
echo '{"issue_id":16599,"title":"...","body":"...","labels":[]}' > issue.json
npx tsx triage.ts --issue issue.json

# Verbose logging:
AI_TRIAGE_VERBOSE=1 npx tsx triage.ts --issue-number 16599

# Different repo:
AI_TRIAGE_REPO=shopware/frontends npx tsx triage.ts --issue-number 42
```

Output goes to stdout as a single JSON object. A one-line summary is printed to stderr.

## Workflow setup (GitHub Actions)

The workflow `.github/workflows/ai-triage.yml` exposes the agent via `workflow_dispatch`. To enable it:

1. **Generate a Codex OAuth token locally** by running `codex login` on a trusted machine. This writes `~/.codex/auth.json`.
2. **Add the file contents as a repository secret** named `CODEX_AUTH_JSON`:
   ```bash
   gh secret set CODEX_AUTH_JSON --body "$(cat ~/.codex/auth.json)" --repo shopware/shopware
   ```
   Set it as an *environment* secret if you want a reviewer-approval gate for triage runs.
3. **Trigger** the workflow:
   ```bash
   gh workflow run ai-triage.yml \
     --repo shopware/shopware \
     --ref <branch-name> \
     -f issue_number=16599 \
     -f dry_run=true
   ```
4. **Download the result** once the run completes:
   ```bash
   gh run download <run-id> --repo shopware/shopware --name ai-triage-16599-<run-id>
   cat triage-result.json | jq '.triage'
   ```

### Codex OAuth specifics

The OAuth refresh tokens in `~/.codex/auth.json` are **single-use** — every refresh invalidates the previous one. Parallel workflow runs would race and destroy the token. The workflow therefore:

- Uses a workflow-wide concurrency group `ai-triage-codex-auth` (`cancel-in-progress: false`) so triage runs serialize across all issues.
- Caches `~/.codex/auth.json` between runs with key `codex-auth-${runner.os}-v1` so refreshed tokens persist.
- Bootstraps from the `CODEX_AUTH_JSON` secret only on cache miss (`if [ ! -s ~/.codex/auth.json ]`), so cached refreshed tokens are not overwritten by the stale secret.

If the cache key changes (e.g. workflow file moves), the bootstrap path runs again and the secret is consumed once — refresh it locally and update the secret if `codex login status` reports stale credentials.

### Sandbox notes

The agent runs Codex with `--sandbox workspace-write` + `sandbox_workspace_write.network_access=true`. Workspace-write is required to enable `gh` network calls. The prompt explicitly forbids file writes; any incidental write lands in the ephemeral runner workspace and is discarded with the runner.

## Output schema

The output JSON validates against `schemas/triage-output.schema.json` and the Zod schema in `triage.ts:TriageOutput`. Both are kept in sync manually for now — when refactoring, regenerate one from the other (or add a build step).

Key fields:

| Field | Type | Meaning |
|---|---|---|
| `disposition` | enum | `valid-bug`, `duplicate`, `needs-info`, `not-a-bug`, `feature-request` |
| `severity` | enum | `low`, `medium`, `high`, `critical` (technical impact, not business priority) |
| `suggested_labels` | string[] | 1–2 `domain/*` labels from the catalogue |
| `confidence` | number | 0.0–1.0, calibrated per rubric in `prompts/implementer.md` |
| `reasoning` | string | 2–5 sentences referencing concrete paths, commits, PRs |
| `evidence_quotes` | string[] | 1–5 verbatim spans from input or shell output |
| `affected_paths` | string[] | files identified via `rg`/`find` |
| `related_prs` | int[] | PRs that touch the same area |
| `recent_commits_in_area` | string[] | short `git log --oneline` entries |
| `change_size_estimate` | enum | `quick-fix`, `small`, `medium`, `large`, `unknown` |

## Naming / conventions

- ENV vars use `AI_TRIAGE_*` prefix
- Conventional Commits scope: `feat(ci): ai-triage ...` for changes to this folder

## What this PoC does NOT do (yet)

- No reviewer pass (single-model triage; cross-model review is planned for a later stage)
- No comment posting (output is JSON only; consumers decide what to do with it)
- No persistent audit log beyond the per-run workflow artifact (14-day retention)
- No automatic trigger on `issues.opened` (manual `workflow_dispatch` only — by design for the first iteration)
- No eval-suite runner against ground-truth fixtures
