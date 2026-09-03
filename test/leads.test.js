import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGitHubIssue, scoreLead } from "../src/leads.js";

const NOW = new Date("2026-09-02T00:00:00.000Z");

function issue(overrides = {}) {
  return {
    id: 123,
    html_url: "https://github.com/example/project/issues/123",
    title: "Seeking contractor for wallet settlement retry failures",
    body: "We have budget for a fixed-scope reliability review of exchange reconciliation and idempotency before launch.",
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    user: { login: "project-team", type: "Organization" },
    labels: [{ name: "help wanted" }],
    ...overrides,
  };
}

test("normalizes a public GitHub issue into evidence-backed lead data", () => {
  assert.deepEqual(normalizeGitHubIssue(issue(), "github-wallet-search"), {
    source: "github-wallet-search",
    externalId: "123",
    evidenceUrl: "https://github.com/example/project/issues/123",
    title: "Seeking contractor for wallet settlement retry failures",
    description: "We have budget for a fixed-scope reliability review of exchange reconciliation and idempotency before launch.",
    author: "project-team",
    authorType: "Organization",
    labels: ["help wanted"],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
});

test("rejects pull requests, invalid URLs, and malformed records", () => {
  assert.equal(normalizeGitHubIssue(issue({ pull_request: {} }), "source"), null);
  assert.equal(normalizeGitHubIssue(issue({ html_url: "http://localhost/internal" }), "source"), null);
  assert.equal(normalizeGitHubIssue(issue({ id: null }), "source"), null);
  assert.equal(normalizeGitHubIssue(issue({ id: "123" }), "source"), null);
  assert.equal(normalizeGitHubIssue(issue({ title: "" }), "source"), null);
});

test("ranks recent explicit paid reliability work above generic issues", () => {
  const strong = scoreLead(normalizeGitHubIssue(issue(), "source"), NOW);
  const weak = scoreLead(
    normalizeGitHubIssue(
      issue({
        id: 124,
        title: "Documentation typo",
        body: "Please fix one word.",
        labels: [],
        created_at: "2025-01-01T00:00:00.000Z",
      }),
      "source",
    ),
    NOW,
  );

  assert.ok(strong.score >= 75, JSON.stringify(strong));
  assert.ok(weak.score < 30, JSON.stringify(weak));
  assert.ok(strong.reasons.includes("explicit_paid_intent"));
  assert.ok(strong.reasons.includes("domain_match"));
});

test("does not treat internal reward or payment design notes as buyer intent", () => {
  const internalRoadmap = scoreLead(
    normalizeGitHubIssue(
      issue({
        title: "Portable completion receipts",
        body: "Design a payment state machine and paid completion receipt for our own product roadmap.",
        labels: [],
      }),
      "source",
    ),
    NOW,
    { minimumBudgetUsd: 1_000 },
  );

  assert.ok(internalRoadmap.score < 70, JSON.stringify(internalRoadmap));
  assert.equal(internalRoadmap.reasons.includes("explicit_paid_intent"), false);
});

test("disqualifies requests for custody, private keys, spam, or guaranteed returns", () => {
  for (const body of [
    "Send us your private key to start",
    "You must take custody of production funds",
    "Guaranteed profit bot, mass DM every user",
  ]) {
    const result = scoreLead(normalizeGitHubIssue(issue({ body }), "source"), NOW);
    assert.equal(result.score, 0);
    assert.equal(result.disqualified, true);
  }
});

test("disqualifies vulnerability research and offensive security work", () => {
  for (const body of [
    "Paid bug bounty for finding a vulnerability",
    "Seeking a pentest and exploit development consultant",
    "Budget approved for a smart contract security audit",
  ]) {
    const result = scoreLead(normalizeGitHubIssue(issue({ body }), "source"), NOW);
    assert.deepEqual(result, {
      score: 0,
      reasons: ["security_research_excluded"],
      disqualified: true,
    });
  }
});

test("disqualifies bot mirrors and explicitly low-value opportunities", () => {
  const botLead = normalizeGitHubIssue(
    issue({ user: { login: "github-actions[bot]", type: "Bot" } }),
    "source",
  );
  assert.equal(botLead.authorType, "Bot");
  assert.deepEqual(scoreLead(botLead, NOW, { minimumBudgetUsd: 1_000 }), {
    score: 0,
    reasons: ["automated_or_mirrored_listing"],
    disqualified: true,
  });

  const mirrored = scoreLead(
    normalizeGitHubIssue(
      issue({ body: "<!-- agent-bounties/github-discovery-v1:start --> Solver reward: 6.00 USDC" }),
      "source",
    ),
    NOW,
    { minimumBudgetUsd: 1_000 },
  );
  assert.equal(mirrored.disqualified, true);
  assert.equal(mirrored.reasons[0], "automated_or_mirrored_listing");

  const lowValue = scoreLead(
    normalizeGitHubIssue(issue({ body: "Paid wallet integration with a 90 USDC budget." }), "source"),
    NOW,
    { minimumBudgetUsd: 1_000 },
  );
  assert.equal(lowValue.disqualified, true);
  assert.equal(lowValue.reasons[0], "explicit_value_below_floor");

  const viable = scoreLead(
    normalizeGitHubIssue(issue({ body: "Budget: $2,750 for a fixed-scope wallet reliability review." }), "source"),
    NOW,
    { minimumBudgetUsd: 1_000 },
  );
  assert.equal(viable.disqualified, false);
  assert.ok(viable.score >= 75);
});

test("rejects invalid timestamps and impossible future evidence", () => {
  const invalid = normalizeGitHubIssue(issue({ created_at: "not-a-date" }), "source");
  assert.equal(invalid, null);

  const future = scoreLead(
    normalizeGitHubIssue(issue({ created_at: "2026-10-01T00:00:00.000Z" }), "source"),
    NOW,
  );
  assert.equal(future.disqualified, true);
  assert.equal(future.score, 0);
});
