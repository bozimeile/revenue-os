const MIN_SECRET_LENGTH = 32;
const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const INVOICE_ID_PATTERN = /^inv_[a-f0-9]{32}$/;
const INVOICE_TOKEN_PATTERN = /^ivt_[a-f0-9]{64}$/;

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH || secret.length > 512) {
    throw new TypeError(`secret must contain between ${MIN_SECRET_LENGTH} and 512 characters`);
  }
}

async function hmacHex(secret, message) {
  assertSecret(secret);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function deriveInvoiceId(secret, idempotencyKey) {
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new TypeError("idempotency key must be 8-128 safe characters");
  }
  const digest = await hmacHex(secret, `invoice-id\0${idempotencyKey}`);
  return `inv_${digest.slice(0, 32)}`;
}

export async function deriveInvoiceToken(secret, invoiceId) {
  if (typeof invoiceId !== "string" || !INVOICE_ID_PATTERN.test(invoiceId)) {
    throw new TypeError("invoice ID is invalid");
  }
  return `ivt_${await hmacHex(secret, `invoice-token\0${invoiceId}`)}`;
}

export async function verifyInvoiceToken(secret, invoiceId, candidate) {
  if (!INVOICE_ID_PATTERN.test(invoiceId) || typeof candidate !== "string" || !INVOICE_TOKEN_PATTERN.test(candidate)) {
    return false;
  }
  const expected = await deriveInvoiceToken(secret, invoiceId);
  return constantTimeEqual(expected, candidate);
}

export function authorizationMatches(header, expectedToken) {
  if (typeof header !== "string" || typeof expectedToken !== "string" || expectedToken.length < MIN_SECRET_LENGTH) {
    return false;
  }
  if (!header.startsWith("Bearer ") || header.slice(7).includes(" ")) {
    return false;
  }
  return constantTimeEqual(header.slice(7), expectedToken);
}
