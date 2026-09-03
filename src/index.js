import { allocateUsdCents, validateAllocationPolicy } from "./allocation.js";
import {
  authorizationMatches,
  deriveInvoiceId,
  deriveInvoiceToken,
  verifyInvoiceToken,
} from "./auth.js";
import { parseLeadSources, parsePaymentConfig } from "./config.js";
import { runLeadDiscovery } from "./discovery.js";
import { PaymentVerificationError } from "./payment.js";
import { isLeadStatus } from "./lifecycle.js";
import {
  RpcVerificationError,
  verifyPaymentWithRpcQuorum,
  verifyTokenDecimalsWithRpcQuorum,
} from "./rpc.js";
import { D1Store, StoreConflictError } from "./store.js";

const MAX_JSON_BODY_BYTES = 16_384;
const MAX_INVOICE_USD_CENTS = 100_000_000;
const MAX_INVOICE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const OFFER_CODE_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const LEAD_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,160}$/;

class RequestValidationError extends Error {}

function responseHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders(), ...extraHeaders },
  });
}

function methodNotAllowed(allowed) {
  return json({ error: "method_not_allowed" }, 405, { allow: allowed });
}

async function readJson(request) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new RequestValidationError("content type must be application/json");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    throw new RequestValidationError("request body is too large");
  }
  const text = await request.text();
  if (!text || new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new RequestValidationError("request body is empty or too large");
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed;
  } catch {
    throw new RequestValidationError("request body is not valid JSON");
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function findPaymentSelection(payment, chainId, tokenSymbol) {
  const chain = payment.chains.find((candidate) => candidate.chainId === chainId);
  const token = chain?.tokens.find((candidate) => candidate.symbol === tokenSymbol);
  if (!chain || !token) {
    throw new RequestValidationError("chain or token is not enabled");
  }
  return { chain, token };
}

function validateNewInvoice(body, config, now) {
  if (!OFFER_CODE_PATTERN.test(body.offerCode)) {
    throw new RequestValidationError("offer code is invalid");
  }
  if (!Number.isSafeInteger(body.amountUsdCents) || body.amountUsdCents <= 0 || body.amountUsdCents > MAX_INVOICE_USD_CENTS) {
    throw new RequestValidationError("invoice amount is invalid");
  }
  if (!Number.isSafeInteger(body.chainId) || typeof body.tokenSymbol !== "string") {
    throw new RequestValidationError("payment selection is invalid");
  }
  if (!ADDRESS_PATTERN.test(body.payerAddress)) {
    throw new RequestValidationError("payer address is invalid");
  }
  if (body.leadId !== undefined && body.leadId !== null && !LEAD_ID_PATTERN.test(body.leadId)) {
    throw new RequestValidationError("lead ID is invalid");
  }

  const expiresAt = new Date(body.expiresAt);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() > now.getTime() + MAX_INVOICE_LIFETIME_MS
  ) {
    throw new RequestValidationError("invoice expiry is invalid");
  }
  const { chain, token } = findPaymentSelection(config.payment, body.chainId, body.tokenSymbol);
  if (token.decimals < 2 || body.payerAddress.toLowerCase() === token.recipient) {
    throw new RequestValidationError("payer or token denomination is invalid");
  }

  const amountAtomic = (BigInt(body.amountUsdCents) * 10n ** BigInt(token.decimals - 2)).toString();
  return {
    leadId: body.leadId ?? null,
    offerCode: body.offerCode,
    amountUsdCents: body.amountUsdCents,
    chainId: chain.chainId,
    tokenSymbol: token.symbol,
    tokenAddress: token.address,
    tokenDecimals: token.decimals,
    amountAtomic,
    payerAddress: body.payerAddress.toLowerCase(),
    recipientAddress: token.recipient,
    minConfirmations: token.minConfirmations,
    expiresAt: expiresAt.toISOString(),
  };
}

function publicInvoice(invoice) {
  return {
    id: invoice.id,
    leadId: invoice.leadId,
    offerCode: invoice.offerCode,
    amountUsdCents: invoice.amountUsdCents,
    chainId: invoice.chainId,
    tokenSymbol: invoice.tokenSymbol,
    tokenAddress: invoice.tokenAddress,
    tokenDecimals: invoice.tokenDecimals,
    amountAtomic: invoice.amountAtomic,
    payerAddress: invoice.payerAddress,
    recipientAddress: invoice.recipientAddress,
    minConfirmations: invoice.minConfirmations,
    status: invoice.status,
    createdAt: invoice.createdAt,
    expiresAt: invoice.expiresAt,
    paidAt: invoice.paidAt,
  };
}

function publicLead(lead) {
  return {
    id: lead.id,
    source: lead.source,
    evidenceUrl: lead.evidenceUrl,
    title: lead.title,
    description: lead.description,
    author: lead.author,
    authorType: lead.authorType,
    labels: lead.labels,
    score: lead.score,
    scoreReasons: lead.scoreReasons,
    status: lead.status,
    discoveredAt: lead.discoveredAt,
    lastVerifiedAt: lead.lastVerifiedAt,
    updatedAt: lead.updatedAt,
  };
}

function paymentUri(invoice) {
  return `ethereum:${invoice.tokenAddress}@${invoice.chainId}/transfer?address=${invoice.recipientAddress}&uint256=${invoice.amountAtomic}`;
}

function canonicalInvoiceFingerprint(input) {
  return JSON.stringify([
    input.leadId,
    input.offerCode,
    input.amountUsdCents,
    input.chainId,
    input.tokenSymbol,
    input.tokenAddress,
    input.tokenDecimals,
    input.amountAtomic,
    input.payerAddress,
    input.recipientAddress,
    input.minConfirmations,
    input.expiresAt,
  ]);
}

async function requireInvoiceCapability(request, store, secret, id) {
  const token = request.headers.get("x-invoice-token");
  if (!(await verifyInvoiceToken(secret, id, token))) {
    return null;
  }
  return store.getInvoice(id);
}

function errorResponse(error) {
  if (error instanceof RequestValidationError) {
    return json({ error: "invalid_request" }, 400);
  }
  if (error instanceof StoreConflictError) {
    return json({ error: "conflict" }, 409);
  }
  if (error instanceof PaymentVerificationError || error instanceof RpcVerificationError) {
    const waiting = ["PAYMENT_PENDING", "INSUFFICIENT_CONFIRMATIONS", "RPC_QUORUM_NOT_REACHED"].includes(error.code);
    return json({ error: waiting ? "payment_not_confirmed" : "payment_invalid" }, waiting ? 202 : 400);
  }
  return json({ error: "internal_error" }, 500);
}

export function createApp({
  store,
  config,
  clock = () => new Date(),
  rpcVerifier = verifyPaymentWithRpcQuorum,
  tokenMetadataVerifier = verifyTokenDecimalsWithRpcQuorum,
  fetchFn = fetch,
}) {
  if (
    !store ||
    !config ||
    typeof clock !== "function" ||
    typeof rpcVerifier !== "function" ||
    typeof tokenMetadataVerifier !== "function"
  ) {
    throw new TypeError("store, config, clock, and RPC verifiers are required");
  }

  return {
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health") {
          return request.method === "GET"
            ? json({ ok: true, service: "revenue-os" })
            : methodNotAllowed("GET");
        }

        if (url.pathname === "/v1/revenue") {
          if (request.method !== "GET") return methodNotAllowed("GET");
          if (!authorizationMatches(request.headers.get("authorization"), config.adminToken)) {
            return json({ error: "unauthorized" }, 401);
          }
          return json(await store.getRevenueSummary());
        }

        if (url.pathname === "/v1/leads") {
          if (request.method !== "GET") return methodNotAllowed("GET");
          if (!authorizationMatches(request.headers.get("authorization"), config.adminToken)) {
            return json({ error: "unauthorized" }, 401);
          }
          const status = url.searchParams.get("status");
          const rawLimit = url.searchParams.get("limit") ?? "50";
          if ((status !== null && !isLeadStatus(status)) || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) {
            throw new RequestValidationError("lead list query is invalid");
          }
          const leads = await store.listLeads({ status, limit: Number(rawLimit) });
          return json({ leads: leads.map(publicLead) });
        }

        const leadStatusMatch = /^\/v1\/leads\/([a-zA-Z0-9:_-]{1,160})\/status$/.exec(url.pathname);
        if (leadStatusMatch) {
          if (request.method !== "PATCH") return methodNotAllowed("PATCH");
          if (!authorizationMatches(request.headers.get("authorization"), config.adminToken)) {
            return json({ error: "unauthorized" }, 401);
          }
          const body = await readJson(request);
          if (!isLeadStatus(body.expectedStatus) || !isLeadStatus(body.nextStatus)) {
            throw new RequestValidationError("lead transition is invalid");
          }
          const lead = await store.transitionLead(
            leadStatusMatch[1],
            body.expectedStatus,
            body.nextStatus,
            clock().toISOString(),
          );
          return json({ lead: publicLead(lead) });
        }

        if (url.pathname === "/v1/invoices") {
          if (request.method !== "POST") return methodNotAllowed("POST");
          if (!authorizationMatches(request.headers.get("authorization"), config.adminToken)) {
            return json({ error: "unauthorized" }, 401);
          }
          const idempotencyKey = request.headers.get("idempotency-key");
          const invoiceId = await deriveInvoiceId(config.invoiceTokenSecret, idempotencyKey);
          const body = await readJson(request);
          const now = clock();
          const input = validateNewInvoice(body, config, now);
          const { chain, token } = findPaymentSelection(config.payment, input.chainId, input.tokenSymbol);
          await tokenMetadataVerifier({
            chainId: chain.chainId,
            tokenAddress: token.address,
            expectedDecimals: token.decimals,
            rpcUrls: chain.rpcUrls,
            rpcQuorum: chain.rpcQuorum,
            fetchFn,
          });
          if (input.leadId) {
            const lead = await store.getLead(input.leadId);
            if (!lead || lead.status !== "contracted") {
              throw new RequestValidationError("linked invoice requires a contracted lead");
            }
          }
          const requestFingerprint = await sha256Hex(canonicalInvoiceFingerprint(input));
          const result = await store.createInvoice({
            id: invoiceId,
            requestFingerprint,
            ...input,
            status: "open",
            createdAt: now.toISOString(),
          });
          const invoiceToken = await deriveInvoiceToken(config.invoiceTokenSecret, invoiceId);
          return json(
            {
              invoice: publicInvoice(result.invoice),
              invoiceToken,
              paymentUri: paymentUri(result.invoice),
            },
            result.created ? 201 : 200,
          );
        }

        const verifyMatch = /^\/v1\/invoices\/(inv_[a-f0-9]{32})\/verify$/.exec(url.pathname);
        if (verifyMatch) {
          if (request.method !== "POST") return methodNotAllowed("POST");
          const invoice = await requireInvoiceCapability(
            request,
            store,
            config.invoiceTokenSecret,
            verifyMatch[1],
          );
          if (!invoice) return json({ error: "not_found" }, 404);
          if (invoice.status === "paid") {
            return json({
              invoice: publicInvoice(invoice),
              allocations: await store.getPaymentAllocations(invoice.paidPaymentId),
            });
          }
          const now = clock();
          if (invoice.status === "expired" || new Date(invoice.expiresAt).getTime() <= now.getTime()) {
            if (invoice.status === "open") await store.markInvoiceExpired(invoice.id, now.toISOString());
            return json({ error: "invoice_expired" }, 410);
          }
          const body = await readJson(request);
          if (typeof body.transactionHash !== "string" || !TX_HASH_PATTERN.test(body.transactionHash)) {
            throw new RequestValidationError("transaction hash is invalid");
          }
          const { chain } = findPaymentSelection(config.payment, invoice.chainId, invoice.tokenSymbol);
          const verification = await rpcVerifier({
            invoice,
            txHash: body.transactionHash.toLowerCase(),
            rpcUrls: chain.rpcUrls,
            rpcQuorum: chain.rpcQuorum,
            fetchFn,
          });
          const allocations = allocateUsdCents(invoice.amountUsdCents, config.allocationPolicy);
          const paid = await store.markInvoicePaid({
            invoiceId: invoice.id,
            verification,
            allocations,
            receivedAt: now.toISOString(),
          });
          return json({ invoice: publicInvoice(paid), allocations });
        }

        const invoiceMatch = /^\/v1\/invoices\/(inv_[a-f0-9]{32})$/.exec(url.pathname);
        if (invoiceMatch) {
          if (request.method !== "GET") return methodNotAllowed("GET");
          const invoice = await requireInvoiceCapability(
            request,
            store,
            config.invoiceTokenSecret,
            invoiceMatch[1],
          );
          return invoice ? json({ invoice: publicInvoice(invoice) }) : json({ error: "not_found" }, 404);
        }

        return json({ error: "not_found" }, 404);
      } catch (error) {
        return errorResponse(error);
      }
    },

    async scheduled() {
      return runLeadDiscovery({
        sources: config.leadSources,
        now: clock(),
        fetchFn,
        store,
        githubToken: config.githubToken,
      });
    },
  };
}

export function loadRuntimeConfig(env) {
  if (typeof env.ADMIN_TOKEN !== "string" || env.ADMIN_TOKEN.length < 32) {
    throw new TypeError("ADMIN_TOKEN is missing or too short");
  }
  if (typeof env.INVOICE_TOKEN_SECRET !== "string" || env.INVOICE_TOKEN_SECRET.length < 32) {
    throw new TypeError("INVOICE_TOKEN_SECRET is missing or too short");
  }
  let allocationPolicy;
  try {
    allocationPolicy = validateAllocationPolicy(JSON.parse(env.ALLOCATION_POLICY_JSON));
  } catch {
    throw new TypeError("ALLOCATION_POLICY_JSON is invalid");
  }
  return {
    adminToken: env.ADMIN_TOKEN,
    invoiceTokenSecret: env.INVOICE_TOKEN_SECRET,
    githubToken: typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN ? env.GITHUB_TOKEN : null,
    payment: parsePaymentConfig(env.PAYMENT_CONFIG_JSON),
    allocationPolicy,
    leadSources: parseLeadSources(env.LEAD_SOURCES_JSON),
  };
}

export default {
  async fetch(request, env) {
    try {
      return createApp({ store: new D1Store(env.DB), config: loadRuntimeConfig(env) }).fetch(request);
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
  },

  scheduled(_controller, env, context) {
    const task = createApp({ store: new D1Store(env.DB), config: loadRuntimeConfig(env) }).scheduled();
    context.waitUntil(task);
  },
};
