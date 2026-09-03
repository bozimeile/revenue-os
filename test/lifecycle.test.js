import assert from "node:assert/strict";
import test from "node:test";

import { assertLeadTransition, nextLeadStatuses } from "../src/lifecycle.js";

test("supports the complete lead-to-cleared-payment lifecycle", () => {
  const path = [
    "new",
    "qualified",
    "drafted",
    "approved",
    "sent",
    "replied",
    "proposal",
    "contracted",
    "invoice_open",
    "paid",
    "delivering",
    "delivered",
    "closed",
  ];

  for (let index = 0; index < path.length - 1; index += 1) {
    assert.doesNotThrow(() => assertLeadTransition(path[index], path[index + 1]));
  }
});

test("exposes explicit loss, disqualification, expiry, and no-response exits", () => {
  assert.deepEqual(nextLeadStatuses("new"), ["qualified", "disqualified"]);
  assert.ok(nextLeadStatuses("sent").includes("no_response"));
  assert.ok(nextLeadStatuses("proposal").includes("lost"));
  assert.ok(nextLeadStatuses("invoice_open").includes("expired"));
});

test("rejects skipped, reverse, unknown, and terminal-state transitions", () => {
  for (const [from, to] of [
    ["new", "paid"],
    ["paid", "invoice_open"],
    ["closed", "new"],
    ["missing", "qualified"],
    ["new", "missing"],
  ]) {
    assert.throws(() => assertLeadTransition(from, to));
  }
});
