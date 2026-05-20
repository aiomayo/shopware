/**
 * Skill-prompt mechanics — wrapper-side adapters that materialise the skill's
 * input contract into the actual text the engine receives.
 *
 * Two thin helpers:
 *  - stripFrontmatter: parse a SKILL.md file from disk and return just the body.
 *    Native Agent Skills runtimes do this themselves; the wrapper needs to do it
 *    explicitly because it feeds the body to a non-skill-aware engine via stdin
 *    or argv.
 *  - formatPromptWithInput: combine the skill body with a SkillInput JSON,
 *    wrapped in `<input_json>` tags per the skill's input_format contract.
 *
 * Side-effect-free imports.
 */

import type { SkillInput } from "./input.ts";

/**
 * Strip the YAML frontmatter from a SKILL.md file's contents and return the
 * markdown body. Tolerates a UTF-8 BOM at file start (some editors and Windows
 * git checkouts emit one). Returns the input unchanged if no frontmatter is
 * present, so non-SKILL.md content can be passed through safely.
 */
export function stripFrontmatter(skillFileContent: string): string {
  // Strip UTF-8 BOM if present.
  const content = skillFileContent.charCodeAt(0) === 0xFEFF
    ? skillFileContent.slice(1)
    : skillFileContent;
  // Frontmatter must be at the very start: `---\n...YAML...\n---\n`.
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return content;
  }
  // Find the closing `---` delimiter on its own line. `\s` covers `\r`, so CRLF works.
  const closing = content.match(/\n---\s*\n/);
  if (!closing || closing.index === undefined) {
    return content;
  }
  return content.slice(closing.index + closing[0].length);
}

/**
 * Combine a skill body (markdown content of SKILL.md, frontmatter already
 * stripped) with a SkillInput JSON, wrapped in `<input_json>` tags. This is the
 * wrapper-mode delivery mechanism — the skill's "Operating modes" section
 * documents it.
 */
export function formatPromptWithInput(skillBody: string, input: SkillInput): string {
  return `${skillBody}\n\n<input_json>\n${JSON.stringify(input, null, 2)}\n</input_json>\n`;
}
