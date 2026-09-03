import assert from "node:assert/strict";
import test from "node:test";

import { allocateUsdCents, validateAllocationPolicy } from "../src/allocation.js";

const policy = [
  { key: "tax_reserve", bps: 2500 },
  { key: "operating_reserve", bps: 1000 },
  { key: "delivery_and_tools", bps: 500 },
  { key: "owner_available", bps: 6000 },
];

test("validates an exact 100 percent allocation policy", () => {
  assert.deepEqual(validateAllocationPolicy(policy), policy);
});

test("rejects malformed, duplicate, and incomplete policies", () => {
  assert.throws(() => validateAllocationPolicy([]));
  assert.throws(() => validateAllocationPolicy([{ key: "owner", bps: 9999 }]));
  assert.throws(() => validateAllocationPolicy([{ key: "owner", bps: 10001 }]));
  assert.throws(() =>
    validateAllocationPolicy([
      { key: "same", bps: 5000 },
      { key: "same", bps: 5000 },
    ]),
  );
  assert.throws(() => validateAllocationPolicy([{ key: "bad key", bps: 10000 }]));
});

test("allocates cents exactly without losing rounding remainders", () => {
  const allocations = allocateUsdCents(137_500, policy);

  assert.deepEqual(allocations, [
    { key: "tax_reserve", bps: 2500, usdCents: 34_375 },
    { key: "operating_reserve", bps: 1000, usdCents: 13_750 },
    { key: "delivery_and_tools", bps: 500, usdCents: 6_875 },
    { key: "owner_available", bps: 6000, usdCents: 82_500 },
  ]);
  assert.equal(allocations.reduce((sum, item) => sum + item.usdCents, 0), 137_500);
});

test("uses deterministic largest-remainder allocation for indivisible cents", () => {
  assert.deepEqual(
    allocateUsdCents(1, [
      { key: "first", bps: 5000 },
      { key: "second", bps: 5000 },
    ]),
    [
      { key: "first", bps: 5000, usdCents: 1 },
      { key: "second", bps: 5000, usdCents: 0 },
    ],
  );
});

test("rejects non-integer or negative received amounts", () => {
  for (const amount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => allocateUsdCents(amount, policy));
  }
});
