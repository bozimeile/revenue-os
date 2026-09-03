import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizationMatches,
  deriveInvoiceId,
  deriveInvoiceToken,
  verifyInvoiceToken,
} from "../src/auth.js";

const SECRET = "test-secret-that-is-long-enough-for-hmac-123456789";

test("derives stable opaque invoice identifiers from idempotency keys", async () => {
  const first = await deriveInvoiceId(SECRET, "client-diagnostic-2026-09-02");
  const second = await deriveInvoiceId(SECRET, "client-diagnostic-2026-09-02");
  const other = await deriveInvoiceId(SECRET, "another-request");

  assert.match(first, /^inv_[a-f0-9]{32}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test("derives and verifies a separate invoice capability token", async () => {
  const id = await deriveInvoiceId(SECRET, "request-1");
  const token = await deriveInvoiceToken(SECRET, id);

  assert.match(token, /^ivt_[a-f0-9]{64}$/);
  assert.equal(await verifyInvoiceToken(SECRET, id, token), true);
  assert.equal(await verifyInvoiceToken(SECRET, `${id}0`, token), false);
  assert.equal(await verifyInvoiceToken(SECRET, id, `${token.slice(0, -1)}0`), false);
  assert.equal(await verifyInvoiceToken(SECRET, id, "not-a-token"), false);
});

test("validates bearer authorization without accepting malformed headers", () => {
  const token = "admin-secret-long-enough-for-32-bytes";
  assert.equal(authorizationMatches(`Bearer ${token}`, token), true);
  assert.equal(authorizationMatches(`bearer ${token}`, token), false);
  assert.equal(authorizationMatches(`Bearer ${token} extra`, token), false);
  assert.equal(authorizationMatches(null, token), false);
  assert.equal(authorizationMatches("Bearer other", token), false);
  assert.equal(authorizationMatches("Bearer 1234567890123456789012345678901", "1234567890123456789012345678901"), false);
});
