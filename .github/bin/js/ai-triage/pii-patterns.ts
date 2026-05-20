/**
 * Single source of truth for PII redaction patterns.
 *
 * Used by:
 *  - triage.ts (input-side redaction of the issue body before sending to the agent)
 *  - redact-stream.ts (post-run redaction of captured stdout/stderr before CI artifact upload)
 *
 * Pattern ordering matters — earlier entries take precedence:
 *  - anthropic_key (`sk-ant-...`) MUST come before openai_key (`sk-...`) — the OpenAI
 *    pattern would otherwise eat the `sk-ant-` prefix.
 *  - github_token covers ghp/gho/ghu/ghs/ghr/github_pat in one entry to avoid intra-PR overlap.
 *
 * Length quantifiers are deliberately bounded (e.g. `[\s\S]{1,8192}?` on the PEM block)
 * to prevent catastrophic backtracking ReDoS on unmatched delimiters in agent output.
 *
 * When adding a new PII type:
 *  1. Pick a unique `type` slug (used for telemetry counts in triage.ts).
 *  2. Anchor with `\b` where possible.
 *  3. Cap any `[\s\S]*?` with an explicit `{1,N}?` based on the realistic max payload.
 */

interface PiiPattern {
  readonly type: string;
  readonly regex: RegExp;
  readonly replacement: string;
}

const PII_PATTERNS: ReadonlyArray<PiiPattern> = [
  // Anthropic + OpenAI keys may include underscores (base64url) in addition to alphanumerics + dashes.
  { type: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  { type: "openai_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_OPENAI_KEY]" },
  { type: "stripe_key", regex: /\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_STRIPE_KEY]" },
  { type: "github_token", regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { type: "aws_access_key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: "[REDACTED_AWS_ACCESS_KEY]" },
  { type: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[REDACTED_GOOGLE_API_KEY]" },
  { type: "slack_token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  // Shopware integration key — see MEMORY.md (SWIAAXP2DM5FEFNADWLNU2HVWQ format).
  { type: "shopware_integration_key", regex: /\bSWIA[A-Z0-9]{20,}\b/g, replacement: "[REDACTED_SHOPWARE_KEY]" },
  { type: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED_JWT]" },
  { type: "bearer_token", regex: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g, replacement: "Bearer [REDACTED_BEARER]" },
  { type: "basic_auth_url", regex: /\b(https?:\/\/)([^\s:@/]+):([^\s@/]+)@/g, replacement: "$1[REDACTED_USER]:[REDACTED_PASS]@" },
  // Private-key block — content quantifier bounded to 8 KB to prevent ReDoS when the END
  // marker is missing. A realistic PEM body fits comfortably under 8 KB.
  { type: "private_key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{1,8192}?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { type: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[REDACTED_EMAIL]" },
  // IBAN: 2 letters (country) + 2 check digits + BBAN. BBAN content is country-specific
  // alphanumeric (per ISO 13616) — France, UK and others have letters mixed with digits.
  { type: "iban", regex: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g, replacement: "[REDACTED_IBAN]" },
  { type: "user_path", regex: /\/Users\/[A-Za-z0-9._-]+/g, replacement: "/Users/[REDACTED_USER]" },
];

export function redactPii(text: string): { redacted: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let redacted = text;
  for (const { type, regex, replacement } of PII_PATTERNS) {
    const matches = redacted.match(regex);
    if (matches) {
      counts[type] = matches.length;
      redacted = redacted.replace(regex, replacement);
    }
  }
  return { redacted, counts };
}
