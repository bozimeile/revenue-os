const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9]{1,11}$/;
const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function parseJson(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 50_000) {
    throw new TypeError(`${label} must be a bounded JSON string`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

function isForbiddenHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host.includes(":")) {
    return true;
  }
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return true;
  }
  return false;
}

export function validatePublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isForbiddenHostname(url.hostname)
  ) {
    throw new TypeError("URL must be a credential-free public HTTPS endpoint");
  }
  return url;
}

export function parsePaymentConfig(raw) {
  const parsed = parseJson(raw, "payment config");
  if (!parsed || !Array.isArray(parsed.chains) || parsed.chains.length === 0 || parsed.chains.length > 5) {
    throw new TypeError("payment config must contain 1-5 chains");
  }

  const chainIds = new Set();
  const chains = parsed.chains.map((chain) => {
    if (!chain || !Number.isSafeInteger(chain.chainId) || chain.chainId <= 0 || chainIds.has(chain.chainId)) {
      throw new TypeError("chain IDs must be unique positive integers");
    }
    chainIds.add(chain.chainId);

    if (!Array.isArray(chain.rpcUrls) || chain.rpcUrls.length === 0 || chain.rpcUrls.length > 3) {
      throw new TypeError("each chain must contain 1-3 RPC URLs");
    }
    const normalizedRpcUrls = chain.rpcUrls.map((value) => validatePublicHttpsUrl(value));
    const rpcUrls = normalizedRpcUrls.map((url) => url.toString());
    if (new Set(rpcUrls).size !== rpcUrls.length) {
      throw new TypeError("RPC URLs must be unique after normalization");
    }
    if (new Set(normalizedRpcUrls.map((url) => url.hostname)).size !== normalizedRpcUrls.length) {
      throw new TypeError("RPC endpoints must use distinct hostnames");
    }
    if (!Number.isInteger(chain.rpcQuorum) || chain.rpcQuorum <= 0 || chain.rpcQuorum > rpcUrls.length) {
      throw new TypeError("RPC quorum must fit the configured endpoint count");
    }
    if (!Array.isArray(chain.tokens) || chain.tokens.length === 0 || chain.tokens.length > 10) {
      throw new TypeError("each chain must contain 1-10 payment tokens");
    }

    const symbols = new Set();
    const addresses = new Set();
    const tokens = chain.tokens.map((token) => {
      if (!token || !SYMBOL_PATTERN.test(token.symbol)) {
        throw new TypeError("token symbol is invalid");
      }
      if (!ADDRESS_PATTERN.test(token.address) || !ADDRESS_PATTERN.test(token.recipient)) {
        throw new TypeError("token and recipient must be EVM addresses");
      }
      const address = token.address.toLowerCase();
      const recipient = token.recipient.toLowerCase();
      if (address === recipient || symbols.has(token.symbol) || addresses.has(address)) {
        throw new TypeError("token metadata must be unique and recipient must not be the token contract");
      }
      if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
        throw new TypeError("token decimals are invalid");
      }
      if (!Number.isInteger(token.minConfirmations) || token.minConfirmations <= 0 || token.minConfirmations > 10_000) {
        throw new TypeError("token confirmations are invalid");
      }

      symbols.add(token.symbol);
      addresses.add(address);
      return {
        symbol: token.symbol,
        address,
        recipient,
        decimals: token.decimals,
        minConfirmations: token.minConfirmations,
      };
    });

    return { chainId: chain.chainId, rpcUrls, rpcQuorum: chain.rpcQuorum, tokens };
  });

  return { chains };
}

export function parseLeadSources(raw) {
  const parsed = parseJson(raw, "lead sources");
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 5) {
    throw new TypeError("lead sources must contain 1-5 entries");
  }

  const names = new Set();
  return parsed.map((source) => {
    if (!source || !SOURCE_NAME_PATTERN.test(source.name) || names.has(source.name)) {
      throw new TypeError("lead source names must be unique lower-case identifiers");
    }
    const url = validatePublicHttpsUrl(source.url);
    if (
      url.toString().length > 2_048 ||
      url.hostname !== "api.github.com" ||
      url.pathname !== "/search/issues" ||
      !url.searchParams.get("q")
    ) {
      throw new TypeError("only GitHub issue search sources are supported");
    }
    if (!Number.isInteger(source.minimumScore) || source.minimumScore < 50 || source.minimumScore > 100) {
      throw new TypeError("lead minimum score must be between 50 and 100");
    }
    if (
      !Number.isSafeInteger(source.minimumBudgetUsd) ||
      source.minimumBudgetUsd < 0 ||
      source.minimumBudgetUsd > 1_000_000
    ) {
      throw new TypeError("lead minimum budget must be between 0 and 1,000,000 USD");
    }
    names.add(source.name);
    return {
      name: source.name,
      url,
      minimumScore: source.minimumScore,
      minimumBudgetUsd: source.minimumBudgetUsd,
    };
  });
}
