import { ACTIVE_STATUS_LABELS, GitHubIssue } from "@/types";
import { GithubPR, closeIssue as githubCloseIssue, addIssueLabel as githubAddIssueLabel, removeIssueLabel as githubRemoveIssueLabel } from "@/lib/github";
import { getDefaultClaimableLane, isBacklogLane, resolveLaneId } from "@/lib/lane-config";
import { classifyLaneByHeuristics } from "@/lib/issue-lane";
import { LinkedPrHealth } from "@/lib/linked-pr-health";
import { transitionIssueStatus } from "@/lib/issue-status";

// ─── Lane Classification Helpers ──────────────────────────────────────────────

// The heuristic lane classifier lives in @/lib/issue-lane (single source of
// truth shared with the lane route). Re-exported here for existing callers.
export { evaluateLaneSignals, classifyLaneByHeuristics } from "@/lib/issue-lane";

/**
 * Determine whether a stale backlog lane should be reclassified.
 *
 * An issue with currentLane=backlog that currently carries an active status
 * label (ready / in-progress / in-review) is stuck and must be reclassified.
 * Returns the new lane to use, or null when no reclassification is needed.
 *
 * Delegates to classifyLaneByHeuristics so escalation signals from title/body
 * are respected. Falls back to the default claimable lane if the classifier
 * still returns a backlog lane (e.g. stale text mentions) — an active-status
 * issue must never stay in the backlog lane.
 */
export function shouldReclassifyStaleBacklog(
  existingLane: string | null,
  title: string,
  body: string | null,
  currentLabels: string[],
): string | null {
  const resolved = resolveLaneId(existingLane);
  if (!resolved || !isBacklogLane(resolved)) {
    return null;
  }

  const labelSet = new Set(currentLabels.map((l) => l.toLowerCase()));

  // Don't reclassify when the issue still has status/backlog
  if (labelSet.has("status/backlog")) {
    return null;
  }

  // Only reclassify for active statuses
  const hasActiveStatus = ACTIVE_STATUS_LABELS.some((s) => labelSet.has(s));
  if (!hasActiveStatus) {
    return null;
  }

  // Reuse the same heuristic classifier as first-time classification.
  const classification = classifyLaneByHeuristics(title, body, currentLabels);

  // If classifier still says backlog (stale text mentions), fall back to default
  // claimable lane. An issue with an active status label must never remain in
  // the backlog lane.
  if (isBacklogLane(classification.lane)) {
    return getDefaultClaimableLane()?.id ?? "default";
  }

  return classification.lane;
}

// ─── Merged PR Detection ─────────────────────────────────────────────────────

/**
 * Pattern used by wishlist workers when referencing issues in PR bodies.
 */
const FIXING_PATTERNS = [
  /fix(?:es)?\s+#(\d+)/gi,
  /close[sd]?\s+#(\d+)/gi,
  /resolve[sd]?\s+#(\d+)/gi,
];

/**
 * Extract issue numbers referenced in a PR body as fixing/closing references.
 */
export function extractFixingIssueNumbers(body: string | null): number[] {
  if (!body) return [];
  const numbers = new Set<number>();
  for (const pattern of FIXING_PATTERNS) {
    const matches = body.matchAll(pattern);
    for (const match of matches) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num)) numbers.add(num);
    }
  }
  return Array.from(numbers);
}

/**
 * Check if a PR branch name suggests it fixes a specific issue.
 * Pattern: fix/issue-{number}-slug or similar variants.
 */
export function prBranchMatchesIssue(branch: string, issueNumber: number): boolean {
  const pattern = new RegExp(`(?:^|[-_/])issue[-_/]?${issueNumber}(?:[-_/]|$)|^(?:fix\\/)?${issueNumber}`, "i");
  return pattern.test(branch);
}

// ─── Open PR Health Check ─────────────────────────────────────────────────────

/**
 * Health status of an open PR from the perspective of issue reconciliation.
 */
export type PrHealthStatus = "healthy" | "needs_work";

export interface PrHealthCheck {
  prNumber: number;
  url: string;
  headRefName: string;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  status: PrHealthStatus;
  reason: string;
}

/**
 * Human-readable reason for a single canonical follow-up reason code, used to
 * build the audit-log-facing `PrHealthCheck.reason` string.
 */
function describeFollowupReason(reason: string, health: LinkedPrHealth): string {
  switch (reason) {
    case "changes_requested":
      return "Review changes requested";
    case "failing_checks": {
      const names = health.failingChecks.map((c) => c.name).filter(Boolean).join(", ");
      return names ? `Failing checks: ${names}` : "PR has failing checks";
    }
    case "merge_conflict":
      return `Merge state is ${health.mergeStateStatus}`;
    default:
      return `Merge state is ${health.mergeStateStatus}`;
  }
}

/**
 * Check the health of an open PR. Thin adapter over the canonical
 * `computeLinkedPrHealth` actionability signal (@/lib/linked-pr-health) —
 * BEHIND/BLOCKED/UNKNOWN merge states are not actionable on their own;
 * failing checks, CHANGES_REQUESTED reviews, and merge conflicts are.
 *
 * `health` is the precomputed LinkedPrHealth for this PR (or null when the
 * health fetch failed or produced no signal). Missing health is treated
 * conservatively as healthy so a transient fetch failure never falsely
 * flags a PR as needing work.
 */
export function checkPrHealth(pr: GithubPR, health: LinkedPrHealth | null): PrHealthCheck {
  const reviewDecision = pr.reviewDecision ?? null;
  const mergeStateStatus = pr.mergeStateStatus ?? null;

  let status: PrHealthStatus;
  let reason: string;
  if (health && health.needsFollowup) {
    status = "needs_work";
    reason = health.followupReasons.map((r) => describeFollowupReason(r, health)).join("; ");
  } else {
    status = "healthy";
    reason = "PR is open and healthy/pending";
  }

  return {
    prNumber: pr.number,
    url: pr.url,
    headRefName: pr.head?.ref ?? "",
    reviewDecision,
    mergeStateStatus,
    status,
    reason,
  };
}

// ─── Reconciliation Actions ──────────────────────────────────────────────────

/**
 * A single reconciliation action to apply to an issue.
 */
export interface ReconciliationAction {
  type: "close_issue" | "add_label" | "remove_label" | "set_status";
  issueNumber: number;
  repoFullName: string;
  label?: string;
  reason: string;
}

/**
 * Result of executing a single reconciliation action against GitHub.
 */
export interface ExecutedAction {
  action: ReconciliationAction;
  success: boolean;
  error?: string;
  beforeLabels: string[];
  afterLabels: string[];
}

/**
 * Result of reconciling a single issue against PR state.
 */
export interface IssueReconciliationResult {
  issueNumber: number;
  repoFullName: string;
  actions: ReconciliationAction[];
  hasOpenPr: boolean;
  openPrNeedsWork: boolean;
  isClosedByMergedPr: boolean;
}

/**
 * Full reconciliation result across all repos.
 */
export interface ReconciliationResult {
  reposProcessed: number;
  issuesReconciled: number;
  mergedPrsFound: number;
  openPrsChecked: number;
  issuesClosed: number;
  labelsChanged: number;
  errors: string[];
}

// ─── Reconciliation Engine ────────────────────────────────────────────────────

/**
 * Reconcile a single issue against PR state.
 * 
 * Checks:
 * 1. Has a merged PR that fixes this issue? → close it
 * 2. Does an open PR exist for this issue? → check health, update lane
 */
export function reconcileIssue(
  issue: { number: number; title: string; body: string | null; labels: string[]; state: string },
  mergedPrs: Map<number, GithubPR>,
  openPrs: Map<number, GithubPR>,
  openPrHealth: Map<number, LinkedPrHealth | null> = new Map(),
): IssueReconciliationResult {
  const actions: ReconciliationAction[] = [];
  let hasOpenPr = false;
  let openPrNeedsWork = false;
  let isClosedByMergedPr = false;

  // Check for merged fixing PRs
  if (issue.state === "open" && mergedPrs.has(issue.number)) {
    const mergedPr = mergedPrs.get(issue.number)!;
    actions.push({
      type: "close_issue",
      issueNumber: issue.number,
      repoFullName: "", // caller provides this
      reason: `Fixed by merged PR #${mergedPr.number} (${mergedPr.title})`,
    });
    isClosedByMergedPr = true;
    return {
      issueNumber: issue.number,
      repoFullName: "",
      actions,
      hasOpenPr: false,
      openPrNeedsWork: false,
      isClosedByMergedPr: true,
    };
  }

  // Check for open PRs referencing this issue
  if (issue.state === "open") {
    const matchingOpenPr = openPrs.get(issue.number);
    if (matchingOpenPr) {
      hasOpenPr = true;
      const linkedHealth = openPrHealth.get(issue.number) ?? null;
      const health = checkPrHealth(matchingOpenPr, linkedHealth);
      openPrNeedsWork = health.status === "needs_work";

      const hasInProgress = issue.labels.includes("status/in-progress");
      const hasDone = issue.labels.includes("status/done");
      const hasInReview = issue.labels.includes("status/in-review");

      // If PR needs work, ensure issue is in a lane where workers can pick it up.
      // in-review counts as already-placed: adding in-progress on top of it left
      // issues carrying two status labels, and an in-progress issue with no live
      // Workload is what the bridge's stranded reconciler resets to ready — which
      // re-dispatches and force-pushes over the open PR's branch.
      if (openPrNeedsWork) {
        if (!hasInProgress && !hasDone && !hasInReview) {
          actions.push({
            type: "set_status",
            issueNumber: issue.number,
            repoFullName: "",
            label: "status/in-progress",
            reason: `Open PR #${matchingOpenPr.number} needs work: ${health.reason}`,
          });
        }
      }

      // If PR is healthy and not already in review/done, mark as in-review
      if (!openPrNeedsWork) {
        if (!hasInProgress && !hasDone && !hasInReview) {
          actions.push({
            type: "set_status",
            issueNumber: issue.number,
            repoFullName: "",
            label: "status/in-review",
            reason: `Open PR #${matchingOpenPr.number} is healthy/pending`,
          });
        }
      }
    } else if (issue.labels.includes("status/in-review")) {
      // in-review means a PR existed. No open PR and no merged fixing PR means it
      // is gone (closed unmerged, or emptied and autoclosed by a force-push over
      // the branch) and nothing will ever advance this issue: it is claimed, so
      // the queue skips it, and no Workload backs it. Release it to ready.
      //
      // Deliberately scoped to in-review only. in-progress is NOT reaped here:
      // a running Workload that has not opened its PR yet looks identical from
      // GitHub, and resetting it would double-dispatch. Only the bridge can see
      // Workloads, so in-progress staleness stays its job.
      actions.push({
        type: "set_status",
        issueNumber: issue.number,
        repoFullName: "",
        label: "status/ready",
        reason: "in-review but no open or merged PR — releasing to ready",
      });
    }
  }

  return {
    issueNumber: issue.number,
    repoFullName: "",
    actions,
    hasOpenPr,
    openPrNeedsWork,
    isClosedByMergedPr,
  };
}

// ─── Action Execution ────────────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff.
 * Retries on transient errors (rate limits, network failures).
 * Stops retrying on non-transient errors (404, auth failures, etc.).
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const message = lastError.message.toLowerCase();

      // Don't retry on non-transient errors
      if (
        message.includes("404") ||
        message.includes("not found") ||
        message.includes("authentication") ||
        message.includes("forbidden") ||
        message.includes("unauthorized")
      ) {
        throw lastError;
      }

      if (attempt === maxRetries) {
        throw lastError;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * 2 ** attempt + Math.random() * 500, maxDelayMs);
      console.warn(`GitHub API call failed (attempt ${attempt + 1}/${maxRetries + 1}):`, lastError.message);
      await sleep(delay);
    }
  }

  throw lastError!;
}

/**
 * Execute a single reconciliation action against GitHub.
 * Returns before/after label state for audit logging.
 */
export async function executeAction(
  action: ReconciliationAction,
  currentLabels: string[],
  options?: { maxRetries?: number },
): Promise<ExecutedAction> {
  const result: ExecutedAction = {
    action,
    success: false,
    beforeLabels: [...currentLabels],
    afterLabels: [...currentLabels],
  };

  const maxRetries = options?.maxRetries ?? 3;

  try {
    switch (action.type) {
      case "close_issue":
        await retryWithBackoff(() => githubCloseIssue(action.repoFullName, action.issueNumber), maxRetries);
        result.afterLabels = [];
        result.success = true;
        break;

      case "add_label": {
        const label = action.label;
        if (label && !currentLabels.includes(label)) {
          await retryWithBackoff(() => githubAddIssueLabel(action.repoFullName, action.issueNumber, label), maxRetries);
          result.afterLabels = [...currentLabels, label];
          result.success = true;
        } else {
          result.success = true;
        }
        break;
      }

      case "remove_label": {
        const label = action.label;
        if (label && currentLabels.includes(label)) {
          await retryWithBackoff(() => githubRemoveIssueLabel(action.repoFullName, action.issueNumber, label), maxRetries);
          result.afterLabels = currentLabels.filter((l) => l !== label);
          result.success = true;
        } else {
          result.success = true;
        }
        break;
      }

      case "set_status": {
        // Swap, never add: transitionIssueStatus strips every existing status/*
        // label before applying the target, so an issue can only ever carry one.
        // This is the same helper claim/groom/move/unclaim and /api/issues/status
        // use, so reconcile can no longer diverge from them.
        const label = action.label;
        if (label && !(currentLabels.includes(label) && currentLabels.filter((l) => l.startsWith("status/")).length === 1)) {
          result.afterLabels = await retryWithBackoff(
            () => transitionIssueStatus(action.repoFullName, action.issueNumber, currentLabels, label),
            maxRetries,
          );
          result.success = true;
        } else {
          result.success = true;
        }
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    result.error = message;
    console.error(`Failed to execute ${action.type} on ${action.repoFullName}#${action.issueNumber}:`, message);
  }

  return result;
}

/**
 * Execute all reconciliation actions for an issue, tracking execution results.
 */
export async function executeActions(
  actions: ReconciliationAction[],
  currentLabels: string[],
  options?: { maxRetries?: number },
): Promise<ExecutedAction[]> {
  const results: ExecutedAction[] = [];
  let labels = [...currentLabels];

  for (const action of actions) {
    const result = await executeAction({ ...action, repoFullName: action.repoFullName || "" }, labels, options);
    if (result.success && !result.error) {
      labels = result.afterLabels;
    }
    results.push(result);

    // Small delay between actions to spread out GitHub API requests
    if (results.length < actions.length) {
      await sleep(250);
    }
  }

  return results;
}
