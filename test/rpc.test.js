import assert from "node:assert/strict";
import test from "node:test";

import { TRANSFER_TOPIC } from "../src/payment.js";
import {
  RpcVerificationError,
  verifyPaymentWithRpcQuorum,
  verifyTokenDecimalsWithRpcQuorum,
} from "../src/rpc.js";

const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"ef".repeat(32)}`;
const TOKEN = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function topicAddress(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function receipt(blockHash = BLOCK_HASH) {
  return {
    transactionHash: TX_HASH,
    status: "0x1",
    blockNumber: "0x64",
    blockHash,
    logs: [
      {
        address: TOKEN,
        topics: [TRANSFER_TOPIC, topicAddress(PAYER), topicAddress(RECIPIENT)],
        data: `0x${2_750_000_000n.toString(16).padStart(64, "0")}`,
        logIndex: "0x0",
      },
    ],
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

function rpcFetch(responsesByUrl) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    const value = responsesByUrl[url]?.[request.method];
    if (value instanceof Error) {
      throw value;
    }
    if (value === undefined) {
      return new Response("missing", { status: 500 });
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result: value });
  };
}

function healthy(blockHash = BLOCK_HASH) {
  return {
    eth_chainId: "0xb626",
    eth_getTransactionReceipt: receipt(blockHash),
    eth_blockNumber: "0x69",
    eth_getBlockByNumber: { hash: blockHash, number: "0x64" },
  };
}

function decimalsWord(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

test("confirms token decimals with an RPC quorum and caches by chain and token", async () => {
  let calls = 0;
  const fetchFn = async (_url, init) => {
    calls += 1;
    const request = JSON.parse(init.body);
    const result = request.method === "eth_chainId" ? "0xb626" : decimalsWord(6);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  const options = {
    chainId: 46630,
    tokenAddress: TOKEN,
    expectedDecimals: 6,
    rpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
    rpcQuorum: 2,
    fetchFn,
    now: 1_000,
  };

  assert.equal(await verifyTokenDecimalsWithRpcQuorum(options), 6);
  assert.equal(calls, 4);
  assert.equal(await verifyTokenDecimalsWithRpcQuorum({ ...options, now: 2_000 }), 6);
  assert.equal(calls, 4);
});

test("rejects token decimal mismatches and missing metadata quorum", async () => {
  const makeFetch = (decimalsByUrl) => async (url, init) => {
    const request = JSON.parse(init.body);
    const result = request.method === "eth_chainId" ? "0x1" : decimalsWord(decimalsByUrl[url]);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };

  await assert.rejects(
    () =>
      verifyTokenDecimalsWithRpcQuorum({
        chainId: 1,
        tokenAddress: TOKEN,
        expectedDecimals: 18,
        rpcUrls: ["https://rpc-c.example", "https://rpc-d.example"],
        rpcQuorum: 2,
        fetchFn: makeFetch({ "https://rpc-c.example": 6, "https://rpc-d.example": 6 }),
      }),
    (error) => error instanceof RpcVerificationError && error.code === "TOKEN_DECIMALS_MISMATCH",
  );

  await assert.rejects(
    () =>
      verifyTokenDecimalsWithRpcQuorum({
        chainId: 1,
        tokenAddress: "0x4444444444444444444444444444444444444444",
        expectedDecimals: 6,
        rpcUrls: ["https://rpc-e.example", "https://rpc-f.example"],
        rpcQuorum: 2,
        fetchFn: makeFetch({ "https://rpc-e.example": 6, "https://rpc-f.example": 18 }),
      }),
    (error) => error instanceof RpcVerificationError && error.code === "TOKEN_METADATA_QUORUM_NOT_REACHED",
  );
});

test("requires matching confirmation from the configured public RPC quorum", async () => {
  const result = await verifyPaymentWithRpcQuorum({
    invoice,
    txHash: TX_HASH,
    rpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
    rpcQuorum: 2,
    fetchFn: rpcFetch({
      "https://rpc-a.example": healthy(),
      "https://rpc-b.example": healthy(),
    }),
  });

  assert.equal(result.transactionHash, TX_HASH);
  assert.equal(result.confirmations, 6n);
  assert.equal(result.rpcAgreement, 2);
});

test("fails closed when RPCs disagree or the quorum is unavailable", async () => {
  const cases = [
    {
      a: healthy(),
      b: healthy(OTHER_BLOCK_HASH),
    },
    {
      a: healthy(),
      b: { ...healthy(), eth_chainId: "0x1" },
    },
    {
      a: healthy(),
      b: { ...healthy(), eth_getTransactionReceipt: new Error("timeout") },
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      () =>
        verifyPaymentWithRpcQuorum({
          invoice,
          txHash: TX_HASH,
          rpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
          rpcQuorum: 2,
          fetchFn: rpcFetch({
            "https://rpc-a.example": item.a,
            "https://rpc-b.example": item.b,
          }),
        }),
      (error) => error instanceof RpcVerificationError && error.code === "RPC_QUORUM_NOT_REACHED",
    );
  }
});

test("fails closed when an RPC returns an oversized JSON body", async () => {
  await assert.rejects(
    () =>
      verifyPaymentWithRpcQuorum({
        invoice,
        txHash: TX_HASH,
        rpcUrls: ["https://rpc-a.example"],
        rpcQuorum: 1,
        fetchFn: async () =>
          new Response(JSON.stringify({ value: "x".repeat(1_000_000) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    (error) => error instanceof RpcVerificationError && error.code === "RPC_QUORUM_NOT_REACHED",
  );
});

test("rejects an invalid quorum before making network requests", async () => {
  let called = false;
  await assert.rejects(() =>
    verifyPaymentWithRpcQuorum({
      invoice,
      txHash: TX_HASH,
      rpcUrls: ["https://rpc-a.example"],
      rpcQuorum: 2,
      fetchFn: async () => {
        called = true;
      },
    }),
  );
  assert.equal(called, false);
});
