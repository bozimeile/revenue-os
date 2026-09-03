import { normalizeGitHubIssue, scoreLead } from "./leads.js";
import { readBoundedJsonResponse } from "./http.js";

const MAX_ITEMS_PER_SOURCE = 30;
const MAX_RESPONSE_BYTES = 1_000_000;

export async function discoverGitHubSource({ source, now, fetchFn, store, githubToken = null }) {
  if (!source || !(source.url instanceof URL) || typeof fetchFn !== "function" || typeof store?.upsertLead !== "function") {
    throw new TypeError("source, fetch function, and lead store are required");
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "revenue-os-lead-discovery/0.1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  const response = await fetchFn(source.url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`lead source returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("lead source response type or size is invalid");
  }

  const payload = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES);
  if (!payload || !Array.isArray(payload.items) || payload.items.length > MAX_ITEMS_PER_SOURCE) {
    throw new Error("lead source payload is invalid or too large");
  }

  let qualified = 0;
  let stored = 0;
  for (const item of payload.items) {
    const lead = normalizeGitHubIssue(item, source.name);
    if (!lead) {
      continue;
    }
    const scored = scoreLead(lead, now, { minimumBudgetUsd: source.minimumBudgetUsd });
    if (scored.disqualified || scored.score < source.minimumScore) {
      continue;
    }
    qualified += 1;
    const outcome = await store.upsertLead({
      ...lead,
      score: scored.score,
      scoreReasons: scored.reasons,
      status: "new",
      discoveredAt: now.toISOString(),
      lastVerifiedAt: now.toISOString(),
    });
    if (outcome === "inserted" || outcome === "updated") {
      stored += 1;
    }
  }

  return { source: source.name, seen: payload.items.length, qualified, stored };
}

export async function runLeadDiscovery(options) {
  if (!Array.isArray(options.sources)) {
    throw new TypeError("lead sources are required");
  }
  const results = [];
  const errors = [];
  for (const source of options.sources) {
    try {
      results.push(await discoverGitHubSource({ ...options, source }));
    } catch {
      errors.push({ source: source.name, error: "source_failed" });
    }
  }
  return { results, errors };
}
