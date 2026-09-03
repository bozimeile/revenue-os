import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createApp, loadRuntimeConfig } from "../src/index.js";
import { deriveInvoiceId } from "../src/auth.js";
import { PaymentVerificationError } from "../src/payment.js";
import { RpcVerificationError } from "../src/rpc.js";
import { D1Store } from "../src/store.js";
import { SqliteD1 } from "./helpers/sqlite-d1.js";

const schema = [
  await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"),
  await readFile(new URL("../migrations/0002_sales_integrity.sql", import.meta.url), "utf8"),
].join("\n");
const ADMIN_TOKEN = "admin-token-long-enough-for-tests";
const INVOICE_SECRET = "invoice-secret-long-enough-for-hmac-tests-123456";
const TOKEN = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"ab".repeat(32)}`;

function configuration() {
  return {
    adminToken: ADMIN_TOKEN,
    invoiceTokenSecret: INVOICE_SECRET,
    githubToken: null,
    payment: {
      chains: [
        {
          chainId: 46630,
          rpcUrls: ["https://rpc-a.example/", "https://rpc-b.example/"],
          rpcQuorum: 2,
          tokens: [
            {
              symbol: "USDC",
              address: TOKEN,
              recipient: RECIPIENT,
              decimals: 6,
              minConfirmations: 6,
            },
          ],
        },
      ],
    },
    allocationPolicy: [
      { key: "tax_reserve", bps: 2500 },
      { key: "operating_reserve", bps: 1000 },
      { key: "delivery_and_tools", bps: 500 },
      { key: "owner_available", bps: 6000 },
    ],
    leadSources: [
      {
        name: "wallet-work",
        url: new URL("https://api.github.com/search/issues?q=wallet+contractor"),
        minimumScore: 70,
        minimumBudgetUsd: 1000,
      },
    ],
  };
}

function setup(t, overrides = {}) {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  const store = new D1Store(db);
  const rpcVerifier = async () => ({
    transactionHash: TX_HASH,
    blockHash: `0x${"cd".repeat(32)}`,
    blockNumber: 100n,
    logIndex: 0n,
    confirmations: 6n,
    rpcAgreement: 2,
  });
  return {
    store,
    app: createApp({
      store,
      config: configuration(),
      clock: () => new Date("2026-09-02T00:00:00.000Z"),
      rpcVerifier,
      tokenMetadataVerifier: async () => 6,
      ...overrides,
    }),
  };
}

function adminHeaders(extra = {}) {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    "content-type": "application/json",
    ...extra,
  };
}

function invoiceBody(overrides = {}) {
  return {
    offerCode: "reliability_diagnostic",
    amountUsdCents: 137_500,
    chainId: 46630,
    tokenSymbol: "USDC",
    payerAddress: PAYER,
    expiresAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

async function createInvoice(app, idempotencyKey = "client-diagnostic-0001", overrides = {}) {
  return app.fetch(
    new Request("https://revenue.example/v1/invoices", {
      method: "POST",
      headers: adminHeaders({ "idempotency-key": idempotencyKey }),
      body: JSON.stringify(invoiceBody(overrides)),
    }),
  );
}

test("exposes a minimal health endpoint with defensive headers", async (t) => {
  const { app } = setup(t);
  const response = await app.fetch(new Request("https://revenue.example/health"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "revenue-os" });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("requires admin authorization and validates invoice input", async (t) => {
  const { app } = setup(t);
  const unauthorized = await app.fetch(
    new Request("https://revenue.example/v1/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "client-diagnostic-0001" },
      body: JSON.stringify(invoiceBody()),
    }),
  );
  assert.equal(unauthorized.status, 401);

  const invalid = await createInvoice(app, "client-diagnostic-0002", { payerAddress: RECIPIENT });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_request" });
});

test("creates and safely replays one ERC-20 invoice", async (t) => {
  const { app } = setup(t);
  const response = await createInvoice(app);
  const created = await response.json();

  assert.equal(response.status, 201);
  assert.match(created.invoice.id, /^inv_[a-f0-9]{32}$/);
  assert.match(created.invoiceToken, /^ivt_[a-f0-9]{64}$/);
  assert.equal(created.invoice.status, "open");
  assert.equal(created.invoice.amountAtomic, "1375000000");
  assert.equal(
    created.paymentUri,
    `ethereum:${TOKEN}@46630/transfer?address=${RECIPIENT}&uint256=1375000000`,
  );
  assert.equal("requestFingerprint" in created.invoice, false);

  const replayResponse = await createInvoice(app);
  const replay = await replayResponse.json();
  assert.equal(replayResponse.status, 200);
  assert.equal(replay.invoice.id, created.invoice.id);
  assert.equal(replay.invoiceToken, created.invoiceToken);

  const conflict = await createInvoice(app, "client-diagnostic-0001", { amountUsdCents: 200_000 });
  assert.equal(conflict.status, 409);
});

test("checks configured token decimals before creating an invoice", async (t) => {
  let observed;
  const { app } = setup(t, {
    tokenMetadataVerifier: async (options) => {
      observed = options;
      return 6;
    },
  });

  const response = await createInvoice(app, "client-diagnostic-token-metadata");
  assert.equal(response.status, 201);
  assert.deepEqual(
    {
      chainId: observed.chainId,
      tokenAddress: observed.tokenAddress,
      expectedDecimals: observed.expectedDecimals,
      rpcUrls: observed.rpcUrls,
      rpcQuorum: observed.rpcQuorum,
    },
    {
      chainId: 46630,
      tokenAddress: TOKEN.toLowerCase(),
      expectedDecimals: 6,
      rpcUrls: ["https://rpc-a.example/", "https://rpc-b.example/"],
      rpcQuorum: 2,
    },
  );
});

test("uses invoice capability token for status and payment verification", async (t) => {
  let verifierCalls = 0;
  const { app } = setup(t, {
    rpcVerifier: async (options) => {
      verifierCalls += 1;
      assert.equal(options.invoice.payerAddress, PAYER);
      assert.equal(options.rpcQuorum, 2);
      return {
        transactionHash: TX_HASH,
        blockHash: `0x${"cd".repeat(32)}`,
        blockNumber: 100n,
        logIndex: 0n,
        confirmations: 6n,
        rpcAgreement: 2,
      };
    },
  });
  const created = await (await createInvoice(app)).json();
  const invoiceUrl = `https://revenue.example/v1/invoices/${created.invoice.id}`;

  const hidden = await app.fetch(new Request(invoiceUrl));
  assert.equal(hidden.status, 404);
  const visible = await app.fetch(
    new Request(invoiceUrl, { headers: { "x-invoice-token": created.invoiceToken } }),
  );
  assert.equal(visible.status, 200);

  const paidResponse = await app.fetch(
    new Request(`${invoiceUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-invoice-token": created.invoiceToken },
      body: JSON.stringify({ transactionHash: TX_HASH }),
    }),
  );
  const paid = await paidResponse.json();
  assert.equal(paidResponse.status, 200);
  assert.equal(paid.invoice.status, "paid");
  assert.equal(paid.allocations.reduce((sum, item) => sum + item.usdCents, 0), 137_500);
  assert.equal(verifierCalls, 1);

  const replay = await app.fetch(
    new Request(`${invoiceUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-invoice-token": created.invoiceToken },
      body: JSON.stringify({ transactionHash: TX_HASH }),
    }),
  );
  assert.equal(replay.status, 200);
  assert.equal(verifierCalls, 1);
});

test("reports only cleared onchain payments as received revenue", async (t) => {
  const { app } = setup(t);
  const before = await app.fetch(
    new Request("https://revenue.example/v1/revenue", { headers: adminHeaders() }),
  );
  assert.deepEqual(await before.json(), { receivedUsdCents: 0, payments: 0, allocations: [] });

  const created = await (await createInvoice(app)).json();
  await app.fetch(
    new Request(`https://revenue.example/v1/invoices/${created.invoice.id}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-invoice-token": created.invoiceToken },
      body: JSON.stringify({ transactionHash: TX_HASH }),
    }),
  );
  const after = await app.fetch(
    new Request("https://revenue.example/v1/revenue", { headers: adminHeaders() }),
  );
  assert.deepEqual(await after.json(), {
    receivedUsdCents: 137_500,
    payments: 1,
    allocations: [
      { key: "delivery_and_tools", usdCents: 6_875 },
      { key: "operating_reserve", usdCents: 13_750 },
      { key: "owner_available", usdCents: 82_500 },
      { key: "tax_reserve", usdCents: 34_375 },
    ],
  });
});

test("scheduled discovery stores current qualified public leads", async (t) => {
  const { app, store } = setup(t, {
    fetchFn: async () =>
      Response.json({
        items: [
          {
            id: 9001,
            html_url: "https://github.com/example/project/issues/9001",
            title: "Hiring contractor for wallet integration reliability",
            body: "Budget approved for settlement reconciliation work.",
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-01T00:00:00.000Z",
            user: { login: "example", type: "Organization" },
            labels: [{ name: "help wanted" }],
          },
        ],
      }),
  });

  const result = await app.scheduled();
  assert.equal(result.results[0].stored, 1);
  const stored = await store.getLead("wallet-work:9001");
  assert.equal(stored.status, "new");
  assert.ok(stored.score >= 70);
});

test("lists and advances leads through explicit authorized transitions", async (t) => {
  const { app, store } = setup(t);
  await store.upsertLead({
    source: "github-wallet-work",
    externalId: "42",
    evidenceUrl: "https://github.com/example/project/issues/42",
    title: "Hiring contractor for a wallet audit",
    description: "Budget approved.",
    author: "example",
    authorType: "Organization",
    labels: ["help wanted"],
    score: 90,
    scoreReasons: ["explicit_paid_intent", "domain_match"],
    status: "new",
    discoveredAt: "2026-09-02T00:00:00.000Z",
    lastVerifiedAt: "2026-09-02T00:00:00.000Z",
  });

  const hidden = await app.fetch(new Request("https://revenue.example/v1/leads"));
  assert.equal(hidden.status, 401);
  const listed = await app.fetch(
    new Request("https://revenue.example/v1/leads?status=new&limit=10", { headers: adminHeaders() }),
  );
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).leads[0].id, "github-wallet-work:42");

  const advanced = await app.fetch(
    new Request("https://revenue.example/v1/leads/github-wallet-work:42/status", {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ expectedStatus: "new", nextStatus: "qualified" }),
    }),
  );
  assert.equal(advanced.status, 200);
  assert.equal((await advanced.json()).lead.status, "qualified");
});

test("refuses linked invoices until the lead is contracted", async (t) => {
  const { app, store } = setup(t);
  await store.upsertLead({
    source: "github-wallet-work",
    externalId: "43",
    evidenceUrl: "https://github.com/example/project/issues/43",
    title: "Hiring contractor for a wallet audit",
    description: "Budget approved.",
    author: "example",
    authorType: "Organization",
    labels: ["help wanted"],
    score: 90,
    scoreReasons: ["explicit_paid_intent", "domain_match"],
    status: "new",
    discoveredAt: "2026-09-02T00:00:00.000Z",
    lastVerifiedAt: "2026-09-02T00:00:00.000Z",
  });

  const response = await createInvoice(app, "linked-before-contract", {
    leadId: "github-wallet-work:43",
  });
  assert.equal(response.status, 400);
  assert.equal(await store.getInvoice(await deriveInvoiceId(INVOICE_SECRET, "linked-before-contract")), null);
});

test("returns generic errors and rejects unsupported routes", async (t) => {
  const { app } = setup(t);
  const missing = await app.fetch(new Request("https://revenue.example/missing"));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });

  const wrongMethod = await app.fetch(
    new Request("https://revenue.example/health", { method: "POST" }),
  );
  assert.equal(wrongMethod.status, 405);
});

test("rejects malformed bodies and every unsupported invoice boundary", async (t) => {
  const { app } = setup(t);
  const badBodies = [
    new Request("https://revenue.example/v1/invoices", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "bad-body-0001" },
      body: "{}",
    }),
    new Request("https://revenue.example/v1/invoices", {
      method: "POST",
      headers: adminHeaders({ "idempotency-key": "bad-body-0002" }),
      body: "",
    }),
    new Request("https://revenue.example/v1/invoices", {
      method: "POST",
      headers: adminHeaders({ "idempotency-key": "bad-body-0003" }),
      body: "{",
    }),
    new Request("https://revenue.example/v1/invoices", {
      method: "POST",
      headers: adminHeaders({ "idempotency-key": "bad-body-0004" }),
      body: "[]",
    }),
    new Request("https://revenue.example/v1/invoices", {
      method: "POST",
      headers: adminHeaders({ "idempotency-key": "bad-body-0005", "content-length": "20000" }),
      body: "{}",
    }),
  ];
  for (const request of badBodies) {
    assert.equal((await app.fetch(request)).status, 400);
  }

  const invalidOverrides = [
    { offerCode: "BAD OFFER" },
    { amountUsdCents: 0 },
    { amountUsdCents: 100_000_001 },
    { chainId: "46630" },
    { chainId: 1 },
    { tokenSymbol: 1 },
    { tokenSymbol: "DAI" },
    { payerAddress: "bad" },
    { leadId: "bad lead id" },
    { leadId: "missing:lead" },
    { expiresAt: "not-a-date" },
    { expiresAt: "2026-09-01T00:00:00.000Z" },
    { expiresAt: "2026-10-03T00:00:00.000Z" },
  ];
  for (let index = 0; index < invalidOverrides.length; index += 1) {
    const response = await createInvoice(app, `invalid-boundary-${String(index).padStart(2, "0")}`, invalidOverrides[index]);
    assert.equal(response.status, 400, JSON.stringify(invalidOverrides[index]));
  }
});

test("expires unpaid invoices and maps payment verification failures generically", async (t) => {
  let now = new Date("2026-09-02T00:00:00.000Z");
  let verifierError = null;
  const { app } = setup(t, {
    clock: () => now,
    rpcVerifier: async () => {
      if (verifierError) throw verifierError;
      throw new Error("unexpected verifier call");
    },
  });

  const pendingInvoice = await (await createInvoice(app, "pending-invoice-01", { expiresAt: "2026-09-05T00:00:00.000Z" })).json();
  const verifyUrl = `https://revenue.example/v1/invoices/${pendingInvoice.invoice.id}/verify`;
  const verify = () =>
    app.fetch(
      new Request(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-invoice-token": pendingInvoice.invoiceToken },
        body: JSON.stringify({ transactionHash: TX_HASH }),
      }),
    );

  verifierError = new PaymentVerificationError("PAYMENT_PENDING", "pending");
  assert.equal((await verify()).status, 202);
  verifierError = new RpcVerificationError("RPC_QUORUM_NOT_REACHED", "unavailable");
  assert.equal((await verify()).status, 202);
  verifierError = new PaymentVerificationError("TRANSFER_NOT_FOUND", "wrong transfer");
  assert.equal((await verify()).status, 400);
  verifierError = new Error("internal detail must not escape");
  const internal = await verify();
  assert.equal(internal.status, 500);
  assert.deepEqual(await internal.json(), { error: "internal_error" });

  const expiring = await (await createInvoice(app, "expiring-invoice-01", { expiresAt: "2026-09-03T00:00:00.000Z" })).json();
  now = new Date("2026-09-04T00:00:00.000Z");
  const expired = await app.fetch(
    new Request(`https://revenue.example/v1/invoices/${expiring.invoice.id}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-invoice-token": expiring.invoiceToken },
      body: JSON.stringify({ transactionHash: TX_HASH }),
    }),
  );
  assert.equal(expired.status, 410);
});

test("loads only complete runtime configuration", () => {
  const payment = configuration().payment;
  const leadSources = configuration().leadSources.map((source) => ({
    ...source,
    url: source.url.toString(),
  }));
  const env = {
    ADMIN_TOKEN,
    INVOICE_TOKEN_SECRET: INVOICE_SECRET,
    PAYMENT_CONFIG_JSON: JSON.stringify(payment),
    ALLOCATION_POLICY_JSON: JSON.stringify(configuration().allocationPolicy),
    LEAD_SOURCES_JSON: JSON.stringify(leadSources),
  };
  const loaded = loadRuntimeConfig(env);
  assert.equal(loaded.githubToken, null);
  assert.equal(loaded.payment.chains[0].chainId, 46630);

  for (const invalid of [
    { ...env, ADMIN_TOKEN: "short" },
    { ...env, INVOICE_TOKEN_SECRET: "short" },
    { ...env, ALLOCATION_POLICY_JSON: "invalid" },
    { ...env, ALLOCATION_POLICY_JSON: "[]" },
  ]) {
    assert.throws(() => loadRuntimeConfig(invalid));
  }
});

test("rejects missing app dependencies", () => {
  assert.throws(() => createApp({ store: null, config: configuration() }));
  assert.throws(() => createApp({ store: {}, config: null }));
  assert.throws(() => createApp({ store: {}, config: configuration(), clock: null }));
  assert.throws(() => createApp({ store: {}, config: configuration(), rpcVerifier: null }));
});
