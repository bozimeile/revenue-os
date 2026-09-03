const TOTAL_BASIS_POINTS = 10_000;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function validateAllocationPolicy(policy) {
  if (!Array.isArray(policy) || policy.length === 0 || policy.length > 20) {
    throw new TypeError("allocation policy must contain between 1 and 20 buckets");
  }

  const seen = new Set();
  let total = 0;
  const validated = policy.map((item) => {
    if (!item || typeof item !== "object" || !KEY_PATTERN.test(item.key)) {
      throw new TypeError("allocation keys must use lower snake case");
    }
    if (seen.has(item.key)) {
      throw new TypeError(`duplicate allocation key: ${item.key}`);
    }
    if (!Number.isInteger(item.bps) || item.bps <= 0 || item.bps > TOTAL_BASIS_POINTS) {
      throw new TypeError(`invalid basis points for ${item.key}`);
    }

    seen.add(item.key);
    total += item.bps;
    return { key: item.key, bps: item.bps };
  });

  if (total !== TOTAL_BASIS_POINTS) {
    throw new TypeError(`allocation policy must total ${TOTAL_BASIS_POINTS} basis points`);
  }

  return validated;
}

export function allocateUsdCents(totalUsdCents, policy) {
  if (!Number.isSafeInteger(totalUsdCents) || totalUsdCents < 0) {
    throw new TypeError("received amount must be a non-negative safe integer in USD cents");
  }

  const validated = validateAllocationPolicy(policy);
  const total = BigInt(totalUsdCents);
  const divisor = BigInt(TOTAL_BASIS_POINTS);
  const working = validated.map((item, index) => {
    const numerator = total * BigInt(item.bps);
    return {
      ...item,
      index,
      usdCents: Number(numerator / divisor),
      remainder: numerator % divisor,
    };
  });

  let unallocated = totalUsdCents - working.reduce((sum, item) => sum + item.usdCents, 0);
  const remainderOrder = [...working].sort(
    (left, right) => Number(right.remainder - left.remainder) || left.index - right.index,
  );
  for (let index = 0; index < unallocated; index += 1) {
    remainderOrder[index].usdCents += 1;
  }

  return working.map(({ key, bps, usdCents }) => ({ key, bps, usdCents }));
}
