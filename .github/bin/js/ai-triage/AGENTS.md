# Wrapper Editing Rules — AI Triage

**Scope**: this file governs agents EDITING THE WRAPPER CODE in this directory. The triage-runtime agent itself follows the Skill at `<repo-root>/.claude/skills/triage/SKILL.md` — see that file for runtime policy (output format, anti-reward-hacking, tool discipline).

## Architecture (orientation)

```
<repo-root>/.claude/skills/triage/    ← the SKILL (model-facing, portable across runtimes)
.github/bin/js/ai-triage/             ← the WRAPPER (TS code in this directory)
  ├── triage.ts                       ← CLI entry: fetch, redact, spawn engine, validate
  ├── skill/                          ← TS adapter for the skill's input/output contract
  │   ├── input.ts                    ← RawIssue + TemplateFields + SkillInput Zod schemas
  │   ├── output.ts                   ← TriageOutput Zod + parseJsonFromText
  │   └── prompt.ts                   ← stripFrontmatter + formatPromptWithInput
  ├── pii-patterns.ts                 ← shared PII redaction (used by triage.ts + redact-stream.ts)
  ├── redact-stream.ts                ← post-run output redactor for CI
  ├── generate-schema.ts              ← Zod → JSON Schema generator
  └── schemas/triage-output.schema.json  ← generated, do not hand-edit
```

The skill content (markdown + frontmatter + references) is the **source of truth for prompt content**. The TypeScript code is plumbing.

## TypeScript conventions

- Node 22 LTS+ with native TypeScript execution (no transpiler).
- Strict mode. `pnpm`/`npm` scripts live in `package.json` (`triage`, `test`, `schema:generate`, `schema:check`).
- Zod 4.x for runtime validation at the wrapper-skill boundaries. JSON Schema is generated from Zod via `z.toJSONSchema()` — never edit `schemas/triage-output.schema.json` by hand.
- Tests: colocated `*.spec.ts` files next to the modules they cover (Shopware Admin/Storefront convention). Discovery via `npm test` (= `node --test '**/*.spec.ts'`). No external test framework.

## Don'ts (wrapper-edit specific)

- **Do NOT introduce module-scoped mutable state.** `env` is parsed once at module load and is `const`; same for `VERBOSE`. Adding `let x = …` at module scope is almost always wrong.
- **Do NOT add module-load side-effects** beyond the existing `EnvSchema.parse(process.env)`. New work should be inside `main()` or other entry points.
- **Do NOT duplicate the PII patterns.** `pii-patterns.ts` is the single source of truth — both `triage.ts` and `redact-stream.ts` import from it.
- **Do NOT bake task-specific schemas into the engine runners.** `runOpencode` / `runCodex` / `runClaude` return raw text; the schema parse lives in `runEngine` / `main`. This is the foundation seam for future `ai-pr-review` etc.

## Sandbox & safety (cross-cutting)

The wrapper runs the agent with `workspace-write` sandbox + network access (required for `gh`). Regardless of sandbox permissions:

- The triage agent emits a JSON object only — no file writes, no build commands, no state mutations.
- All shell commands in the skill are read-only in intent.
- PII patterns scrub input and output (CI artifact retention is 14 days).
