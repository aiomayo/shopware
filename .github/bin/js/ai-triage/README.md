# AI Triage Agent — Shopware AI Tooling

> **For the conceptual approach, the extensibility model (PR review, ADR review, release notes), and the trade-offs, read [`OVERVIEW.md`](./OVERVIEW.md) first.** This README focuses on operating the tool.

Agentic GitHub-issue triage for Shopware 6. Runs an agentic CLI (default: **opencode** with `anthropic/claude-sonnet-4-6`; swappable to **codex** or **claude**) with full shell + GitHub-API access (read-only intent). For each input issue, the agent:

1. Identifies the affected code area via `rg` and `find`
2. Checks recent commits in that area via `git log`
3. Searches for related issues and fix-PRs via `gh`
4. Emits a structured JSON triage decision (disposition, severity, suggested domain labels, evidence, affected paths, related PRs, confidence)

The output is **read-only**: the agent does not post comments, label, or modify state. Consumers can use the JSON to drive comment-posting, dashboards, or human review queues.

## Layout

**Two layers, clearly separated:**

```
<repo-root>/.claude/skills/triage/          ← THE SKILL — portable across all Agent Skills runtimes
├── SKILL.md                                auto-loaded by Claude Code, opencode, Codex CLI, ...
├── references/                             on-demand loaded by the agent
│   ├── TOOLS.md                            shell-tool catalogue + anti-patterns + PII hygiene
│   ├── CLASSIFICATION.md                   disposition + severity + confidence
│   ├── DOMAINS.md                          Shopware domain label catalogue
│   └── SCHEMA.md                           output schema field rules
└── assets/examples.md                      three worked example outputs

.github/bin/js/ai-triage/                   ← THE WRAPPER — execution / orchestration
├── package.json                            npm deps (zod + agent CLIs pinned as devDeps)
├── tsconfig.json                           strict TS, ESM, Node LTS
├── AGENTS.md                               project-local rules (sandbox, output discipline)
├── README.md                               this file
├── triage.ts                               main entry: fetch + redact + spawn engine + validate
├── generate-schema.ts                      regenerates schemas/*.json from Zod
├── redact-stream.ts                        post-run output redactor (used by CI)
├── pii-patterns.ts                         shared PII regex patterns (input + output redaction)
├── skill/
│   ├── input.ts                            RawIssue, template-fields, language, prompt assembly
│   └── output.ts                           TriageOutput (Zod) + parseJsonFromText
├── triage.test.ts                          unit tests (34 tests, run via `npm test`)
└── schemas/
    └── triage-output.schema.json           JSON Schema (generated from Zod via z.toJSONSchema)
```

**The skill is portable**: any AI runtime that reads Agent Skills (Claude Code, opencode, Codex CLI, Cursor, Gemini CLI, etc.) auto-loads `SKILL.md` when the user mentions triaging an issue. The wrapper is for CI and automated pipelines.

## Engine matrix

| Engine | Default model | Provider(s) | Auth options |
|---|---|---|---|
| `opencode` (default in CI) | `anthropic/claude-sonnet-4-6` | OpenAI **or** Anthropic — pick via `AI_TRIAGE_OPENCODE_MODEL` | `ANTHROPIC_API_KEY` (current) or `OPENAI_API_KEY` (matches the model prefix) |
| `codex` | `gpt-5.5` | OpenAI only | `OPENAI_API_KEY` *or* `~/.codex/auth.json` (OAuth) |
| `claude` | `claude-sonnet-4-6` | Anthropic only | `ANTHROPIC_API_KEY` *or* Claude Code subscription OAuth (`claude login`) |

All three engines are pinned as `devDependencies` in `package.json` and installed via `npm ci`. No global install is required — the workflow and local dev use the binaries from `./node_modules/.bin/`.

The same skill (`.claude/skills/triage/SKILL.md`) and JSON schema (`schemas/triage-output.schema.json`) drive all three. Switching engine is one env var.

**Local interactive use — your AI loads the skill automatically:**

```bash
# In any Claude Code session in the sw1 repo:
> triage issue #16599

# Same with opencode (reads .claude/skills/ natively):
opencode
> triage issue #16599

# Same with Codex CLI (since Dec 2025):
codex
> triage issue #16599
```

No env vars, no wrapper invocation. The skill's `description` triggers auto-load when you mention "triage". The wrapper path is for CI + automated runs.

**opencode + Anthropic** — opencode is multi-provider. To use a Claude model through opencode (instead of the separate `claude` engine), set:
```bash
export AI_TRIAGE_OPENCODE_MODEL=anthropic/claude-sonnet-4-6
export ANTHROPIC_API_KEY=sk-ant-...
AI_TRIAGE_ENGINE=opencode npm run triage -- --issue-number 16599
```
The model string must always be `provider/name` for opencode; the wrapper validates this on startup.

**Local dev with Claude Code subscription** — if you already use a Claude.ai Pro/Max subscription via Claude Code (`claude login`), you can run the triage agent against your subscription without an API key:
```bash
# Once: log in to Claude Code with your Claude.ai account
claude login

# Then run triage with engine=claude — no ANTHROPIC_API_KEY needed
AI_TRIAGE_ENGINE=claude npm run triage -- --issue-number 16599
```
The wrapper passes `ANTHROPIC_API_KEY` through if set, otherwise Claude Code falls back to OAuth credentials in `~/.claude/`. This path is **local-only**: CI always uses the secret-based API key (`QUALITY_INITIATIVE_ANTHROPIC_API_KEY`).

> Note: with subscription OAuth, the `--max-budget-usd` cap is a no-op (the subscription is a flat fee). Use `AI_TRIAGE_TIMEOUT_MS` to bound wall-clock instead.

## Local usage

Requires Node 22 LTS or newer (TypeScript runs directly via `node script.ts` since Node 22.6 — no transpiler needed), `gh` CLI authenticated.

```bash
cd .github/bin/js/ai-triage
npm ci          # installs zod + all three agent CLIs as devDependencies

# Authenticate against the provider you want to use:
export OPENAI_API_KEY=sk-...       # for opencode (OpenAI model) or codex
export ANTHROPIC_API_KEY=sk-ant-... # for opencode (Anthropic model) or claude
# — OR — use your Claude Code subscription for the claude engine:
claude login

# Default = opencode + Anthropic Claude Sonnet 4.6
npm run triage -- --issue-number 16599

# Cross-engine eval — same issue through Claude (API key OR subscription)
AI_TRIAGE_ENGINE=claude npm run triage -- --issue-number 16599

# Iterate locally with Codex CLI (uses your existing ChatGPT OAuth or OPENAI_API_KEY)
AI_TRIAGE_ENGINE=codex npm run triage -- --issue-number 16599

# Local replay from a JSON fixture (for batch eval / regression)
echo '{"issue_id":16599,"title":"...","body":"...","labels":[]}' > issue.json
npm run triage -- --issue issue.json

# Verbose logging (streams agent stdout/stderr)
AI_TRIAGE_VERBOSE=1 npm run triage -- --issue-number 16599

# Different repo
AI_TRIAGE_REPO=shopware/frontends npm run triage -- --issue-number 42
```

Output goes to stdout as a single JSON object. A one-line summary (incl. engine + wall-clock) is printed to stderr.

## Workflow setup (GitHub Actions)

The workflow `.github/workflows/ai-triage.yml` exposes the agent via `workflow_dispatch` with an `engine` choice input (default `opencode`).

1. **Provision provider keys as repository secrets** using the `QUALITY_INITIATIVE_` prefix so the namespace is visible at the Settings → Secrets level and the keys aren't repurposed for other workflows:
   - `QUALITY_INITIATIVE_OPENAI_API_KEY` — required for `opencode` (with OpenAI model) and `codex` engines
   - `QUALITY_INITIATIVE_ANTHROPIC_API_KEY` — required for `claude` engine and `opencode` (with Anthropic model)
   ```bash
   gh secret set QUALITY_INITIATIVE_OPENAI_API_KEY --repo shopware/shopware
   gh secret set QUALITY_INITIATIVE_ANTHROPIC_API_KEY --repo shopware/shopware
   ```
   Set them as *environment* secrets if you want a reviewer-approval gate.

2. **(Optional) Override the default opencode model via repo variable** — the workflow defaults to `anthropic/claude-sonnet-4-6` (best triage quality in current local eval). Override only if needed:
   ```bash
   gh variable set AI_TRIAGE_OPENCODE_MODEL --body "openai/gpt-5.5" --repo shopware/shopware
   ```

3. **Trigger** the workflow:
   ```bash
   gh workflow run ai-triage.yml \
     --repo shopware/shopware \
     --ref <branch-name> \
     -f issue_number=16599 \
     -f engine=opencode \
     -f dry_run=true
   ```

4. **Download the result** once the run completes:
   ```bash
   gh run download <run-id> --repo shopware/shopware \
     --name ai-triage-16599-opencode-<run-id>
   cat triage-result.json | jq '.triage'
   ```

### Why opencode in CI

The previous CI used Codex CLI with ChatGPT-Business OAuth. The OAuth refresh tokens are **single-use** — every refresh invalidates the previous one — which forced a workflow-wide concurrency group (one triage at a time across all issues) and a cache/bootstrap dance for `~/.codex/auth.json`. It also tied CI to one personal ChatGPT account (Bus-Factor-1).

opencode + API key is **stateless**: parallel triage runs are safe, no cache, no bootstrap, no OAuth race. It's also multi-provider — the same engine drives both OpenAI and Anthropic models. The wrapper validates output with Zod regardless of engine; for codex and claude, the engine *also* enforces the JSON schema at the CLI level (`--output-schema` / `--json-schema`), giving belt-and-braces validation. opencode does not have engine-side schema enforcement, which the Zod-validation step handles.

### Sandbox notes

opencode and Codex CLI run the agent in an ephemeral GitHub Actions runner with full network access (required for `gh` lookups). The triage prompt explicitly forbids file writes; any incidental write lands in the runner workspace and is discarded with the runner. Codex CLI additionally enforces an OS-level Seatbelt/Landlock sandbox; opencode does not. For this read-only stage the runner isolation is sufficient.

## Output schema

The output JSON validates against `schemas/triage-output.schema.json` and the Zod schema in `triage.ts:TriageOutput`. Both are kept in sync manually for now — when refactoring, regenerate one from the other (or add a build step).

Key fields:

| Field | Type | Meaning |
|---|---|---|
| `disposition` | enum | `valid-bug`, `duplicate`, `needs-info`, `not-a-bug`, `feature-request` |
| `severity` | enum | `low`, `medium`, `high`, `critical` (technical impact, not business priority) |
| `suggested_labels` | string[] | 1–2 `domain/*` labels from the catalogue |
| `confidence` | number | 0.0–1.0, calibrated per rubric in `.claude/skills/triage/references/CLASSIFICATION.md` |
| `reasoning` | string | 2–5 sentences referencing concrete paths, commits, PRs |
| `evidence_quotes` | string[] | 1–5 verbatim spans from input or shell output |
| `affected_paths` | string[] | files identified via `rg`/`find` |
| `related_prs` | int[] | PRs that touch the same area |
| `recent_commits_in_area` | string[] | short `git log --oneline` entries |
| `change_size_estimate` | enum | `quick-fix`, `small`, `medium`, `large`, `unknown` |

The wrapper additionally records `engine` in the top-level result, so cross-engine eval runs are traceable.

## Naming / conventions

- ENV vars use `AI_TRIAGE_*` prefix
- Conventional Commits scope: `feat(ci): ai-triage ...` for changes to this folder

## What this PoC does NOT do (yet)

- No reviewer pass (single-model triage; cross-model review is planned for a later stage)
- No comment posting (output is JSON only; consumers decide what to do with it)
- No persistent audit log beyond the per-run workflow artifact (14-day retention)
- No automatic trigger on `issues.opened` (manual `workflow_dispatch` only — by design for the first iteration)
- No eval-suite runner against ground-truth fixtures
