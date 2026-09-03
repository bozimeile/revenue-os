import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { D1Store, StoreConflictError } from "../src/store.js";
import { SqliteD1 } from "./helpers/sqlite-d1.js";

const schema = [
  await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"),
  await readFile(new URL("../migrations/0002_sales_integrity.sql", import.meta.url), "utf8"),
].join("\n");

function createStore(t) {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  return new D1Store(db);
}

function lead(overrides = {}) {
  return {
    source: "github-wallet-work",
    externalId: "123",
    evidenceUrl: "https://github.com/example/project/issues/123",
    title: "Wallet settlement audit",
    description: "Paid contractor needed",
    author: "example",
    authorType: "Organization",
    labels: ["help wanted"],
    score: 95,
    scoreReasons: ["explicit_paid_intent", "domain_match"],
    status: "new",
    discoveredAt: "2026-09-02T00:00:00.000Z",
    lastVerifiedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    id: "inv_11111111111111111111111111111111",
    requestFingerprint: "a".repeat(64),
    leadId: null,
    offerCode: "audit",
    amountUsdCents: 137_500,
    chainId: 46630,
    tokenSymbol: "USDC",
    tokenAddress: "0x1111111111111111111111111111111111111111",
    tokenDecimals: 6,
    amountAtomic: "1375000000",
    payerAddress: "0x2222222222222222222222222222222222222222",
    recipientAddress: "0x3333333333333333333333333333333333333333",
    minConfirmations: 6,
    status: "open",
    createdAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

test("upserts lead evidence without resetting sales progress", async (t) => {
  const store = createStore(t);
  assert.equal(await store.upsertLead(lead()), "inserted");
  const created = await store.getLead("github-wallet-work:123");
  assert.equal(created.status, "new");

  await store.transitionLead(created.id, "new", "qualified", "2026-09-02T01:00:00.000Z");
  assert.equal(await store.upsertLead(lead({ score: 100, title: "Updated title" })), "updated");
  const updated = await store.getLead(created.id);
  assert.equal(updated.status, "qualified");
  assert.equal(updated.score, 100);
  assert.equal(updated.title, "Updated title");
});

test("lists bounded leads and records status transitions atomically", async (t) => {
  const store = createStore(t);
  await store.upsertLead(lead());
  await store.upsertLead(lead({ externalId: "124", score: 75, title: "Other lead" }));

  const firstPage = await store.listLeads({ status: "new", limit: 1 });
  assert.equal(firstPage.length, 1);
  assert.equal(firstPage[0].score, 95);

  await store.transitionLead(
    "github-wallet-work:123",
    "new",
    "qualified",
    "2026-09-02T01:00:00.000Z",
  );
  const audit = await store.database
    .prepare("SELECT action, detail_json FROM audit_events WHERE entity_id = ?1")
    .bind("github-wallet-work:123")
    .all();
  assert.equal(audit.results.length, 1);
  assert.equal(audit.results[0].action, "status_changed");
  assert.deepEqual(JSON.parse(audit.results[0].detail_json), { from: "new", to: "qualified" });
});

test("requires a contracted lead and opens it atomically with a linked invoice", async (t) => {
  const store = createStore(t);
  await store.upsertLead(lead());

  await assert.rejects(() => store.createInvoice(invoice({ leadId: "github-wallet-work:123" })));
  const stillNew = await store.getLead("github-wallet-work:123");
  assert.equal(stillNew.status, "new");
  assert.equal(await store.getInvoice(invoice().id), null);

  await store.transitionLead("github-wallet-work:123", "new", "qualified", "2026-09-02T01:00:00.000Z");
  await store.transitionLead("github-wallet-work:123", "qualified", "drafted", "2026-09-02T01:01:00.000Z");
  await store.transitionLead("github-wallet-work:123", "drafted", "approved", "2026-09-02T01:02:00.000Z");
  await store.transitionLead("github-wallet-work:123", "approved", "sent", "2026-09-02T01:03:00.000Z");
  await store.transitionLead("github-wallet-work:123", "sent", "replied", "2026-09-02T01:04:00.000Z");
  await store.transitionLead("github-wallet-work:123", "replied", "proposal", "2026-09-02T01:05:00.000Z");
  await store.transitionLead("github-wallet-work:123", "proposal", "contracted", "2026-09-02T01:06:00.000Z");

  await store.createInvoice(invoice({ leadId: "github-wallet-work:123" }));
  const opened = await store.getLead("github-wallet-work:123");
  assert.equal(opened.status, "invoice_open");
});

test("creates an invoice idempotently and detects request conflicts", async (t) => {
  const store = createStore(t);
  const first = await store.createInvoice(invoice());
  const replay = await store.createInvoice(invoice());

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.invoice.id, first.invoice.id);
  await assert.rejects(
    () => store.createInvoice(invoice({ requestFingerprint: "b".repeat(64) })),
    (error) => error instanceof StoreConflictError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("atomically records one cleared payment and its full allocation", async (t) => {
  const store = createStore(t);
  await store.createInvoice(invoice());

  const paid = await store.markInvoicePaid({
    invoiceId: invoice().id,
    verification: {
      transactionHash: `0x${"ab".repeat(32)}`,
      blockHash: `0x${"cd".repeat(32)}`,
      blockNumber: 100n,
      logIndex: 0n,
      confirmations: 6n,
      rpcAgreement: 2,
    },
    allocations: [
      { key: "tax_reserve", bps: 2500, usdCents: 34_375 },
      { key: "owner_available", bps: 7500, usdCents: 103_125 },
    ],
    receivedAt: "2026-09-02T02:00:00.000Z",
  });

  assert.equal(paid.status, "paid");
  assert.equal(paid.paidAt, "2026-09-02T02:00:00.000Z");
  const ledger = await store.getRevenueSummary();
  assert.deepEqual(ledger, {
    receivedUsdCents: 137_500,
    payments: 1,
    allocations: [
      { key: "owner_available", usdCents: 103_125 },
      { key: "tax_reserve", usdCents: 34_375 },
    ],
  });
  const buckets = await store.getPaymentAllocations(paid.paidPaymentId);
  assert.equal(buckets.reduce((sum, item) => sum + item.usdCents, 0), 137_500);
});

test("cannot reuse one transfer log or pay an invoice twice", async (t) => {
  const store = createStore(t);
  const first = invoice();
  const second = invoice({
    id: "inv_22222222222222222222222222222222",
    requestFingerprint: "b".repeat(64),
  });
  await store.createInvoice(first);
  await store.createInvoice(second);
  const verification = {
    transactionHash: `0x${"ab".repeat(32)}`,
    blockHash: `0x${"cd".repeat(32)}`,
    blockNumber: 100n,
    logIndex: 0n,
    confirmations: 6n,
    rpcAgreement: 2,
  };
  const allocation = [{ key: "owner_available", bps: 10000, usdCents: 137_500 }];

  await store.markInvoicePaid({
    invoiceId: first.id,
    verification,
    allocations: allocation,
    receivedAt: "2026-09-02T02:00:00.000Z",
  });
  await assert.rejects(
    () =>
      store.markInvoicePaid({
        invoiceId: second.id,
        verification,
        allocations: allocation,
        receivedAt: "2026-09-02T02:01:00.000Z",
      }),
    (error) => error instanceof StoreConflictError,
  );
  await assert.rejects(
    () =>
      store.markInvoicePaid({
        invoiceId: first.id,
        verification: { ...verification, logIndex: 1n },
        allocations: allocation,
        receivedAt: "2026-09-02T02:02:00.000Z",
      }),
    (error) => error instanceof StoreConflictError,
  );
});

test("expires only an open invoice and rejects unreconciled allocations", async (t) => {
  const store = createStore(t);
  await store.createInvoice(invoice());
  const expired = await store.markInvoiceExpired(invoice().id, "2026-09-10T00:00:00.000Z");
  assert.equal(expired.status, "expired");
  await assert.rejects(
    () => store.markInvoiceExpired(invoice().id, "2026-09-10T00:00:00.000Z"),
    (error) => error instanceof StoreConflictError && error.code === "INVOICE_STATE_CONFLICT",
  );

  const open = invoice({ id: "inv_33333333333333333333333333333333", requestFingerprint: "c".repeat(64) });
  await store.createInvoice(open);
  await assert.rejects(() =>
    store.markInvoicePaid({
      invoiceId: open.id,
      verification: {
        transactionHash: `0x${"ab".repeat(32)}`,
        blockHash: `0x${"cd".repeat(32)}`,
        blockNumber: 100n,
        logIndex: 0n,
        confirmations: 6n,
        rpcAgreement: 2,
      },
      allocations: [{ key: "owner_available", bps: 10_000, usdCents: 1 }],
      receivedAt: "2026-09-02T02:00:00.000Z",
    }),
  );
});
