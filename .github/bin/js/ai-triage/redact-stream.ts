/**
 * Stream-mode PII redactor — reads stdin, applies the shared PII patterns,
 * writes redacted stdout. Used in CI after the agent runs to scrub captured
 * stdout/stderr before they become a 14-day artifact. The agent's own `gh`
 * calls may have surfaced PII from other issues/PRs that the wrapper's
 * input-side redactor never saw.
 *
 * Input is capped to MAX_INPUT_BYTES to prevent OOM on a chatty agent transcript;
 * above the cap, the redactor warns to stderr and truncates.
 */

import { readFileSync } from "node:fs";
import { redactPii } from "./pii-patterns.ts";

const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10 MB — agent transcripts are sub-MB in practice.

const raw = readFileSync(0, "utf8");
const input = raw.length > MAX_INPUT_BYTES
  ? (process.stderr.write(`[redact-stream] input ${raw.length} bytes exceeds cap ${MAX_INPUT_BYTES}; truncating\n`), raw.slice(0, MAX_INPUT_BYTES))
  : raw;

const { redacted } = redactPii(input);
process.stdout.write(redacted);
