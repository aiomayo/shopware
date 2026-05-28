# Shopware AI Skills

Portable AI capabilities packaged in the [Anthropic Agent Skills](https://agentskills.io) format. Auto-loaded by Claude Code, opencode, Codex CLI, Cursor, Gemini CLI and other Agent Skills-compatible runtimes when their `description` matches the user's message.

## Available skills

| Skill | Trigger phrases (examples) | What it does |
|---|---|---|
| [`triage`](triage/SKILL.md) | "triage issue #X", "classify this bug", "is this a duplicate", "what severity is #N" | Triages a Shopware 6 GitHub bug issue — identifies affected code area, checks for related fixes, emits a structured JSON decision (disposition, severity, suggested labels, confidence, evidence). |
| [`review`](review/SKILL.md) | "review PR #X", "security review this branch", "review my staged changes" | Reviews a Shopware 6 PR or local diff through calibrated persona lenses, dedupes findings, and emits Markdown or schema-valid JSON depending on invocation mode. |

## How auto-loading works

When you start a session in this repo with Claude Code / opencode / Codex CLI:

1. The runtime scans `.claude/skills/` for `SKILL.md` files.
2. Each skill's `description` frontmatter is matched against your message.
3. If a skill matches, its body (plus on-demand `references/`) is injected into the agent's context.

No flags, no plugins — drop into a session and just describe what you want.

## Two operating modes

Each skill works two ways:

- **Interactive (you, in your editor)** — say "triage issue #16599" → skill auto-loads. The agent uses the shell (`rg`, `git`, `gh`) to investigate.
- **Wrapper-fed (CI / scripts)** — `.github/bin/js/ai-triage/` etc. invoke the same SKILL.md programmatically with PII redaction, schema validation, and engine-engine multiplexing. One source of truth for the skill content.

## Adding a new skill

1. Create `.claude/skills/<name>/SKILL.md` with at minimum `name` + `description` frontmatter (see [the spec](https://agentskills.io/specification)).
2. Add references and assets as needed. Keep SKILL.md short; push detail into `references/`.
3. Optional: add a wrapper at `.github/bin/js/ai-<name>/` if you also want CI invocation.
