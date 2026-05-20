# Shopware AI Tooling — Foundation Overview

> A reusable foundation for AI-assisted maintenance workflows in the Shopware monorepo. **AI Triage** is the first concrete use case; the same pattern is meant to power PR review, ADR review, release-note drafting, and more.

## The idea in 30 seconds

Take a senior-engineer task that is **structured and bounded** (5–10 minutes of investigation, a typed decision at the end), and let an AI agent run it with the same tools a human would use: the codebase via `rg`/`git`, GitHub via `gh`, full reasoning loop. In this first iteration the output is a structured JSON suggestion — write actions (comments, labels, auto-fix PRs) are deliberately deferred to later iterations and will be added under their own approval gates. Humans, scripts, or other workflows decide what to do with the JSON in the meantime.

## What "the foundation" actually is

Four small, composable pieces:

```
   ┌───────────────────────────────────────────────────────────────┐
   │  GitHub Action (manual / scheduled trigger)                   │
   │     │                                                         │
   │     ▼                                                         │
   │  Node TS wrapper (.github/bin/js/<workflow>/triage.ts)        │
   │     │   - validate input                                      │
   │     │   - redact PII                                          │
   │     │   - spawn the selected agentic CLI in repo root         │
   │     │     (opencode | codex | claude — chosen via env)        │
   │     │   - parse + Zod-validate the final JSON                 │
   │     │   - print structured result                             │
   │     ▼                                                         │
   │  Agent runtime (default: opencode + anthropic/claude-sonnet-4-6│
   │  via ANTHROPIC_API_KEY; swappable to Codex CLI or Claude Code) │
   │     │   - reads `.claude/skills/<task>/SKILL.md` (the "skill") │
   │     │   - has full read access to repo + gh                   │
   │     │   - loops through tools (rg, git, gh) until done        │
   │     ▼                                                         │
   │  Structured JSON output (validates against schemas/<task>.json)│
   └───────────────────────────────────────────────────────────────┘
```

Everything else (eval suites, audit logs, comment posting, multi-model review) is built **on top of** this loop, not inside it.

## How AI Triage works today

1. A maintainer opens **Actions → AI Triage → Run workflow**, enters an issue number, and (optionally) picks an engine (`opencode` / `codex` / `claude`).
2. The workflow:
   - checks out the repo, installs the selected agent runtime, checks the matching provider key is present
   - calls `gh api repos/.../issues/<N>` to fetch the issue
   - runs a PII redactor over the body (emails, IBANs, API keys, user paths)
   - invokes the selected agent with the implementer prompt and the issue JSON as input
3. The agent investigates autonomously:
   - `rg` to find affected source files
   - `git log` to spot recent fixes in that area
   - `gh issue list` / `gh pr view` to check for duplicates and existing fix-PRs
4. The agent emits a single JSON object: disposition, severity, suggested labels, confidence, affected paths, related PRs, evidence quotes, change-size estimate.
5. The workflow uploads the JSON as an artifact (14-day retention) and writes a markdown summary to the run page.

**Today this is dry-run only** — the JSON is the deliverable. Comment posting, auto-labeling, and metric dashboards are explicitly deferred until the foundation is reviewed.

## Where it runs

| Environment | Trigger | Use case |
|---|---|---|
| **Local** (`npm run triage`) | Manual CLI | Prompt iteration, eval-suite replay, debugging |
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

Each task has two pieces in two locations:
- **The skill** at `<repo-root>/.claude/skills/<task>/SKILL.md` (+ optional `references/`, `assets/`) — Agent Skills format, portable across Claude Code, opencode, Codex CLI, etc. Auto-loads in interactive runtimes when its `description` matches the user message.
- **The wrapper** at `.github/bin/js/<task>-wrapper/` — a `triage.ts`-equivalent entry script, `skill/{input,output,prompt}.ts` adapters, optional engine-specific glue.

Engine-spawn code (`runOpencode`, `runCodex`, `runClaude`, `spawnAndWait`, env handling) is task-agnostic and ready for extraction into a shared `lib/` once a second task lands. PII patterns and the prompt-assembly helpers are already in their own modules (`pii-patterns.ts`, `skill/prompt.ts`).

**The skill is the prompt + schema.** Adding a new use case means:
1. Write a new skill at `<repo-root>/.claude/skills/<task>/SKILL.md` with Agent Skills frontmatter (`name`, `description`) plus optional `references/`, `assets/`.
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
- The same `.claude/skills/<task>/` + `schemas/<task>.json` shape works for "produce a diff" as it does for "produce a triage decision". The schema simply changes from a typed classification to a typed patch description.
- Branch-protection, `CODEOWNERS`, and required reviews are the **same gates a human contributor goes through**. We do not invent a new approval model for the agent — we plug it into the existing one and start it on the lowest-risk slot (draft PR with bot author).
- Cross-model review (Anthropic Claude as second pair of eyes) becomes critical when write actions enter the loop. The same pipeline can route a draft Fix-PR back through a Reviewer skill before the agent flags it ready for human review.

## Why this approach

- **The agent CLIs bring the tools.** `rg`, `git`, `gh`, and the shell are already wired into the runtime of every supported agent (opencode, codex, claude). No MCP servers, no custom tool wrappers, no orchestration framework to maintain. The agent loops natively.
- **Provider-agnostic from day one.** The wrapper exposes an `AI_TRIAGE_ENGINE` switch (`opencode` | `codex` | `claude`). CI currently defaults to opencode + `anthropic/claude-sonnet-4-6` via `ANTHROPIC_API_KEY` (Sonnet 4.6 won the local eval at 0.97 confidence); the default flips to `openai/gpt-5.5` once an OpenAI key is provisioned by setting the `AI_TRIAGE_OPENCODE_MODEL` repo variable. Developers can run the same prompt locally with whichever CLI they already have logged in.
- **The repo is the source of truth.** Prompts, schemas, and project-local agent rules (`AGENTS.md`) live in the repo. Changes go through PR review. No external config drift.
- **Structured output is enforceable.** The JSON schema is shared between the prompt (instructs the model), the agent (constrains the answer), and the workflow (Zod-validates before downstream use). One source of truth, three consumers.
- **Read-only in this iteration.** The first stage writes nothing on purpose — we validate the foundation against real issues before granting any write authority. Later stages (comment posting, label suggestions, auto-fix PRs, full-pipeline runs) are explicitly on the roadmap and will earn write authority progressively through gated approval mechanisms (dry-run defaults, human-in-the-loop on high-impact actions, multi-model review where applicable).
- **Auditable.** Every run leaves a JSON artifact and a workflow log. We can replay any decision later and trace which engine, which model, and which tools the agent used.

## Limits and trade-offs

- **Provider keys are now first-class secrets.** `OPENAI_API_KEY` (for opencode/codex engines) and optionally `ANTHROPIC_API_KEY` (for the claude engine) live as repository secrets. They are stateless — no OAuth refresh race, no concurrency group needed, and parallel triage runs are safe.
- **Confidence ≠ correctness.** The model is calibrated (a `0.95` is meaningfully higher than a `0.7`), but it is not infallible. The output is a suggestion. The downstream consumer is responsible for trusting it appropriately.
- **No autonomous writes in this iteration.** The current stage is structured-output-only by design — we want to evaluate the agent's judgement against real issues before opening up write actions. Write authority (comments, labels, auto-fix PRs) will be introduced step by step in later iterations, each guarded by the appropriate approval mechanism for its blast radius.
- **Cost surfacing.** Both opencode and Codex CLI emit token usage in stderr; we currently do not parse it into the audit JSON. Adding `cost_usd_estimate` to the schema is on the planned-features list once we settle on a reporting model.
- **Sandbox.** opencode and Codex CLI run with full network access (required for `gh`). Codex additionally enforces an OS-level Seatbelt/Landlock sandbox; opencode does not — for this read-only stage the ephemeral GitHub Actions runner is the isolation boundary. The prompt forbids writes; any accidental write lands in the runner and is discarded. We do not run this against production data.
- **Tool-permission posture differs per engine.** Claude Code runs with a narrow allow-list (`Bash(rg:*),Bash(git:*),Bash(gh:*),Bash(find:*),Bash(head:*),Bash(tail:*),Read,Glob,Grep`). Codex CLI's `workspace-write` sandbox enforces file-write boundaries at OS level. **opencode runs with `--dangerously-skip-permissions`** — there is no per-tool allow-list in the opencode CLI. The defense lies one layer up: `step-security/harden-runner` blocks outbound HTTPS to anything outside the providers + GitHub + agent CLI registries; the ephemeral runner is the isolation boundary. When we move beyond read-only stages, this will need a stronger per-engine restriction.
- **The model can be wrong about severity.** Severity reflects **technical impact**, not business priority. Shopware uses separate `priority/*` labels for urgency. The agent's `severity` field is one input among many for human triage.
- **Prompt portability is not 100%.** Anthropic models prefer XML-structured prompts; OpenAI models prefer Markdown + JSON Schema. We use XML with structured sections, which both accept. Some engine-specific drift is expected when running cross-engine eval; the planned eval suite will quantify it.
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

- **Does the skill match the rubric you would apply?** Skim `.claude/skills/triage/SKILL.md` and its `references/CLASSIFICATION.md` + `references/DOMAINS.md` — the disposition taxonomy, severity rubric, and domain catalogue are the "policy" of this agent. They should reflect Shopware conventions.
- **Are the tools the right ones?** `rg`, `git`, `gh` — anything missing? Anything you would explicitly forbid?
- **Is the output schema useful for what comes after?** If you want to consume this JSON downstream (dashboards, comment-bots, etc.), is the field set rich enough?
- **Are the safety limits sufficient for *this* stage?** Read-only intent, dry-run default, single-flight concurrency. Later stages (comment posting, draft PRs, auto-fix) will each come with their own gates; what should this triage stage already enforce so the gates that follow are easier to add?

This PoC is intentionally small. The point of merging it now is to validate the foundation against real issues with the wider team in the loop — not to build the full vision in one PR. The plan is to grow this from triage into a multi-stage assistant (review, reproduce, fix, validate) one earned step at a time.
