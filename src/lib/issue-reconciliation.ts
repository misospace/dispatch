import { GitHubIssue } from "@/types";
import { GithubPR, closeIssue as githubCloseIssue, addIssueLabel as githubAddIssueLabel, removeIssueLabel as githubRemoveIssueLabel } from "@/lib/github";
import { classifyLaneFromSignals, getDefaultClaimableLane, isBacklogLane, resolveLaneId, LaneSignals } from "@/lib/lane-config";

// ─── Lane Classification Helpers ──────────────────────────────────────────────

/**
 * Shared escalation keyword list used by both classifyLaneByHeuristics and
 * shouldReclassifyStaleBacklog.
 */
const ESCALATION_KEYWORDS = [
  "architecture",
  "audit",
  "design doc",
  "rfc",
  "alternatives considered",
  "migration strategy",
  "cross-service",
  "distributed system",
  "audit parent",
  "parent issue",
  "umbrella",
  "decomposition",
];

/**
 * Shared backlog signal list.
 */
const BACKLOG_SIGNALS = [
  "status/backlog",
  "type/research",
  "tbd",
  "to be determined",
  "placeholder",
  "more details needed",
  "needs more info",
];

/**
 * Shared escalation label signals.
 */
const ESCALATION_LABELS = ["needs-escalation", "needs-gpt"];

/**
 * Evaluate heuristic signals for an issue. Returns structured signals that can
 * be mapped to a configured lane via classifyLaneFromSignals.
 */
export function evaluateLaneSignals(
  title: string,
  body: string | null,
  labels: string[],
): LaneSignals & { reason: string } {
  const text = `${title} ${body ?? ""}`.toLowerCase();
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));

  // Check backlog first (highest priority exclusion)
  for (const signal of BACKLOG_SIGNALS) {
    if (text.includes(signal) || labelSet.has(signal)) {
      return { isBacklog: true, isEscalation: false, reason: `Backlog signal detected: ${signal}` };
    }
  }

  // Explicit escalation labels take precedence over text heuristics
  if (ESCALATION_LABELS.some((s) => labelSet.has(s))) {
    return { isBacklog: false, isEscalation: true, reason: "Escalation label detected" };
  }

  // Check escalated signals
  const escalationMatches = ESCALATION_KEYWORDS.filter((s) => text.includes(s));
  if (escalationMatches.length > 0 && !labelSet.has("status/backlog")) {
    return { isBacklog: false, isEscalation: true, reason: `Escalation keywords: ${escalationMatches.join(", ")}` };
  }

  // Default: concrete, actionable issues
  return { isBacklog: false, isEscalation: false, reason: "Default classification: concrete implementation work" };
}

/**
 * Heuristic lane classification when model calls are unavailable.
 * Uses label patterns and issue content to infer the correct execution lane.
 * Returns a configured lane id — never an unknown string.
 */
export function classifyLaneByHeuristics(
  title: string,
  body: string | null,
  labels: string[],
): { lane: string; confidence: "high" | "medium" | "low"; reason: string } {
  const signals = evaluateLaneSignals(title, body, labels);

  let confidence: "high" | "medium" | "low" = "medium";
  if (signals.isBacklog) {
    confidence = "high";
  } else if (signals.isEscalation && ESCALATION_LABELS.some((l) => labels.map((x) => x.toLowerCase()).includes(l))) {
    confidence = "high";
  }

  return {
    lane: classifyLaneFromSignals({ isBacklog: signals.isBacklog, isEscalation: signals.isEscalation }),
    confidence,
    reason: signals.reason,
  };
}

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
  const activeStatuses = ["status/ready", "status/in-progress", "status/in-review"];
  const hasActiveStatus = activeStatuses.some((s) => labelSet.has(s));
  if (!hasActiveStatus) {
    return null;
  }

  // Reuse the same heuristic classifier as first-time classification.
  const classification = classifyLaneByHeuristics(title, body, currentLabels);

  // If classifier still says backlog (stale text mentions), fall back to default
  // claimable lane. An issue with an active status label must never remain in
  // the backlog lane.
  if (isBacklogLane(classification.lane)) {
    return getDefaultClaimableLane()?.id ?? "normal";
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
  hasFailingChecks: boolean;
  status: PrHealthStatus;
  reason: string;
}

/**
 * Check the health of an open PR. Returns whether it needs another worker pass.
 */
export function checkPrHealth(pr: GithubPR): PrHealthCheck {
  const reviewDecision = pr.reviewDecision ?? null;
  const mergeStateStatus = pr.mergeStateStatus ?? null;

  // Check for review changes requested
  if (reviewDecision === "CHANGES_REQUESTED") {
    return {
      prNumber: pr.number,
      url: pr.url,
      headRefName: pr.head?.ref ?? "",
      reviewDecision,
      mergeStateStatus,
      hasFailingChecks: false,
      status: "needs_work",
      reason: "Review changes requested",
    };
  }

  // Check for problematic merge states
  const badStates = ["dirty", "behind", "blocked", "unknown"];
  if (badStates.includes(mergeStateStatus?.toLowerCase() ?? "")) {
    return {
      prNumber: pr.number,
      url: pr.url,
      headRefName: pr.head?.ref ?? "",
      reviewDecision,
      mergeStateStatus,
      hasFailingChecks: false,
      status: "needs_work",
      reason: `Merge state is ${mergeStateStatus}`,
    };
  }

  return {
    prNumber: pr.number,
    url: pr.url,
    headRefName: pr.head?.ref ?? "",
    reviewDecision,
    mergeStateStatus,
    hasFailingChecks: false,
    status: "healthy",
    reason: "PR is open and healthy/pending",
  };
}

// ─── Reconciliation Actions ──────────────────────────────────────────────────

/**
 * A single reconciliation action to apply to an issue.
 */
export interface ReconciliationAction {
  type: "close_issue" | "update_lane" | "add_label" | "remove_label";
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
      const health = checkPrHealth(matchingOpenPr);
      openPrNeedsWork = health.status === "needs_work";

      // If PR needs work, ensure issue is in a lane where workers can pick it up
      if (openPrNeedsWork) {
        // Check if issue has status/in-progress or status/done labels
        const hasInProgress = issue.labels.includes("status/in-progress");
        const hasDone = issue.labels.includes("status/done");

        if (!hasInProgress && !hasDone) {
          actions.push({
            type: "add_label",
            issueNumber: issue.number,
            repoFullName: "",
            label: "status/in-progress",
            reason: `Open PR #${matchingOpenPr.number} needs work: ${health.reason}`,
          });
        }
      }

      // If PR is healthy and not already in review/done, mark as in-review
      if (!openPrNeedsWork) {
        const hasInProgress = issue.labels.includes("status/in-progress");
        const hasDone = issue.labels.includes("status/done");
        const hasInReview = issue.labels.includes("status/in-review");

        if (!hasInProgress && !hasDone && !hasInReview) {
          actions.push({
            type: "add_label",
            issueNumber: issue.number,
            repoFullName: "",
            label: "status/in-review",
            reason: `Open PR #${matchingOpenPr.number} is healthy/pending`,
          });
        }
      }
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

/**
 * Check if a PR references a specific issue by number.
 */
export function prReferencesIssue(pr: GithubPR, issueNumber: number): boolean {
  // Check branch name pattern
  const branch = pr.head?.ref ?? "";
  if (prBranchMatchesIssue(branch, issueNumber)) {
    return true;
  }

  // Note: For full PR body matching, we'd need the PR body which isn't in GithubPR.
  // The branch-based check covers the majority of cases used by wishlist workers.
  return false;
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

      case "update_lane":
        // update_lane is not yet produced by reconcileIssue() but the handler
        // may produce it in future. Silently skip for now.
        result.success = true;
        break;
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
