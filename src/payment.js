export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

export class PaymentVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaymentVerificationError";
    this.code = code;
  }
}

export function parseAtomicAmount(decimalAmount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new TypeError("token decimals must be an integer between 0 and 255");
  }
  if (typeof decimalAmount !== "string") {
    throw new TypeError("decimal amount must be a string");
  }

  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(decimalAmount);
  if (!match || (match[2]?.length ?? 0) > decimals) {
    throw new TypeError("decimal amount is not canonical for the configured token decimals");
  }

  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  const atomic = whole * 10n ** BigInt(decimals) + BigInt(fraction || "0");
  if (atomic > UINT256_MAX) {
    throw new RangeError("token amount exceeds uint256");
  }
  return atomic;
}

function malformed(message) {
  throw new PaymentVerificationError("MALFORMED_RPC_RESPONSE", message);
}

function normalizeAddress(value, field) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new PaymentVerificationError("INVALID_INVOICE", `${field} is not an EVM address`);
  }
  return value.toLowerCase();
}

function parseQuantity(value, field) {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    malformed(`${field} is not a canonical JSON-RPC quantity`);
  }
  return BigInt(value);
}

function decodeTopicAddress(topic) {
  if (typeof topic !== "string" || !BYTES32_PATTERN.test(topic) || !/^0x0{24}/i.test(topic)) {
    malformed("ERC-20 address topic is malformed");
  }
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function parseUint256Data(data) {
  if (typeof data !== "string" || !BYTES32_PATTERN.test(data)) {
    malformed("ERC-20 transfer amount is malformed");
  }
  return BigInt(data);
}

export function verifyTransferReceipt({
  invoice,
  requestedTxHash,
  receipt,
  canonicalBlockHash,
  latestBlockNumber,
}) {
  if (!invoice || typeof invoice !== "object") {
    throw new PaymentVerificationError("INVALID_INVOICE", "invoice is required");
  }
  if (typeof requestedTxHash !== "string" || !BYTES32_PATTERN.test(requestedTxHash)) {
    throw new PaymentVerificationError("INVALID_TRANSACTION_HASH", "transaction hash must be 32 bytes");
  }
  if (receipt === null) {
    throw new PaymentVerificationError("PAYMENT_PENDING", "transaction receipt is not available");
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    malformed("transaction receipt is malformed");
  }
  if (receipt.status === "0x0") {
    throw new PaymentVerificationError("TRANSACTION_REVERTED", "transaction reverted");
  }
  if (receipt.status !== "0x1") {
    malformed("transaction status is not canonical");
  }
  if (typeof receipt.transactionHash !== "string" || !BYTES32_PATTERN.test(receipt.transactionHash)) {
    malformed("receipt transaction hash is malformed");
  }
  if (receipt.transactionHash.toLowerCase() !== requestedTxHash.toLowerCase()) {
    throw new PaymentVerificationError("TX_HASH_MISMATCH", "receipt does not match the requested transaction");
  }

  const blockNumber = parseQuantity(receipt.blockNumber, "block number");
  if (typeof receipt.blockHash !== "string" || !BYTES32_PATTERN.test(receipt.blockHash)) {
    malformed("receipt block hash is malformed");
  }
  if (typeof canonicalBlockHash !== "string" || !BYTES32_PATTERN.test(canonicalBlockHash)) {
    malformed("canonical block hash is malformed");
  }
  if (receipt.blockHash.toLowerCase() !== canonicalBlockHash.toLowerCase()) {
    throw new PaymentVerificationError("NON_CANONICAL_BLOCK", "receipt is not in the canonical block");
  }
  if (typeof latestBlockNumber !== "bigint" || latestBlockNumber < blockNumber) {
    malformed("latest block number is invalid");
  }

  const confirmations = latestBlockNumber - blockNumber + 1n;
  if (!Number.isSafeInteger(invoice.minConfirmations) || invoice.minConfirmations <= 0) {
    throw new PaymentVerificationError("INVALID_INVOICE", "minimum confirmations must be positive");
  }
  if (confirmations < BigInt(invoice.minConfirmations)) {
    throw new PaymentVerificationError("INSUFFICIENT_CONFIRMATIONS", "transaction has too few confirmations");
  }

  const tokenAddress = normalizeAddress(invoice.tokenAddress, "token address");
  const payerAddress = normalizeAddress(invoice.payerAddress, "payer address");
  const recipientAddress = normalizeAddress(invoice.recipientAddress, "recipient address");
  if (typeof invoice.amountAtomic !== "string" || !/^(0|[1-9][0-9]*)$/.test(invoice.amountAtomic)) {
    throw new PaymentVerificationError("INVALID_INVOICE", "atomic amount must be a canonical integer string");
  }
  const amountAtomic = BigInt(invoice.amountAtomic);
  if (amountAtomic <= 0n || amountAtomic > UINT256_MAX) {
    throw new PaymentVerificationError("INVALID_INVOICE", "atomic amount is outside uint256 payment range");
  }
  if (!Array.isArray(receipt.logs)) {
    malformed("receipt logs are malformed");
  }

  let match = null;
  for (const log of receipt.logs) {
    if (!log || typeof log !== "object" || typeof log.address !== "string" || !ADDRESS_PATTERN.test(log.address)) {
      malformed("receipt contains a malformed log");
    }
    if (log.address.toLowerCase() !== tokenAddress) {
      continue;
    }
    if (!Array.isArray(log.topics) || log.topics.length < 1 || typeof log.topics[0] !== "string") {
      malformed("token log topics are malformed");
    }
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) {
      continue;
    }
    if (log.topics.length !== 3) {
      malformed("ERC-20 Transfer topics are malformed");
    }

    const from = decodeTopicAddress(log.topics[1]);
    const to = decodeTopicAddress(log.topics[2]);
    const amount = parseUint256Data(log.data);
    if (from === payerAddress && to === recipientAddress && amount === amountAtomic) {
      if (match !== null) {
        throw new PaymentVerificationError("AMBIGUOUS_TRANSFER", "receipt contains multiple matching transfers");
      }
      match = log;
    }
  }

  if (match === null) {
    throw new PaymentVerificationError("TRANSFER_NOT_FOUND", "no exact invoice transfer exists in the receipt");
  }

  return {
    transactionHash: requestedTxHash.toLowerCase(),
    blockHash: receipt.blockHash.toLowerCase(),
    blockNumber,
    logIndex: parseQuantity(match.logIndex, "log index"),
    confirmations,
  };
}
