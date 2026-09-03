import { PaymentVerificationError, verifyTransferReceipt } from "./payment.js";
import { readBoundedJsonResponse } from "./http.js";

const RPC_TIMEOUT_MS = 8_000;
const MAX_RPC_RESPONSE_BYTES = 1_000_000;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ABI_WORD_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMALS_SELECTOR = "0x313ce567";
const TOKEN_DECIMALS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const tokenDecimalsCache = new Map();

export class RpcVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RpcVerificationError";
    this.code = code;
  }
}

async function rpcCall(fetchFn, rpcUrl, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const id = `${method}:1`;
    const response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      throw new Error("RPC returned a non-JSON response");
    }
    const payload = await readBoundedJsonResponse(response, MAX_RPC_RESPONSE_BYTES);
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== id || payload.error || !("result" in payload)) {
      throw new Error("malformed JSON-RPC response");
    }
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyWithEndpoint({ invoice, txHash, rpcUrl, fetchFn }) {
  const [chainIdValue, receipt, latestBlockValue] = await Promise.all([
    rpcCall(fetchFn, rpcUrl, "eth_chainId", []),
    rpcCall(fetchFn, rpcUrl, "eth_getTransactionReceipt", [txHash]),
    rpcCall(fetchFn, rpcUrl, "eth_blockNumber", []),
  ]);
  if (!QUANTITY_PATTERN.test(chainIdValue) || BigInt(chainIdValue) !== BigInt(invoice.chainId)) {
    throw new RpcVerificationError("WRONG_CHAIN", "RPC endpoint returned the wrong chain ID");
  }
  if (!QUANTITY_PATTERN.test(latestBlockValue)) {
    throw new RpcVerificationError("MALFORMED_RPC", "RPC endpoint returned an invalid block number");
  }
  if (!receipt || typeof receipt.blockNumber !== "string") {
    if (receipt === null) {
      throw new PaymentVerificationError("PAYMENT_PENDING", "transaction receipt is pending");
    }
    throw new RpcVerificationError("MALFORMED_RPC", "RPC endpoint returned an invalid receipt");
  }

  const canonicalBlock = await rpcCall(fetchFn, rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!canonicalBlock || typeof canonicalBlock.hash !== "string" || canonicalBlock.number !== receipt.blockNumber) {
    throw new RpcVerificationError("MALFORMED_RPC", "RPC endpoint returned an invalid canonical block");
  }

  return verifyTransferReceipt({
    invoice,
    requestedTxHash: txHash,
    receipt,
    canonicalBlockHash: canonicalBlock.hash,
    latestBlockNumber: BigInt(latestBlockValue),
  });
}

async function tokenDecimalsWithEndpoint({ chainId, tokenAddress, rpcUrl, fetchFn }) {
  const [chainIdValue, decimalsValue] = await Promise.all([
    rpcCall(fetchFn, rpcUrl, "eth_chainId", []),
    rpcCall(fetchFn, rpcUrl, "eth_call", [{ to: tokenAddress, data: DECIMALS_SELECTOR }, "latest"]),
  ]);
  if (!QUANTITY_PATTERN.test(chainIdValue) || BigInt(chainIdValue) !== BigInt(chainId)) {
    throw new RpcVerificationError("WRONG_CHAIN", "RPC endpoint returned the wrong chain ID");
  }
  if (!ABI_WORD_PATTERN.test(decimalsValue)) {
    throw new RpcVerificationError("MALFORMED_RPC", "token decimals response is invalid");
  }
  const decimals = BigInt(decimalsValue);
  if (decimals > 255n) {
    throw new RpcVerificationError("MALFORMED_RPC", "token decimals are outside uint8 range");
  }
  return Number(decimals);
}

export async function verifyTokenDecimalsWithRpcQuorum({
  chainId,
  tokenAddress,
  expectedDecimals,
  rpcUrls,
  rpcQuorum,
  fetchFn = fetch,
  now = Date.now(),
}) {
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    typeof tokenAddress !== "string" ||
    !Number.isInteger(expectedDecimals) ||
    expectedDecimals < 0 ||
    expectedDecimals > 255 ||
    !Array.isArray(rpcUrls) ||
    rpcUrls.length === 0 ||
    rpcUrls.length > 3 ||
    !Number.isInteger(rpcQuorum) ||
    rpcQuorum <= 0 ||
    rpcQuorum > rpcUrls.length ||
    typeof fetchFn !== "function" ||
    !Number.isFinite(now)
  ) {
    throw new TypeError("valid token metadata and RPC quorum are required");
  }

  const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = tokenDecimalsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if (cached.decimals !== expectedDecimals) {
      throw new RpcVerificationError("TOKEN_DECIMALS_MISMATCH", "configured token decimals do not match the chain");
    }
    return cached.decimals;
  }

  const settled = await Promise.allSettled(
    rpcUrls.map((rpcUrl) => tokenDecimalsWithEndpoint({ chainId, tokenAddress, rpcUrl, fetchFn })),
  );
  const counts = new Map();
  for (const item of settled) {
    if (item.status === "fulfilled") {
      counts.set(item.value, (counts.get(item.value) ?? 0) + 1);
    }
  }
  const winner = [...counts.entries()].find(([, count]) => count >= rpcQuorum)?.[0];
  if (winner === undefined) {
    throw new RpcVerificationError("TOKEN_METADATA_QUORUM_NOT_REACHED", "token decimals could not be confirmed");
  }
  if (winner !== expectedDecimals) {
    throw new RpcVerificationError("TOKEN_DECIMALS_MISMATCH", "configured token decimals do not match the chain");
  }

  tokenDecimalsCache.set(cacheKey, {
    decimals: winner,
    expiresAt: now + TOKEN_DECIMALS_CACHE_TTL_MS,
  });
  return winner;
}

export async function verifyPaymentWithRpcQuorum({ invoice, txHash, rpcUrls, rpcQuorum, fetchFn = fetch }) {
  if (
    !invoice ||
    !Array.isArray(rpcUrls) ||
    rpcUrls.length === 0 ||
    rpcUrls.length > 3 ||
    !Number.isInteger(rpcQuorum) ||
    rpcQuorum <= 0 ||
    rpcQuorum > rpcUrls.length ||
    typeof fetchFn !== "function"
  ) {
    throw new TypeError("valid invoice, RPC endpoints, quorum, and fetch function are required");
  }

  const settled = await Promise.allSettled(
    rpcUrls.map((rpcUrl) => verifyWithEndpoint({ invoice, txHash, rpcUrl, fetchFn })),
  );
  const groups = new Map();
  for (const item of settled) {
    if (item.status !== "fulfilled") {
      continue;
    }
    const result = item.value;
    const fingerprint = `${result.transactionHash}:${result.blockHash}:${result.blockNumber}:${result.logIndex}`;
    const group = groups.get(fingerprint) ?? [];
    group.push(result);
    groups.set(fingerprint, group);
  }

  const winner = [...groups.values()].find((group) => group.length >= rpcQuorum);
  if (!winner) {
    throw new RpcVerificationError("RPC_QUORUM_NOT_REACHED", "payment could not be confirmed by the RPC quorum");
  }

  return {
    ...winner[0],
    confirmations: winner.reduce(
      (minimum, result) => (result.confirmations < minimum ? result.confirmations : minimum),
      winner[0].confirmations,
    ),
    rpcAgreement: winner.length,
  };
}
