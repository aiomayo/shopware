# Shopware AI Tooling — Foundation Overview

> A reusable foundation for AI-assisted maintenance workflows in the Shopware monorepo. **AI Triage** is the first concrete use case; the same pattern is meant to power PR review, ADR review, release-note drafting, and more.

## The idea in 30 seconds

Take a senior-engineer task that is **structured and bounded** (5–10 minutes of investigation, a typed decision at the end), and let an AI agent run it with the same tools a human would use: the codebase via `rg`/`git`, GitHub via `gh`, full reasoning loop. In this first iteration the output is a structured JSON suggestion — write actions (comments, labels, auto-fix PRs) are deliberately deferred to later iterations and will be added under their own approval gates. Humans, scripts, or other workflows decide what to do with the JSON in the meantime.

## What "the foundation" actually is

Four small, composable pieces:

```
   ┌───────────────────────────────────────────────────────────────┐
   │  GitHub Action (manual / scheduled trigger)                    │
   │     │                                                          │
   │     ▼                                                          │
   │  Node TS wrapper (.github/bin/js/<workflow>/triage.ts)         │
   │     │   - validate input                                       │
   │     │   - redact PII                                           │
   │     │   - spawn `codex exec` in repo root                      │
   │     │   - parse + Zod-validate the final JSON                  │
   │     │   - print structured result                              │
   │     ▼                                                          │
   │  Codex CLI agent (gpt-5.5 via ChatGPT Business OAuth)   │
   │     │   - reads `prompts/<task>.md` (the "skill")             │
   │     │   - has full read access to repo + gh                    │
   │     │   - loops through tools (rg, git, gh) until done         │
   │     ▼                                                          │
   │  Structured JSON output (validates against schemas/<task>.json) │
   └───────────────────────────────────────────────────────────────┘
```

Everything else (eval suites, audit logs, comment posting, multi-model review) is built **on top of** this loop, not inside it.

## How AI Triage works today

1. A maintainer opens **Actions → AI Triage → Run workflow** and enters an issue number.
2. The workflow:
   - checks out the repo, installs Codex CLI, restores cached OAuth token
   - calls `gh api repos/.../issues/<N>` to fetch the issue
   - runs a PII redactor over the body (emails, IBANs, API keys, user paths)
   - invokes `codex exec` with the implementer prompt and the issue JSON as input
3. Codex investigates autonomously:
   - `rg` to find affected source files
   - `git log` to spot recent fixes in that area
   - `gh issue list` / `gh pr view` to check for duplicates and existing fix-PRs
4. Codex emits a single JSON object: disposition, severity, suggested labels, confidence, affected paths, related PRs, evidence quotes, change-size estimate.
5. The workflow uploads the JSON as an artifact (14-day retention) and writes a markdown summary to the run page.

**Today this is dry-run only** — the JSON is the deliverable. Comment posting, auto-labeling, and metric dashboards are explicitly deferred until the foundation is reviewed.

## Where it runs

| Environment | Trigger | Use case |
|---|---|---|
| **Local** (`npx tsx triage.ts`) | Manual CLI | Prompt iteration, eval-suite replay, debugging |
| **GitHub Actions** (this workflow) | `workflow_dispatch` (manual) | Real triage on real issues, audit artifact retained |
| **GitHub Actions** (planned) | `schedule` (nightly) | Re-triage `needs-triage` backlog |
| **GitHub Actions** (planned, gated) | `issues.opened` filtered | Auto-triage on new issues, posting opt-in via dry_run=false |

Local and CI use the same code and the same prompt. The only difference is who triggers and where the output goes.

## How to extend to other workflows

Each new AI-assisted task is **a new skill folder + a new workflow**, reusing the same foundation:

```
.github/bin/js/
├── ai-triage/          ← this PoC (triage issues — read-only suggestion)
├── ai-pr-review/       ← future: review PRs against coding-guidelines
├── ai-adr-review/      ← future: review proposed ADRs for conflicts
├── ai-release-notes/   ← future: draft RELEASE_INFO entries from merged PRs
├── ai-reproduce/       ← future: turn issue repro steps into a failing test
├── ai-fix/             ← future: propose a patch / open a draft PR for a triaged bug
└── ai-doc-sync/        ← future: flag stale docs after code changes
```

Each folder contains the same shape: `triage.ts` (or task-specific entry), `prompts/<task>.md`, `schemas/<task>.json`. The shell-wrapper code that handles redaction, Codex spawning, JSON parsing, and Zod validation is candidate for extraction into a shared library once we have ≥ 2 use cases — for now it is duplicated intentionally to keep the PoC reviewable.

**The skill is the prompt + schema.** Adding a new use case means:
1. Write a new prompt in `prompts/<task>.md` (XML structure, role, tools, schema reference, examples).
2. Define the output JSON schema in `schemas/<task>.json` (mirror it in a Zod type in the entry script).
3. Write a thin workflow YAML that calls it.

## From triage to fix — earning write authority step by step

Triage is intentionally the **first** stage, not the only one. The foundation is built so that the same loop can later drive a full Reproduce → Fix → Validate → Review pipeline. What changes between stages is mostly **the prompt, the schema, and the side-effect contract** — not the wrapper, not the runtime, not the tool set.

| Stage | Output | Side-effect | Sandbox / approval |
|---|---|---|---|
| **Triage** *(today)* | JSON suggestion | None — read-only | `workspace-write` (incidental writes discarded), single human triggers via `workflow_dispatch` |
| **Reproduce** *(planned)* | Failing test in a scratch dir | Generates code, but does not commit | `workspace-write` in an ephemeral runner; output is a patch attached to the workflow run |
| **Fix** *(planned)* | Patch / draft PR | Opens a PR with `draft: true` and a clear bot-author marker | `workspace-write` + branch protection on `trunk`; PR requires human review and CI green before merge |
| **Validate** *(planned)* | Test-run report | Comments verification status on the linked PR | `workspace-write` + CI integration; comments are gated on dry-run/preview tokens initially |
| **Review** *(planned)* | Cross-model review comment | Posts an LLM-as-reviewer comment on PRs | `workspace-write`, but bot identity + opt-in label on the PR |

Each step expands write authority by one notch and earns the right to do so via the previous step's evidence. The triage iteration is the rehearsal for that progression: if we can trust the agent's structured output on a closed bug, we can start trusting it for `gh pr create --draft` on a confirmed defect. If we can't, we know what to improve before we hand it a checkbook.

Practical implications:

- The Codex sandbox mode (`workspace-write` with network) is already the right mode for code edits — we just do not yet emit any writes.
- The same `prompts/` + `schemas/` shape works for "produce a diff" as it does for "produce a triage decision". The schema simply changes from a typed classification to a typed patch description.
- Branch-protection, `CODEOWNERS`, and required reviews are the **same gates a human contributor goes through**. We do not invent a new approval model for the agent — we plug it into the existing one and start it on the lowest-risk slot (draft PR with bot author).
- Cross-model review (Anthropic Claude as second pair of eyes) becomes critical when write actions enter the loop. The same pipeline can route a draft Fix-PR back through a Reviewer skill before the agent flags it ready for human review.

## Why this approach

- **Codex CLI brings the tools.** `rg`, `git`, `gh`, and the shell are already wired into a sandbox runtime. No MCP servers, no custom tool wrappers, no orchestration framework to maintain. The agent loops natively.
- **The repo is the source of truth.** Prompts, schemas, and project-local agent rules (`AGENTS.md`) live in the repo. Changes go through PR review. No external config drift.
- **Structured output is enforceable.** The JSON schema is shared between the prompt (instructs the model), the agent (constrains the answer), and the workflow (Zod-validates before downstream use). One source of truth, three consumers.
- **Read-only in this iteration.** The first stage writes nothing on purpose — we validate the foundation against real issues before granting any write authority. Later stages (comment posting, label suggestions, auto-fix PRs, full-pipeline runs) are explicitly on the roadmap and will earn write authority progressively through gated approval mechanisms (dry-run defaults, human-in-the-loop on high-impact actions, multi-model review where applicable).
- **Switchable.** Codex CLI is just one runtime. The same prompt and schema can drive `opencode`, Claude Code, or a direct Anthropic SDK call — the wrapper script is the only thing that changes.
- **Auditable.** Every run leaves a JSON artifact and a workflow log. We can replay any decision later and trace what tools the agent used.

## Limits and trade-offs

- **OAuth token logistics.** Codex authenticates via ChatGPT Business OAuth, and refresh tokens are single-use. Parallel workflow runs would race and invalidate the token — the workflow therefore serializes all triage runs through one concurrency group. Tokens must be cached across runs (handled), and rotated periodically when the cache key changes.
- **Confidence ≠ correctness.** The model is calibrated (a `0.95` is meaningfully higher than a `0.7`), but it is not infallible. The output is a suggestion. The downstream consumer is responsible for trusting it appropriately.
- **No autonomous writes in this iteration.** The current stage is structured-output-only by design — we want to evaluate the agent's judgement against real issues before opening up write actions. Write authority (comments, labels, auto-fix PRs) will be introduced step by step in later iterations, each guarded by the appropriate approval mechanism for its blast radius.
- **Cost is opaque inside the OAuth window.** ChatGPT Business OAuth does not expose per-call token cost. Once we move to API keys (post-PoC), we will surface this in the audit JSON.
- **Sandbox network access.** The agent runs with `workspace-write` sandbox + network access enabled (required for `gh`). The prompt forbids writes; any accidental write lands in the ephemeral runner and is discarded. We do not run this against production data.
- **The model can be wrong about severity.** Severity reflects **technical impact**, not business priority. Shopware uses separate `priority/*` labels for urgency. The agent's `severity` field is one input among many for human triage.
- **Prompt drift.** Prompts are versioned via Git but not via formal release. Changes go through normal PR review. Eval suites against ground-truth issues are the planned mitigation — they exist conceptually in the plan but are not yet built.

## What's next (planned, in order)

Each step here unlocks the next — we only proceed if the previous one is stable.

1. **Run on a feature branch**, validate against real issues with the team.
2. **Cross-model review pass** — a second agent (different model family) reviews the implementer's output to reduce same-mind bias.
3. **Eval suite** — 15–30 closed issues with ground-truth dispositions, used for regression testing prompt changes.
4. **Comment posting (opt-in)** — when dry_run=false, the agent's reasoning is rendered as a markdown comment on the issue. First write action.
5. **Per-stage audit JSONL** — structured run logs for trend analysis and compliance.
6. **Second use case (still read-only)** — PR review or ADR review, sharing the wrapper code, proves the foundation generalizes.
7. **Reproduce stage** — agent generates a failing test from issue repro steps; output is a patch attached to the workflow run (no commit).
8. **Fix stage (draft PR)** — agent proposes a code change as a draft PR with a bot-author marker. Requires human review and CI green before merge, exactly like any contributor.
9. **Validate + Review stages** — close the loop with automated cross-model review on the agent's own PRs before flagging them ready for human attention.

## For reviewers

When reviewing this PR, the questions worth asking are:

- **Does the prompt match the rubric you would apply?** Skim `prompts/implementer.md` — the disposition taxonomy, severity rubric, and domain catalogue are the "policy" of this agent. They should reflect Shopware conventions.
- **Are the tools the right ones?** `rg`, `git`, `gh` — anything missing? Anything you would explicitly forbid?
- **Is the output schema useful for what comes after?** If you want to consume this JSON downstream (dashboards, comment-bots, etc.), is the field set rich enough?
- **Are the safety limits sufficient for *this* stage?** Read-only intent, dry-run default, single-flight concurrency. Later stages (comment posting, draft PRs, auto-fix) will each come with their own gates; what should this triage stage already enforce so the gates that follow are easier to add?

This PoC is intentionally small. The point of merging it now is to validate the foundation against real issues with the wider team in the loop — not to build the full vision in one PR. The plan is to grow this from triage into a multi-stage assistant (review, reproduce, fix, validate) one earned step at a time.
