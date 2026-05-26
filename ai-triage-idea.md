Idea: AI Issue Triage for
shopware/shopware
TL;DR
We extend the Claude Code Action already deployed in our repo (currently used only for @claude
mentions) to perform automatic issue triage: on every new issue, an agent classifies domain +
priority, looks for duplicates, and posts a short suggestion comment. When unsure, needs-triage
stays — humans decide. Effort: ~1 day to a wall demo, ~$0.05/issue, fully versioned in the repo,
instantly reversible.
Problem
Issue triage costs maintainer time on mechanical steps: "which domain?", "how urgent?", "is this
a duplicate?"
These steps are pattern-recognizable — perfect LLM use case
The actual bug-fix decision should still be a human's
Solution at a glance
New issue → Claude Code Action → Slash command /triage-shopware
│
├─ reads the issue
├─ classifies domain (against our 11 domain/* label
├─ estimates priority (high/low — never critical au
├─ searches similar open/closed issues
└─ → set labels + post suggestion comment
When unsure → needs-triage remains + comment with best-guess + "a maintainer will review".
Where does the agent run?
In a fresh GitHub Actions runner VM, spawned per issue — ephemeral, max 8 minutes,
destroyed afterwards
Sandboxed: only contents: read + issues: write , no code push, no PR write
Restricted toolset: agent can only call two specific helper scripts ( gh.sh for read-only GitHub
ops, edit-issue-labels.sh for validated label edits) — no free shell, no curl , no network to
arbitrary URLs
Hard cap: max 2 label operations per run via CLAUDE_CODE_SCRIPT_CAPS
No persistent state between runs
Why this approach
Already deployed: CLAUDE_CODE_OAUTH_TOKEN and claude.yml exist — we build on top, no
new tooling
Anthropic dogfoods this exact pattern in the anthropics/claude-code repo for the same use
case — battle-tested
Custom prompt in markdown at .claude/commands/triage-shopware.md — freely editable,
reviewable per PR like any other code
Helper scripts are 1:1 reusable from Anthropic (label validation, gh wrapper)
Slash command is dual-use: fires automatically and maintainers can invoke
@claude /triage-shopware manually
Compared alternatives: GitHub Models API (too single-step), gh-aw (Tech Preview, extra build
step)
Architecture (4 files)
File Purpose Size
.github/workflows/triage.yml
Trigger issues.opened , calls the
action
~30
lines
.claude/commands/triage-shopware.md Custom prompt with domain logic
~80
lines
.claude/scripts/gh.sh
Read-only gh wrapper (copied from
Anthropic)
~50
lines
File Purpose Size
.claude/scripts/edit-issue-labels.sh Label validator (copied from Anthropic)
~70
lines
Safety guardrails
priority/critical is hard-blocked — agent can never set Critical, only humans can
Label allowlist — only our domain/* + priority/high|low + needs-triage
Script cap ( CLAUDE_CODE_SCRIPT_CAPS ) — max 2 label calls per run
allowed_non_write_users: "*" — required for public OSS (otherwise no triage of external
issues)
Issue body is never interpolated directly into the prompt — Claude reads it via the gh.sh
tool (anti prompt-injection)
Security reports never get a public classification — on suspicion, only needs-triage +
reference to disclosure process
Iteration plan
Phase Scope Effort
V0 Domain classification only, 10 test issues, throwaway fork 3-4 h
V1 + Priority ( priority/critical hard-blocked) + 30-issue eval 1 day
V2 + Duplicate search via gh search issues 2 days
V3+ Correction loop (maintainer corrections as few-shot) optional
Cost & risk
Cost: ~ 0.02 if downgraded to Haiku 4.5. At 200 issues/month = $4-
10/month
Reversible: delete the workflow file → done. No state, no migration
Worst-case damage: wrong label, fixable by a maintainer in 5 seconds
Privacy: Anthropic is already active in the repo ( @claude bot), no new data pipeline
0.05/issueonSonnet4.6,
Success criteria
Domain accuracy ≥ 70 % on 30 test issues
Cohen's κ agent-vs-maintainer-consensus ≥ 0.4
0 false priority/critical auto-sets (guaranteed by hard-block)
Maintainer feedback "comments are helpful, not annoying"
Proposed next steps
1. Discuss this idea briefly with the team — concerns? Who takes the maintainer role for eval
   labeling?
2. Create throwaway fork ( <maintainer>/shopware-aw-trial )
3. Build V0 in 1 day: workflow + slash command + helper scripts
4. 2-week shadow run in the fork against real shopware/shopware issues
5. On green eval: open PR to trunk with the workflow
   Open questions for discussion
   Model choice: Sonnet 4.6 (default) or jump to Haiku 4.5?
   Comment frequency: post a comment also when "confident", or only on uncertainty/duplicate?
   01-needs-triage-labeler.yml : keep (no conflict) or replace?
   Maintainer eval: who labels the 30 test issues independently (for Cohen's κ)?
   Code review as second phase: if triage works well, same pattern for a PR review workflow?
   References
   Anthropic's own triage pattern: https://github.com/anthropics/claudecode/blob/main/.github/workflows/claude-issue-triage.yml
   Slash command example: https://github.com/anthropics/claudecode/blob/main/.claude/commands/triage-issue.md
   Claude Code Action docs: https://github.com/anthropics/claude-code-action
   Full prototype plan: files/triage-agent-prototype-plan.md (local, not in git)
