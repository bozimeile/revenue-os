import assert from "node:assert/strict";
import test from "node:test";

import {
  PaymentVerificationError,
  TRANSFER_TOPIC,
  parseAtomicAmount,
  verifyTransferReceipt,
} from "../src/payment.js";

const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const TOKEN = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function topicAddress(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function uint256(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function validReceipt(overrides = {}) {
  return {
    transactionHash: TX_HASH,
    status: "0x1",
    blockNumber: "0x64",
    blockHash: BLOCK_HASH,
    logs: [
      {
        address: TOKEN,
        topics: [TRANSFER_TOPIC, topicAddress(PAYER), topicAddress(RECIPIENT)],
        data: uint256(2_750_000_000n),
        logIndex: "0x0",
      },
    ],
    ...overrides,
  };
}

const invoice = {
  chainId: 46630,
  tokenAddress: TOKEN,
  payerAddress: PAYER,
  recipientAddress: RECIPIENT,
  amountAtomic: "2750000000",
  minConfirmations: 6,
};

test("parses decimal prices without floating point", () => {
  assert.equal(parseAtomicAmount("2750", 6), 2_750_000_000n);
  assert.equal(parseAtomicAmount("2750.25", 6), 2_750_250_000n);
  assert.equal(parseAtomicAmount("0.000001", 6), 1n);
});

test("rejects unsafe or ambiguous decimal prices", () => {
  for (const value of ["", "-1", "+1", "1e3", "1.0000001", ".5", "01.0"]) {
    assert.throws(() => parseAtomicAmount(value, 6));
  }
  assert.throws(() => parseAtomicAmount("1", -1));
  assert.throws(() => parseAtomicAmount("1", 256));
  assert.throws(() => parseAtomicAmount(1, 6));
  assert.throws(() => parseAtomicAmount((1n << 256n).toString(), 0));
});

test("confirms one exact canonical ERC-20 transfer", () => {
  const result = verifyTransferReceipt({
    invoice,
    requestedTxHash: TX_HASH,
    receipt: validReceipt(),
    canonicalBlockHash: BLOCK_HASH,
    latestBlockNumber: 105n,
  });

  assert.deepEqual(result, {
    transactionHash: TX_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: 100n,
    logIndex: 0n,
    confirmations: 6n,
  });
});

test("fails closed for pending, reverted, non-canonical, and underconfirmed receipts", () => {
  const cases = [
    { receipt: null, code: "PAYMENT_PENDING" },
    { receipt: validReceipt({ status: "0x0" }), code: "TRANSACTION_REVERTED" },
    { receipt: validReceipt(), canonicalBlockHash: `0x${"ef".repeat(32)}`, code: "NON_CANONICAL_BLOCK" },
    { receipt: validReceipt(), latestBlockNumber: 104n, code: "INSUFFICIENT_CONFIRMATIONS" },
  ];

  for (const item of cases) {
    assert.throws(
      () =>
        verifyTransferReceipt({
          invoice,
          requestedTxHash: TX_HASH,
          receipt: item.receipt,
          canonicalBlockHash: item.canonicalBlockHash ?? BLOCK_HASH,
          latestBlockNumber: item.latestBlockNumber ?? 105n,
        }),
      (error) => error instanceof PaymentVerificationError && error.code === item.code,
    );
  }
});

test("rejects a receipt or transfer that does not match every invoice field", () => {
  const otherAddress = "0x4444444444444444444444444444444444444444";
  const cases = [
    { receipt: validReceipt({ transactionHash: `0x${"12".repeat(32)}` }), code: "TX_HASH_MISMATCH" },
    { receipt: validReceipt({ logs: [] }), code: "TRANSFER_NOT_FOUND" },
    {
      receipt: validReceipt({ logs: [{ ...validReceipt().logs[0], address: otherAddress }] }),
      code: "TRANSFER_NOT_FOUND",
    },
    {
      receipt: validReceipt({
        logs: [{ ...validReceipt().logs[0], topics: [TRANSFER_TOPIC, topicAddress(otherAddress), topicAddress(RECIPIENT)] }],
      }),
      code: "TRANSFER_NOT_FOUND",
    },
    {
      receipt: validReceipt({
        logs: [{ ...validReceipt().logs[0], topics: [TRANSFER_TOPIC, topicAddress(PAYER), topicAddress(otherAddress)] }],
      }),
      code: "TRANSFER_NOT_FOUND",
    },
    {
      receipt: validReceipt({ logs: [{ ...validReceipt().logs[0], data: uint256(2_749_999_999n) }] }),
      code: "TRANSFER_NOT_FOUND",
    },
  ];

  for (const item of cases) {
    assert.throws(
      () =>
        verifyTransferReceipt({
          invoice,
          requestedTxHash: TX_HASH,
          receipt: item.receipt,
          canonicalBlockHash: BLOCK_HASH,
          latestBlockNumber: 105n,
        }),
      (error) => error instanceof PaymentVerificationError && error.code === item.code,
    );
  }
});

test("rejects malformed RPC data instead of guessing", () => {
  const cases = [
    validReceipt({ blockNumber: "100" }),
    validReceipt({ logs: [{ ...validReceipt().logs[0], data: "0x1" }] }),
    validReceipt({ logs: [{ ...validReceipt().logs[0], topics: [TRANSFER_TOPIC] }] }),
    validReceipt({ logs: "not-an-array" }),
  ];

  for (const receipt of cases) {
    assert.throws(
      () =>
        verifyTransferReceipt({
          invoice,
          requestedTxHash: TX_HASH,
          receipt,
          canonicalBlockHash: BLOCK_HASH,
          latestBlockNumber: 105n,
        }),
      (error) => error instanceof PaymentVerificationError,
    );
  }
});

test("rejects every malformed receipt envelope and invoice boundary", () => {
  const UINT256_OVERFLOW = (1n << 256n).toString();
  const cases = [
    { invoice: null, code: "INVALID_INVOICE" },
    { requestedTxHash: "0x1", code: "INVALID_TRANSACTION_HASH" },
    { receipt: [], code: "MALFORMED_RPC_RESPONSE" },
    { receipt: validReceipt({ status: "0x2" }), code: "MALFORMED_RPC_RESPONSE" },
    { receipt: validReceipt({ transactionHash: "0x1" }), code: "MALFORMED_RPC_RESPONSE" },
    { receipt: validReceipt({ blockHash: "0x1" }), code: "MALFORMED_RPC_RESPONSE" },
    { canonicalBlockHash: "0x1", code: "MALFORMED_RPC_RESPONSE" },
    { latestBlockNumber: 99n, code: "MALFORMED_RPC_RESPONSE" },
    { invoice: { ...invoice, minConfirmations: 0 }, code: "INVALID_INVOICE" },
    { invoice: { ...invoice, tokenAddress: "bad" }, code: "INVALID_INVOICE" },
    { invoice: { ...invoice, payerAddress: "bad" }, code: "INVALID_INVOICE" },
    { invoice: { ...invoice, recipientAddress: "bad" }, code: "INVALID_INVOICE" },
    { invoice: { ...invoice, amountAtomic: "01" }, code: "INVALID_INVOICE" },
    { invoice: { ...invoice, amountAtomic: "0" }, code: "INVALID_INVOICE" },
    { invoice: { ...invoice, amountAtomic: UINT256_OVERFLOW }, code: "INVALID_INVOICE" },
    { receipt: validReceipt({ logs: [null] }), code: "MALFORMED_RPC_RESPONSE" },
    {
      receipt: validReceipt({ logs: [{ ...validReceipt().logs[0], topics: null }] }),
      code: "MALFORMED_RPC_RESPONSE",
    },
    {
      receipt: validReceipt({ logs: [{ ...validReceipt().logs[0], topics: [TRANSFER_TOPIC, "0x1", topicAddress(RECIPIENT)] }] }),
      code: "MALFORMED_RPC_RESPONSE",
    },
    {
      receipt: validReceipt({ logs: [{ ...validReceipt().logs[0], logIndex: "00" }] }),
      code: "MALFORMED_RPC_RESPONSE",
    },
  ];

  for (const item of cases) {
    assert.throws(
      () =>
        verifyTransferReceipt({
          invoice: item.invoice === undefined ? invoice : item.invoice,
          requestedTxHash: item.requestedTxHash ?? TX_HASH,
          receipt: item.receipt ?? validReceipt(),
          canonicalBlockHash: item.canonicalBlockHash ?? BLOCK_HASH,
          latestBlockNumber: item.latestBlockNumber ?? 105n,
        }),
      (error) => error instanceof PaymentVerificationError && error.code === item.code,
      item.code,
    );
  }
});

test("rejects multiple exact transfer logs as ambiguous", () => {
  const matching = validReceipt().logs[0];
  assert.throws(
    () =>
      verifyTransferReceipt({
        invoice,
        requestedTxHash: TX_HASH,
        receipt: validReceipt({ logs: [matching, { ...matching, logIndex: "0x1" }] }),
        canonicalBlockHash: BLOCK_HASH,
        latestBlockNumber: 105n,
      }),
    (error) => error instanceof PaymentVerificationError && error.code === "AMBIGUOUS_TRANSFER",
  );
});
