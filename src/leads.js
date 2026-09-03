const SAFE_GITHUB_HOST = "github.com";
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 5_000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function normalizeGitHubIssue(item, source) {
  if (!item || typeof item !== "object" || item.pull_request) {
    return null;
  }
  if (!Number.isSafeInteger(item.id) || item.id <= 0) {
    return null;
  }
  if (typeof source !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(source)) {
    return null;
  }

  let evidenceUrl;
  try {
    evidenceUrl = new URL(item.html_url);
  } catch {
    return null;
  }
  if (evidenceUrl.protocol !== "https:" || evidenceUrl.hostname !== SAFE_GITHUB_HOST) {
    return null;
  }

  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (!title || title.length > MAX_TITLE_LENGTH || !validDate(item.created_at) || !validDate(item.updated_at)) {
    return null;
  }

  const description = typeof item.body === "string" ? item.body.slice(0, MAX_DESCRIPTION_LENGTH) : "";
  const labels = Array.isArray(item.labels)
    ? item.labels
        .slice(0, 20)
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter((label) => typeof label === "string" && label.length > 0 && label.length <= 80)
    : [];

  return {
    source,
    externalId: String(item.id),
    evidenceUrl: evidenceUrl.toString(),
    title,
    description,
    author: typeof item.user?.login === "string" ? item.user.login.slice(0, 100) : "unknown",
    authorType:
      item.user?.type === "Bot" || /\[bot\]$/i.test(item.user?.login ?? "")
        ? "Bot"
        : item.user?.type === "Organization"
          ? "Organization"
          : "User",
    labels,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function explicitUsdValues(text) {
  const values = [];
  const patterns = [
    /\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g,
    /\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:usd|usdc)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1].replaceAll(",", ""));
      if (Number.isFinite(value)) values.push(value);
    }
  }
  return values;
}

export function scoreLead(lead, now = new Date(), { minimumBudgetUsd = 0 } = {}) {
  if (!lead || typeof lead !== "object" || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("valid lead and scoring time are required");
  }
  if (!Number.isFinite(minimumBudgetUsd) || minimumBudgetUsd < 0) {
    throw new TypeError("minimum budget must be non-negative");
  }

  const createdAt = Date.parse(lead.createdAt);
  if (!Number.isFinite(createdAt) || createdAt > now.getTime() + FUTURE_CLOCK_SKEW_MS) {
    return { score: 0, reasons: ["invalid_evidence_time"], disqualified: true };
  }

  const text = `${lead.title}\n${lead.description}\n${lead.labels.join(" ")}`.toLowerCase();
  if (
    lead.authorType === "Bot" ||
    /agent-bounties\/github-discovery|canonical bounty discovery|seed a paid .* child bounty/.test(text)
  ) {
    return { score: 0, reasons: ["automated_or_mirrored_listing"], disqualified: true };
  }
  const statedValues = explicitUsdValues(text);
  if (statedValues.length > 0 && Math.max(...statedValues) < minimumBudgetUsd) {
    return { score: 0, reasons: ["explicit_value_below_floor"], disqualified: true };
  }
  const unsafePatterns = [
    /private[ _-]?key/,
    /seed phrase/,
    /custody of (?:production )?funds/,
    /guaranteed (?:profit|return)/,
    /mass (?:dm|message|email)/,
    /spam (?:users|customers|wallets)/,
  ];
  if (unsafePatterns.some((pattern) => pattern.test(text))) {
    return { score: 0, reasons: ["unsafe_or_abusive_request"], disqualified: true };
  }
  const excludedSecurityResearchPatterns = [
    /\bbug bount(?:y|ies)\b/,
    /\bvulnerabilit(?:y|ies)\b/,
    /\bexploit(?:ation| development)?\b/,
    /\bpenetration test(?:ing)?\b/,
    /\bpentest\b/,
    /\bred team(?:ing)?\b/,
    /\bsmart contract audit\b/,
    /\bsecurity audit\b/,
  ];
  if (
    excludedSecurityResearchPatterns.some((pattern) => pattern.test(text)) ||
    lead.labels.some((label) => /^(?:bounty|security|vulnerability|pentest)$/i.test(label))
  ) {
    return { score: 0, reasons: ["security_research_excluded"], disqualified: true };
  }

  let score = 0;
  const reasons = [];
  const hasBuyerIntent =
    /(?:\bbudget\b|\bhiring\b|\bcontractor\b|\brequests? for proposals?\b|\brfp\b|\bpaid (?:migration|integration|implementation)\b|\bfixed[ -]scope (?:diagnostic|reliability review|implementation)\b)/.test(
      text,
    ) ||
    /\b(?:seeking|looking for)\s+(?:an?\s+)?(?:developer|engineer|consultant|contractor)\b/.test(
      text,
    );
  if (hasBuyerIntent) {
    score += 35;
    reasons.push("explicit_paid_intent");
  }
  if (/\b(?:api|backend|cloudflare|wallet|payment|settlement|exchange|reconciliation|idempotency|websocket|smart contract|erc-?20|trading)\b/.test(text)) {
    score += 35;
    reasons.push("domain_match");
  }
  const ageMs = now.getTime() - createdAt;
  if (ageMs <= 30 * 24 * 60 * 60 * 1_000) {
    score += 15;
    reasons.push("recent_evidence");
  }
  if (lead.labels.some((label) => /^(?:help wanted|contract|contractor|paid|implementation)$/i.test(label))) {
    score += 10;
    reasons.push("work_label");
  }
  if (lead.authorType === "Organization") {
    score += 5;
    reasons.push("organization_author");
  }

  return { score: Math.min(score, 100), reasons, disqualified: false };
}
