import assert from "node:assert/strict";
import test from "node:test";

import { discoverGitHubSource, runLeadDiscovery } from "../src/discovery.js";

const NOW = new Date("2026-09-02T00:00:00.000Z");

function issue(id, overrides = {}) {
  return {
    id,
    html_url: `https://github.com/example/project/issues/${id}`,
    title: "Hiring contractor for wallet settlement reliability",
    body: "Budget approved for exchange reconciliation and retry hardening.",
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    user: { login: "example", type: "Organization" },
    labels: [{ name: "help wanted" }],
    ...overrides,
  };
}

test("discovers, scores, and stores only qualifying issue leads", async () => {
  const stored = [];
  const result = await discoverGitHubSource({
    source: {
      name: "wallet-work",
      url: new URL("https://api.github.com/search/issues?q=wallet+contractor"),
      minimumScore: 70,
      minimumBudgetUsd: 1000,
    },
    now: NOW,
    fetchFn: async () => Response.json({ items: [issue(1), issue(2, { title: "Typo", body: "Fix docs", labels: [] })] }),
    store: {
      async upsertLead(lead) {
        stored.push(lead);
        return "inserted";
      },
    },
  });

  assert.deepEqual(result, { source: "wallet-work", seen: 2, qualified: 1, stored: 1 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "new");
  assert.ok(stored[0].score >= 70);
});

test("bounds response size and rejects non-JSON or failed source responses", async () => {
  const oversized = new Array(31).fill(null).map((_, index) => issue(index + 1));
  for (const response of [
    new Response("error", { status: 500 }),
    new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    new Response(JSON.stringify({ items: [], padding: "x".repeat(1_000_000) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    Response.json({ items: oversized }),
  ]) {
    await assert.rejects(() =>
      discoverGitHubSource({
        source: {
          name: "wallet-work",
          url: new URL("https://api.github.com/search/issues?q=wallet"),
          minimumScore: 70,
          minimumBudgetUsd: 1000,
        },
        now: NOW,
        fetchFn: async () => response,
        store: { upsertLead: async () => "inserted" },
      }),
    );
  }
});

test("isolates source failures while preserving evidence from healthy sources", async () => {
  const stored = [];
  const result = await runLeadDiscovery({
    sources: [
      {
        name: "healthy",
        url: new URL("https://api.github.com/search/issues?q=wallet"),
        minimumScore: 70,
        minimumBudgetUsd: 1000,
      },
      {
        name: "broken",
        url: new URL("https://api.github.com/search/issues?q=broken"),
        minimumScore: 70,
        minimumBudgetUsd: 1000,
      },
    ],
    now: NOW,
    fetchFn: async (url) => {
      if (url.includes("broken")) {
        throw new Error("network down");
      }
      return Response.json({ items: [issue(1)] });
    },
    store: {
      async upsertLead(lead) {
        stored.push(lead);
        return "inserted";
      },
    },
  });

  assert.equal(stored.length, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0], { source: "broken", error: "source_failed" });
});
