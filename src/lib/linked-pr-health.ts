/**
 * Linked PR Health Module
 *
 * Computes normalized linked PR health metadata for issues that have associated PRs.
 * This enables issue queues, board views, and worker preflight to consume the same
 * normalized signal instead of shelling out to `gh pr view` for every candidate.
 *
 * Detection rules:
 * - Use GitHub linked PR references where possible (via pull_requests field), not only title/body regex.
 * - Use current aggregate reviewDecision for requested changes.
 * - Use statusCheckRollup or check-runs/status contexts for CI failures.
 * - Treat merge conflicts as actionable when PR state clearly indicates conflict (DIRTY, CONFLICTING).
 * - Do NOT treat BLOCKED alone as actionable unless paired with failing checks or requested changes.
 * - Do NOT treat BEHIND alone as actionable unless paired with failing checks.
 * - Ignore draft, closed, and merged PRs for active follow-up.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Individual check failure information.
 */
export interface CheckFailure {
  name: string;
  conclusion: string; // "failure", "cancelled", "timed_out", "action_required"
}

/**
 * A single linked PR's health snapshot.
 */
export interface LinkedPrHealth {
  /** The PR URL (e.g. https://github.com/org/repo/pull/123) */
  linkedPrUrl: string;
  /** The PR number */
  linkedPrNumber: number;
  /** Current review decision from GitHub's aggregate (APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, etc.) or null */
  reviewDecision: string | null;
  /** Merge state status from GitHub API (CLEAN, DIRTY, BEHIND, UNSTABLE, HAS_HOOKS, BLOCKED, CONFLICTING) or null */
  mergeStateStatus: string | null;
  /** List of failing CI/check-run checks */
  failingChecks: CheckFailure[];
  /** Whether the PR has a clear merge conflict */
  hasMergeConflict: boolean;
  /** Whether the issue needs follow-up based on all health signals combined */
  needsFollowup: boolean;
  /** Human-readable reasons why follow-up is needed (empty when needsFollowup is false) */
  followupReasons: string[];
}

/**
 * Input representing a single GitHub PR as seen by Dispatch.
 * Populated from the GitHub API via fetchPullRequests or webhook events.
 */
export interface PrHealthInput {
  url: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergedAt: string | null;
  mergeStateStatus: string | null; // GitHub API field
  reviewDecision: string | null;   // GitHub API aggregate review decision
  checkFailures: CheckFailure[];    // Failing check runs or status contexts
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * PR states that are excluded from active follow-up.
 * Draft, closed, and merged PRs are not actionable for issue health signals.
 */
const EXCLUDED_STATES = new Set(["closed", "merged"]);

/**
 * States indicating a clear merge conflict (actionable regardless of other signals).
 */
const CONFLICTING_STATUSES = new Set(["dirty", "conflicting"]);

/**
 * States that are NOT actionable on their own — they only matter when paired
 * with failing checks or requested changes.
 */
const NON_ACTIONABLE_MERGE_STATES = new Set(["behind", "blocked", "unstable", "has_hooks", "unknown"]);

/**
 * Check conclusions that indicate a failure requiring follow-up.
 */
const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

/**
 * Review decisions that indicate work is needed on the PR.
 */
const ACTIONABLE_REVIEW_DECISIONS = new Set(["CHANGES_REQUESTED"]);

// ─── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Compute linked PR health for a single PR input.
 *
 * Returns null if the PR should be ignored (draft, closed, merged).
 * Otherwise returns a normalized health snapshot.
 */
export function computeLinkedPrHealth(input: PrHealthInput): LinkedPrHealth | null {
  // Ignore draft, closed, and merged PRs for active follow-up
  if (input.draft || EXCLUDED_STATES.has(input.state)) {
    return null;
  }

  const failingChecks: CheckFailure[] = input.checkFailures.filter(
    (c) => FAILURE_CONCLUSIONS.has(c.conclusion.toLowerCase()),
  );

  const hasMergeConflict = CONFLICTING_STATUSES.has(input.mergeStateStatus?.toLowerCase() ?? "");

  const hasActionableReview = ACTIONABLE_REVIEW_DECISIONS.has(input.reviewDecision ?? "");

  // Determine follow-up reasons
  const followupReasons: string[] = [];

  if (hasActionableReview) {
    followupReasons.push("changes_requested");
  }

  if (failingChecks.length > 0) {
    followupReasons.push("failing_checks");
  }

  if (hasMergeConflict) {
    followupReasons.push("merge_conflict");
  }

  // Check for non-actionable merge states that are paired with other signals
  const isNonActionableMerge = NON_ACTIONABLE_MERGE_STATES.has(input.mergeStateStatus?.toLowerCase() ?? "");
  if (isNonActionableMerge && (failingChecks.length > 0 || hasActionableReview)) {
    // Include the merge state as a reason when paired with other actionable signals
    followupReasons.push(`merge_state_${input.mergeStateStatus?.toLowerCase() ?? "unknown"}`);
  }

  const needsFollowup = followupReasons.length > 0;

  return {
    linkedPrUrl: input.url,
    linkedPrNumber: input.number,
    reviewDecision: input.reviewDecision,
    mergeStateStatus: input.mergeStateStatus,
    failingChecks,
    hasMergeConflict,
    needsFollowup,
    followupReasons,
  };
}

/**
 * Compute linked PR health for multiple PRs.
 * Returns only non-null results (excluded PRs are silently dropped).
 */
export function computeLinkedPrHealthBatch(inputs: PrHealthInput[]): LinkedPrHealth[] {
  return inputs.map(computeLinkedPrHealth).filter((h): h is LinkedPrHealth => h !== null);
}

// ─── Persistence Mapping ──────────────────────────────────────────────────────

/**
 * The linked-PR-health columns persisted on the Issue row. Shared by the
 * reconcile job and the on-demand refresh endpoint so both write the same shape.
 */
export interface PersistedLinkedPrHealth {
  linkedPrNumber: number | null;
  linkedPrUrl: string | null;
  linkedPrNeedsFollowup: boolean;
  linkedPrFollowupReasons: string[];
  linkedPrReviewDecision: string | null;
  linkedPrMergeState: string | null;
  linkedPrHealthCheckedAt: Date;
}

/**
 * Map a computed health snapshot to the persisted Issue columns. A null health
 * (no linked PR, or a draft/closed/merged PR that isn't actionable) clears the
 * fields while still stamping the checked-at time.
 */
export function toPersistedLinkedPrHealth(
  health: LinkedPrHealth | null,
  checkedAt: Date = new Date(),
): PersistedLinkedPrHealth {
  if (!health) {
    return {
      linkedPrNumber: null,
      linkedPrUrl: null,
      linkedPrNeedsFollowup: false,
      linkedPrFollowupReasons: [],
      linkedPrReviewDecision: null,
      linkedPrMergeState: null,
      linkedPrHealthCheckedAt: checkedAt,
    };
  }
  return {
    linkedPrNumber: health.linkedPrNumber,
    linkedPrUrl: health.linkedPrUrl,
    linkedPrNeedsFollowup: health.needsFollowup,
    linkedPrFollowupReasons: health.followupReasons,
    linkedPrReviewDecision: health.reviewDecision,
    linkedPrMergeState: health.mergeStateStatus,
    linkedPrHealthCheckedAt: checkedAt,
  };
}

// ─── Queue Integration Helper ───────────────────────────────────────────────

/**
 * Enrich a queue item with linked PR health data.
 * Used by the agent queue API to attach health metadata to issues that have open PRs.
 */
export interface EnrichedQueueItem {
  type?: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  priority: string | null;
  status: string | null;
  agentMatch: boolean;
  rankingReason: string;
  lane?: string;
  decomposed?: boolean;
  issueId?: string;
  repoFullName?: string;
  claimable?: boolean;
  /** Linked PR health metadata (null if no linked open PR or PR is excluded) */
  linkedPrHealth: LinkedPrHealth | null;
}

/**
 * Enrich a list of queue items with linked PR health data.
 * The `prMap` maps issue numbers to their associated PR inputs.
 * In practice, this map would be built by scanning open PRs for each repo
 * and matching them to issues via GitHub's linked references or branch names.
 */
export function enrichQueueItemsWithPrHealth(
  items: Array<{
    type?: string;
    number: number;
    title: string;
    url: string;
    labels: string[];
    priority: string | null;
    status: string | null;
    agentMatch: boolean;
    rankingReason: string;
    lane?: string;
    decomposed?: boolean;
    issueId?: string;
    repoFullName?: string;
    claimable?: boolean;
  }>,
  prMap: Map<number, PrHealthInput>,
): EnrichedQueueItem[] {
  return items.map((item) => {
    const prInput = prMap.get(item.number);
    const health = prInput ? computeLinkedPrHealth(prInput) : null;
    return {
      ...item,
      linkedPrHealth: health,
    };
  });
}
