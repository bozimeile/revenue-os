const TRANSITIONS = Object.freeze({
  new: ["qualified", "disqualified"],
  qualified: ["drafted", "disqualified"],
  drafted: ["approved", "disqualified"],
  approved: ["sent", "disqualified"],
  sent: ["replied", "no_response", "disqualified"],
  replied: ["proposal", "disqualified"],
  proposal: ["contracted", "lost"],
  contracted: ["invoice_open", "lost"],
  invoice_open: ["paid", "expired"],
  paid: ["delivering"],
  delivering: ["delivered"],
  delivered: ["closed"],
  disqualified: [],
  no_response: [],
  lost: [],
  expired: [],
  closed: [],
});

export function nextLeadStatuses(current) {
  const statuses = TRANSITIONS[current];
  if (!statuses) {
    throw new TypeError(`unknown lead status: ${current}`);
  }
  return [...statuses];
}

export function isLeadStatus(value) {
  return typeof value === "string" && Object.hasOwn(TRANSITIONS, value);
}

export function assertLeadTransition(current, next) {
  const allowed = nextLeadStatuses(current);
  if (!Object.hasOwn(TRANSITIONS, next) || !allowed.includes(next)) {
    throw new TypeError(`invalid lead transition: ${current} -> ${next}`);
  }
}
