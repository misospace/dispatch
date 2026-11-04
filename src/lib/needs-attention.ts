/**
 * Derived "Needs Attention" projection (#1541).
 *
 * Human attention is a presentation stage over EXISTING Dispatch records,
 * never a new workflow status: an item is listed only when the current
 * structured state means a person can actually unblock it. The derivation is
 * pure — the collector (see `@/lib/needs-attention-snapshot`) loads rows from
 * Dispatch's Postgres cache with read-only queries and hands them here.
 *
 * Deliberately excluded: healthy autonomous work, ordinary queued work, and
 * transient retry states (WAITING_EXTERNAL, PARKED infra_failure) — those
 * already have bounded automated recovery and must not consume operator
 * attention. Resolution is automatic by construction: when the underlying
 * record moves (e.g. fresh evidence requeues a BLOCKED human-decision item,
 * which also clears `decisionDetail`), the item simply stops being derived.
 */

export type NeedsAttentionCategory =
  | "human_decision"
  | "semantic_conflict"
  | "security_failure"
  | "review_ready"
  | "ownership_parked"
  | "no_pr_conclusion";

export interface NeedsAttentionDecision {
  question: string | null;
  options: string[];
  evidence: string | null;
}

export interface NeedsAttentionItem {
  /** Stable identity: `<category>:<source row id>`. */
  id: string;
  category: NeedsAttentionCategory;
  title: string;
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  /** Direct operator action link where one exists. */
  url: string | null;
  /** Bounded reason derived from structured state — never free-form LLM prose. */
  reason: string;
  /** Structured decision payload, human_decision items only. */
  decision: NeedsAttentionDecision | null;
  /** ISO timestamp the attention state began; drives age sorting. */
  ageStartedAt: string;
  /** 1 = most urgent. */
  urgency: number;
}

export interface NeedsAttentionSnapshot {
  now: string;
  items: NeedsAttentionItem[];
}

export interface PrFixAttentionRow {
  id: string;
  repo: string;
  pr: number;
  issue: number | null;
  url: string | null;
  title: string | null;
  status: string;
  lane: string;
  type: string;
  outcome: string | null;
  decisionDetail: unknown;
  queuedAt: Date | string;
}

export interface AgentExecutionAttentionRow {
  id: string;
  agentName: string;
  executionState: string;
  endedAt: Date | string | null;
  startedAt: Date | string | null;
  lastObservedAt: Date | string;
  workRefUrl: string | null;
  pullRequestNumber: number | null;
  summary: string | null;
}

export interface OwnershipIntentAttentionRow {
  id: string;
  agentName: string;
  agentLabel: string;
  phase: string;
  parkedAt: Date | string | null;
  issue: { number: number; repoFullName: string; title: string; url: string } | null;
}

export interface NoPrConclusionAttentionRow {
  id: string;
  agentName: string;
  outcome: string;
  summary: string | null;
  createdAt: Date | string;
  issue: { number: number; repoFullName: string; title: string; url: string } | null;
}

export interface NeedsAttentionInput {
  now: Date | string;
  prFixItems: PrFixAttentionRow[];
  agentExecutions: AgentExecutionAttentionRow[];
  ownershipIntents: OwnershipIntentAttentionRow[];
  noPrConclusions: NoPrConclusionAttentionRow[];
}

/** `https://github.com/<owner>/<repo>/...` prefix → `<owner>/<repo>`. */
function repoFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/|$|#|\?)/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Parse the persisted `decisionDetail` Json defensively (#1218 shape:
 * `{ question?, options?, evidence? }`). Anything malformed degrades to
 * nulls/empty rather than throwing — a malformed payload must never take the
 * projection down.
 */
function parseDecision(detail: unknown): NeedsAttentionDecision {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    return { question: null, options: [], evidence: null };
  }
  const record = detail as Record<string, unknown>;
  const question = typeof record.question === "string" && record.question.trim() ? record.question : null;
  const options = Array.isArray(record.options)
    ? record.options.filter((o): o is string => typeof o === "string")
    : [];
  const evidence = typeof record.evidence === "string" && record.evidence.trim() ? record.evidence : null;
  return { question, options, evidence };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function prFixUrl(item: PrFixAttentionRow): string | null {
  if (item.url) return item.url;
  return `https://github.com/${item.repo}/pull/${item.pr}`;
}

function derivePrFixItem(item: PrFixAttentionRow): NeedsAttentionItem | null {
  const blockedOrParked = item.status === "BLOCKED" || item.status === "PARKED";
  if (!blockedOrParked) return null;
  const conflictType = item.type === "MERGE_CONFLICT" || item.type === "REBASE";
  if (item.outcome === "human_decision") {
    // A BLOCKED item carrying the #1218 decision payload: the operator owns
    // the call, so this outranks every other classification of the same row.
    return {
      id: `human_decision:${item.id}`,
      category: "human_decision",
      title: item.title ?? `${item.repo}#${item.pr}`,
      repo: item.repo,
      issueNumber: item.issue,
      prNumber: item.pr,
      url: prFixUrl(item),
      reason: "worker escalated a decision an operator must make",
      decision: parseDecision(item.decisionDetail),
      ageStartedAt: toIso(item.queuedAt),
      urgency: 1,
    };
  }
  if (conflictType) {
    // Semantic rebase/conflict the worker correctly refused (#1327 lane
    // shape): mechanical automation must not churn on it, so it waits here
    // for a human call.
    return {
      id: `semantic_conflict:${item.id}`,
      category: "semantic_conflict",
      title: item.title ?? `${item.repo}#${item.pr}`,
      repo: item.repo,
      issueNumber: item.issue,
      prNumber: item.pr,
      url: prFixUrl(item),
      reason: "automation correctly refused a semantic rebase/conflict; operator decision required",
      decision: null,
      ageStartedAt: toIso(item.queuedAt),
      urgency: 2,
    };
  }
  if (item.status === "PARKED" && item.outcome === "security_failure") {
    // Durable security failure (#1218): parked without the needs-human label
    // because requeueing is never automatic — only a human can act.
    return {
      id: `security_failure:${item.id}`,
      category: "security_failure",
      title: item.title ?? `${item.repo}#${item.pr}`,
      repo: item.repo,
      issueNumber: item.issue,
      prNumber: item.pr,
      url: prFixUrl(item),
      reason: "durable security failure parked for operator intervention",
      decision: null,
      ageStartedAt: toIso(item.queuedAt),
      urgency: 2,
    };
  }
  // PARKED no_progress / infra_failure and non-human BLOCKED outcomes on
  // non-conflict types are bounded automated states or retryable/transient —
  // not attention-worthy.
  return null;
}

function deriveAgentExecution(row: AgentExecutionAttentionRow): NeedsAttentionItem | null {
  // AWAITING_REVIEW (#1495) is the structured "agent finished, operator
  // review is the unblocking action" state; a terminal `endedAt` makes it
  // resolved either way.
  if (row.executionState !== "AWAITING_REVIEW" || row.endedAt != null) return null;
  const title = row.summary?.trim() || `${row.agentName} finished work awaiting review`;
  return {
    id: `review_ready:${row.id}`,
    category: "review_ready",
    title,
    repo: repoFromUrl(row.workRefUrl),
    issueNumber: null,
    prNumber: row.pullRequestNumber,
    url: row.workRefUrl,
    reason: "agent work is complete and awaiting operator review",
    decision: null,
    ageStartedAt: toIso(row.startedAt ?? row.lastObservedAt),
    urgency: 3,
  };
}

function deriveOwnershipIntent(row: OwnershipIntentAttentionRow): NeedsAttentionItem | null {
  // §8.7 fail-closed park (#1254): bounded Phase-B forge retries exhausted,
  // intent parked for the operator instead of retrying forever.
  if (row.phase !== "pending" || row.parkedAt == null) return null;
  const issue = row.issue;
  return {
    id: `ownership_parked:${row.id}`,
    category: "ownership_parked",
    title: issue?.title ?? `${issue?.repoFullName ?? "unknown"}#${issue?.number ?? "?"}`,
    repo: issue?.repoFullName ?? null,
    issueNumber: issue?.number ?? null,
    prNumber: null,
    url: issue?.url ?? (issue ? `https://github.com/${issue.repoFullName}/issues/${issue.number}` : null),
    reason: `ownership release parked after bounded forge retries for ${row.agentLabel}; operator intervention required`,
    decision: null,
    ageStartedAt: toIso(row.parkedAt),
    urgency: 2,
  };
}

function deriveNoPrConclusion(row: NoPrConclusionAttentionRow): NeedsAttentionItem | null {
  const issue = row.issue;
  // A live no-PR-conclusion park (#1506) only ends on a content edit or an
  // operator clear, so resolving it is genuinely a human action.
  return {
    id: `no_pr_conclusion:${row.id}`,
    category: "no_pr_conclusion",
    title: issue?.title ?? `${issue?.repoFullName ?? "unknown"}#${issue?.number ?? "?"}`,
    repo: issue?.repoFullName ?? null,
    issueNumber: issue?.number ?? null,
    prNumber: null,
    url: issue?.url ?? (issue ? `https://github.com/${issue.repoFullName}/issues/${issue.number}` : null),
    reason: `agent ${row.agentName} reported ${row.outcome}; clear the park or edit the issue to resume`,
    decision: null,
    ageStartedAt: toIso(row.createdAt),
    urgency: 3,
  };
}

/**
 * Derive the full Needs Attention view from the collected rows. The input is
 * authoritative current state, so re-deriving after any underlying change
 * (new comment evidence requeuing a blocked item, an execution ending, an
 * operator clearing a park) reclassifies or removes items automatically —
 * the projection holds no state of its own.
 */
export function computeNeedsAttention(input: NeedsAttentionInput): NeedsAttentionSnapshot {
  const items = [
    ...input.prFixItems.map(derivePrFixItem),
    ...input.agentExecutions.map(deriveAgentExecution),
    ...input.ownershipIntents.map(deriveOwnershipIntent),
    ...input.noPrConclusions.map(deriveNoPrConclusion),
  ].filter((item): item is NeedsAttentionItem => item !== null);
  items.sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency - b.urgency;
    const byAge = a.ageStartedAt.localeCompare(b.ageStartedAt);
    if (byAge !== 0) return byAge;
    return a.id.localeCompare(b.id);
  });
  return { now: toIso(input.now), items };
}

/** Human-facing group labels, urgency-ordered for the UI. */
export const NEEDS_ATTENTION_CATEGORIES: Array<{
  category: NeedsAttentionCategory;
  label: string;
  urgency: number;
}> = [
  { category: "human_decision", label: "Human decision", urgency: 1 },
  { category: "semantic_conflict", label: "Semantic conflict", urgency: 2 },
  { category: "security_failure", label: "Security failure", urgency: 2 },
  { category: "ownership_parked", label: "Ownership parked", urgency: 2 },
  { category: "review_ready", label: "Review ready", urgency: 3 },
  { category: "no_pr_conclusion", label: "No-PR conclusion", urgency: 3 },
];
