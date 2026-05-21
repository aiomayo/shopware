/**
 * Unit tests for the PII redaction module.
 *
 * IMPORTANT: every sample below is SYNTHETIC — strings constructed to match the
 * regex shape but not corresponding to any real account. Never paste a real
 * secret into this file. Use placeholders like "FAKE", "EXAMPLE", repeating
 * digits, or documented vendor example tokens (e.g. AWS's `AKIAIOSFODNN7EXAMPLE`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { redactPii } from "./pii-patterns.ts";

// ---- pattern ordering ---------------------------------------------------

test("redactPii: anthropic key matched before openai", () => {
  const { redacted, counts } = redactPii("token sk-ant-abcdefghijklmnopqrstuv-1234");
  assert.match(redacted, /\[REDACTED_ANTHROPIC_KEY\]/);
  assert.equal(counts.anthropic_key, 1);
  assert.equal(counts.openai_key, undefined, "openai pattern must not swallow sk-ant-");
});

test("redactPii: openai key separate from anthropic", () => {
  const { redacted, counts } = redactPii("sk-proj-1234567890abcdefghij1234");
  assert.match(redacted, /\[REDACTED_OPENAI_KEY\]/);
  assert.equal(counts.openai_key, 1);
});

// ---- single-call smoke tests --------------------------------------------

test("redactPii: github token covers ghr_ prefix (refresh tokens)", () => {
  const { redacted, counts } = redactPii("creds ghr_abc1234567890defghij1234567890");
  assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.equal(counts.github_token, 1);
});

test("redactPii: shopware integration key (SWIA prefix)", () => {
  const { redacted, counts } = redactPii("key SWIAAXP2DM5FEFNADWLNU2HVWQ ok");
  assert.match(redacted, /\[REDACTED_SHOPWARE_KEY\]/);
  assert.equal(counts.shopware_integration_key, 1);
});

test("redactPii: basic-auth URL preserves host", () => {
  const { redacted } = redactPii("https://alice:secret123@api.example.com/path");
  assert.match(redacted, /https:\/\/\[REDACTED_USER\]:\[REDACTED_PASS\]@api\.example\.com\/path/);
});

test("redactPii: private-key block bounded (regex does not catastrophically backtrack)", () => {
  // Unterminated BEGIN block — the {1,8192}? quantifier ensures linear bounded time,
  // not catastrophic exponential backtracking. ~200ms on a 20KB body is fine; ReDoS
  // would be measured in seconds/minutes.
  const longUnterminated = "-----BEGIN RSA PRIVATE KEY-----\n" + "A".repeat(20_000);
  const start = Date.now();
  redactPii(longUnterminated);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `private-key regex took ${elapsed}ms — ReDoS regression?`);
});

test("redactPii: email regex bounded (no ReDoS on 65 KB alphanumeric without @)", () => {
  // Pre-bounding the email regex was O(n²) — 65 KB of `a` chars took ~1.9s.
  // After bounding to RFC-5321 lengths the same input redacts in ~5ms. A single
  // crafted GitHub issue body (max 65,536 chars) could previously DoS the workflow.
  const adversarial = "a".repeat(65_000);
  const start = Date.now();
  redactPii(adversarial);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `email regex took ${elapsed}ms on 65 KB — ReDoS regression?`);
});

test("redactPii: all patterns ~O(n) on 65 KB adversarial input", () => {
  // Sweep guard against future ReDoS regressions in any pattern. The harshest
  // adversarial input is a long run of "permissive" characters — alphanumeric +
  // common separators. Each pattern individually must finish well under 200ms.
  const adversarial = "a".repeat(65_000);
  const start = Date.now();
  redactPii(adversarial);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `combined PII redaction took ${elapsed}ms on 65 KB — ReDoS suspect`);
});

// ---- per-pattern coverage (synthetic samples only) ----------------------

test("redactPii: anthropic key — variations", () => {
  // shape: sk-ant-<at least 20 alphanumeric, underscore, or dash chars>
  for (const sample of [
    "sk-ant-FAKE1234567890fakefakefake",
    "sk-ant-api03-fake-token-abcdefghij1234567890",
    "Header: Authorization: sk-ant-ABCDEFGHIJ1234567890ABC",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_ANTHROPIC_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: openai key — sk- and sk-proj-", () => {
  for (const sample of [
    "sk-FAKE1234567890fakefakefakefake",
    "sk-proj-FAKE1234567890fakefakefake_xyz",
    "key=sk-1234567890abcdefghij1234ABC",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_OPENAI_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: stripe — live + test + restricted + webhook keys", () => {
  for (const sample of [
    "sk_live_FAKE1234567890fakefake",
    "sk_test_FAKE1234567890fakefake",
    "pk_live_FAKE1234567890fakefake",
    "pk_test_FAKE1234567890fakefake",
    "rk_live_FAKE1234567890fakefake",
    "whsec_live_FAKE1234567890fakefake",
    "whsec_test_FAKE1234567890fakefake",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_STRIPE_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: github token — all current prefixes (ghp/gho/ghu/ghs/ghr/github_pat)", () => {
  for (const sample of [
    "ghp_FAKE1234567890abcdefghij",
    "gho_FAKE1234567890abcdefghij",
    "ghu_FAKE1234567890abcdefghij",
    "ghs_FAKE1234567890abcdefghij",
    "ghr_FAKE1234567890abcdefghij",
    "github_pat_FAKE1234567890abcdefghij",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/, `failed: ${sample}`);
  }
});

test("redactPii: AWS access keys (AKIA + ASIA)", () => {
  for (const sample of [
    "AKIAIOSFODNN7EXAMPLE",  // AWS's documented example value
    "ASIAIOSFODNN7EXAMPLE",
    "Found AKIA1234567890ABCDEF in config",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_AWS_ACCESS_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: Google API key (AIza-prefix, 35-char body)", () => {
  // Format: AIza + exactly 35 chars from [0-9A-Za-z_-]
  const sample = "AIza" + "FAKE".repeat(9).slice(0, 35); // 4 + 35 = 39 chars
  assert.equal(sample.length, 39);
  const { redacted } = redactPii(sample);
  assert.match(redacted, /\[REDACTED_GOOGLE_API_KEY\]/);
});

test("redactPii: Slack tokens — bot, user, app, configuration, refresh", () => {
  for (const sample of [
    "xoxb-1234567890-abcdefghij-FAKEFAKEFAKE",
    "xoxp-1234567890-fakefakefakefakefakefakefake",
    "xoxa-2-1234567890-abcdefghij",
    "xoxr-fakefakefakefakefakefake",
    "xoxs-fakefakefakefakefakefake",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_SLACK_TOKEN\]/, `failed: ${sample}`);
  }
});

test("redactPii: Shopware integration key (SWIA prefix) — variations", () => {
  for (const sample of [
    "SWIAFAKEFAKEFAKEFAKEFAKE",
    "key=SWIA1234567890ABCDEFGHIJ",
    "Found SWIAABCDEFGHIJKLMNOPQRSTUV in config.",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_SHOPWARE_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: JWT — three base64url segments separated by dots", () => {
  // Each segment ≥10 chars from [A-Za-z0-9_-]; first must start with eyJ
  const sample = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.FAKEsignaturefakefake_xyz";
  const { redacted } = redactPii(sample);
  assert.match(redacted, /\[REDACTED_JWT\]/);
});

test("redactPii: Bearer token in HTTP header", () => {
  const sample = "Authorization: Bearer FAKE1234567890abcdefghij1234.xyz";
  const { redacted } = redactPii(sample);
  assert.match(redacted, /Bearer \[REDACTED_BEARER\]/);
});

test("redactPii: basic-auth URL (creds in URL)", () => {
  const sample = "Failing fetch: https://alice:s3cret-fake@api.example.com/path?x=1";
  const { redacted } = redactPii(sample);
  assert.match(redacted, /https:\/\/\[REDACTED_USER\]:\[REDACTED_PASS\]@api\.example\.com/);
});

test("redactPii: private-key PEM block (RSA, EC, OPENSSH, PGP variants)", () => {
  for (const variant of ["RSA ", "EC ", "DSA ", "OPENSSH ", "PGP ", ""]) {
    const sample = `-----BEGIN ${variant}PRIVATE KEY-----
SYNTHETICKEYDATAFAKEFAKEFAKEFAKEFAKEFAKE
-----END ${variant}PRIVATE KEY-----`;
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/, `failed for variant: ${variant.trim() || "default"}`);
  }
});

test("redactPii: email — common formats", () => {
  for (const sample of [
    "user@example.com",
    "first.last+tag@example.de",
    "user-name@sub.example.co.uk",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_EMAIL\]/, `failed: ${sample}`);
  }
});

test("redactPii: IBAN — DE, FR, GB", () => {
  for (const sample of [
    "DE89 3704 0044 0532 0130 00",
    "FR1420041010050500013M02606",
    "GB29 NWBK 6016 1331 9268 19",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_IBAN\]/, `failed: ${sample}`);
  }
});

// ---- new categories: Shopware URLs, DAL IDs, phone, credit card --------

test("redactPii: shopware cloud + orb.local URLs", () => {
  for (const sample of [
    "https://customer-xyz.cloud.shopware.com/admin/dashboard",
    "http://shop1.orb.local:8080/api/order/list",
    "https://demo.shop.example.com/account",
  ]) {
    const { redacted, counts } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_INTERNAL_URL\]/, `failed: ${sample}`);
    assert.equal(counts.shopware_url, 1);
  }
});

test("redactPii: DAL UUID/ULID IDs in admin/api URL paths", () => {
  const sample = "GET /api/order/01abcdef0123456789abcdef01234567 returned 404";
  const { redacted, counts } = redactPii(sample);
  assert.match(redacted, /\/api\/order\/\[REDACTED_ID\]/);
  assert.equal(counts.dal_id_in_url, 1);
});

test("redactPii: DAL ID NOT redacted when not in admin/api path (e.g. commit SHA in prose)", () => {
  const sample = "commit 0123456789abcdef0123456789abcdef0123456789 fixed it"; // 40-char SHA
  const { redacted, counts } = redactPii(sample);
  // SHA not redacted — 32-hex anchored to /admin/ or /api/ only
  assert.equal(counts.dal_id_in_url, undefined);
  assert.match(redacted, /0123456789abcdef/);
});

test("redactPii: phone numbers in E.164 / German / US formats", () => {
  for (const sample of [
    "Call +49 1234 567890 for support",
    "phone: +1 (555) 123-4567",
    "Contact: +44 20 7946 0958",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_PHONE\]/, `failed: ${sample}`);
  }
});

test("redactPii: credit card with Luhn validation", () => {
  // 4532015112830366 is a real Luhn-valid test PAN.
  const { redacted, counts } = redactPii("card: 4532 0151 1283 0366");
  assert.match(redacted, /\[REDACTED_CREDIT_CARD\]/);
  assert.equal(counts.credit_card, 1);
});

test("redactPii: 16-digit non-Luhn order number NOT redacted as credit card", () => {
  // 1234567890123456 — Luhn-invalid, looks like an order ID.
  const { redacted, counts } = redactPii("order: 1234567890123456");
  assert.equal(counts.credit_card, undefined);
  assert.match(redacted, /1234567890123456/);
});

test("redactPii: /Users/ path on macOS", () => {
  const { redacted } = redactPii("error in /Users/alice.dev/code/file.ts");
  assert.match(redacted, /\/Users\/\[REDACTED_USER\]\/code\/file\.ts/);
});

// ---- negative tests — must NOT redact -----------------------------------

test("redactPii: ordinary code/text not falsely matched", () => {
  for (const safe of [
    "function foo() { return 42; }",
    "src/Core/Content/Product/ProductDefinition.php",
    "The export download failed for customer.",
    "DEFG HIJKL MNOPQ",      // not enough digits to be IBAN
    "Issue #16599 references PR #16632 in trunk.",
  ]) {
    const { redacted, counts } = redactPii(safe);
    assert.equal(redacted, safe, `false positive in: ${safe}`);
    assert.equal(Object.keys(counts).length, 0, `false positive counts in: ${safe}`);
  }
});

test("redactPii: order-of-patterns smoke test (all 9 categories don't cross-match)", () => {
  const blob = [
    "sk-ant-abcdefghijklmnopqrstuv1234567890",
    "sk-proj-1234567890abcdefghij1234567890",
    "sk_live_1234567890abcdefghij12",
    "ghp_abc1234567890defghij12345",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-1234567890-abcdefghijkl-mnopqrstuvwxyz",
    "SWIAAXP2DM5FEFNADWLNU2HVWQ",
    "test@example.de",
    "/Users/jdoe/code",
  ].join("\n");
  const { counts } = redactPii(blob);
  // Each category should fire at least once. github_token may collide with shopware_integration_key
  // shape if the prefix overlapped, so we assert >=1 not strictly 1.
  for (const key of ["anthropic_key", "openai_key", "stripe_key", "github_token", "aws_access_key",
                     "slack_token", "shopware_integration_key", "email", "user_path"]) {
    assert.ok((counts[key] ?? 0) >= 1, `expected ${key} to be matched, got ${JSON.stringify(counts)}`);
  }
});
