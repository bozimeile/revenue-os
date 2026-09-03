import assert from "node:assert/strict";
import test from "node:test";

import { parseLeadSources, parsePaymentConfig, validatePublicHttpsUrl } from "../src/config.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function paymentConfig(overrides = {}) {
  return JSON.stringify({
    chains: [
      {
        chainId: 46630,
        rpcUrls: ["https://rpc-a.example/rpc", "https://rpc-b.example/rpc"],
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
        ...overrides,
      },
    ],
  });
}

test("parses a bounded multi-RPC payment allowlist", () => {
  const result = parsePaymentConfig(paymentConfig());

  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0].chainId, 46630);
  assert.equal(result.chains[0].rpcQuorum, 2);
  assert.equal(result.chains[0].tokens[0].symbol, "USDC");
  assert.equal(result.chains[0].tokens[0].address, TOKEN);
});

test("rejects unsafe RPC destinations, credentials, duplicates, and invalid quorum", () => {
  for (const url of [
    "http://rpc.example",
    "https://localhost/rpc",
    "https://127.0.0.1/rpc",
    "https://10.0.0.1/rpc",
    "https://user:pass@rpc.example/rpc",
    "ftp://rpc.example/rpc",
  ]) {
    assert.throws(() => validatePublicHttpsUrl(url));
  }

  assert.throws(() => parsePaymentConfig(paymentConfig({ rpcQuorum: 3 })));
  assert.throws(() =>
    parsePaymentConfig(paymentConfig({ rpcUrls: ["https://rpc.example", "https://rpc.example/"] })),
  );
  assert.throws(() =>
    parsePaymentConfig(
      paymentConfig({ rpcUrls: ["https://rpc.example/primary", "https://rpc.example/secondary"] }),
    ),
  );
  assert.throws(() => parsePaymentConfig(paymentConfig({ chainId: 0 })));
});

test("rejects duplicate tokens and invalid token metadata", () => {
  const token = JSON.parse(paymentConfig()).chains[0].tokens[0];
  assert.throws(() => parsePaymentConfig(paymentConfig({ tokens: [token, token] })));
  assert.throws(() => parsePaymentConfig(paymentConfig({ tokens: [{ ...token, decimals: 256 }] })));
  assert.throws(() => parsePaymentConfig(paymentConfig({ tokens: [{ ...token, symbol: "usd c" }] })));
  assert.throws(() => parsePaymentConfig(paymentConfig({ tokens: [{ ...token, recipient: TOKEN }] })));
});

test("parses only bounded GitHub issue search sources", () => {
  const sources = parseLeadSources(
    JSON.stringify([
      {
        name: "wallet-work",
        url: "https://api.github.com/search/issues?q=wallet+contractor+is%3Aissue+is%3Aopen",
        minimumScore: 70,
        minimumBudgetUsd: 1000,
      },
    ]),
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].minimumScore, 70);
  assert.equal(sources[0].minimumBudgetUsd, 1000);
  assert.equal(sources[0].url.hostname, "api.github.com");
  assert.throws(() =>
    parseLeadSources(
      JSON.stringify([{ name: "bad", url: "https://example.com/search", minimumScore: 50 }]),
    ),
  );
  assert.throws(() => parseLeadSources(JSON.stringify(new Array(6).fill(sources[0]))));
  assert.throws(() =>
    parseLeadSources(
      JSON.stringify([
        {
          name: "bad-budget",
          url: "https://api.github.com/search/issues?q=wallet",
          minimumScore: 70,
          minimumBudgetUsd: -1,
        },
      ]),
    ),
  );
});
