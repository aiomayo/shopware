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
  /**
   * Optional filter applied per match. If the filter returns false, the match
   * is left in place (not redacted). Used for Luhn-validation on the credit
   * card pattern: without this, every 13-19 digit sequence (order IDs, hashes,
   * commit-line numbers) would be mis-redacted.
   */
  readonly accept?: (match: string) => boolean;
}

/** Luhn checksum validator — used by the credit-card pattern. */
function luhnValid(s: string): boolean {
  const digits = s.replace(/[\s-]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) return false;
    let d = code - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
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
  // Quantifiers bounded to RFC-5321 lengths (local 64, domain 253, TLD 24) so the
  // engine cannot backtrack across the whole input on adversarial alphanumeric runs
  // (e.g. 65 KB of `a`-class chars). Without the bounds this regex was O(n²) and
  // a single crafted issue body could burn minutes of CPU per triage run.
  { type: "email", regex: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g, replacement: "[REDACTED_EMAIL]" },
  // IBAN: 2 letters (country) + 2 check digits + BBAN. BBAN content is country-specific
  // alphanumeric (per ISO 13616) — France, UK and others have letters mixed with digits.
  { type: "iban", regex: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g, replacement: "[REDACTED_IBAN]" },
  { type: "user_path", regex: /\/Users\/[A-Za-z0-9._-]+/g, replacement: "/Users/[REDACTED_USER]" },
  // Shopware-internal hostnames. Customer-shop subdomains follow `*.shop.example.com`
  // or vary per customer; orb.local is the local-dev OrbStack convention.
  // Bounded to RFC-1035 label length (63) per segment to prevent ReDoS.
  { type: "shopware_url", regex: /\bhttps?:\/\/[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.(?:cloud\.shopware\.com|shop\.example\.com|orb\.local)\b\S{0,256}/gi, replacement: "[REDACTED_INTERNAL_URL]" },
  // DAL IDs (UUIDv4 / ULID-style 32 hex chars) appearing in admin/api URL paths.
  // Anchored to `/admin/...` or `/api/...` to avoid false-positives on commit
  // SHAs in plain prose.
  { type: "dal_id_in_url", regex: /(\/(?:admin|api)\/[a-z0-9_-]{1,64}\/)[0-9a-f]{32}\b/gi, replacement: "$1[REDACTED_ID]" },
  // Phone numbers — E.164 + common European/US formats. Bounded local-part
  // lengths prevent ReDoS on long alphanumeric runs.
  { type: "phone", regex: /(?<![A-Za-z0-9])\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}[\s.-]?\d{1,4}[\s.-]?\d{1,9}(?![A-Za-z0-9])/g, replacement: "[REDACTED_PHONE]" },
  // Credit card — 13-19 digits with optional spaces/hyphens, Luhn-validated to
  // filter out order numbers and other 16-digit runs. Bounded to 19 digits.
  { type: "credit_card", regex: /\b(?:\d[ -]?){12,18}\d\b/g, replacement: "[REDACTED_CREDIT_CARD]", accept: luhnValid },
];

export function redactPii(text: string): { redacted: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let redacted = text;
  for (const { type, regex, replacement, accept } of PII_PATTERNS) {
    if (accept) {
      // Per-match validation: only redact matches that pass the filter.
      // The replacer receives the full match (and any capture groups); we
      // return either the replacement (with backrefs resolved manually) or
      // the original match unchanged.
      let count = 0;
      redacted = redacted.replace(regex, (...args) => {
        // Last two args are `offset` and `string`; everything before is match + capture groups.
        const match = args[0] as string;
        if (!accept(match)) return match;
        count++;
        // Resolve $1, $2... backrefs in the replacement.
        return replacement.replace(/\$(\d+)/g, (_, n) => (args[Number(n)] as string) ?? "");
      });
      if (count > 0) counts[type] = count;
    } else {
      const matches = redacted.match(regex);
      if (matches) {
        counts[type] = matches.length;
        redacted = redacted.replace(regex, replacement);
      }
    }
  }
  return { redacted, counts };
}
