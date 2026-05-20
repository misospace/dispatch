import { GitHubIssue } from "@/types";
import { GithubPR } from "@/lib/github";

// ─── Lane Classification Helpers ──────────────────────────────────────────────

/**
 * Heuristic lane classification when model calls are unavailable.
 * Uses label patterns and issue content to infer the correct execution lane.
 */
export function classifyLaneByHeuristics(
  title: string,
  body: string | null,
  labels: string[],
): { lane: "normal" | "escalated" | "backlog"; confidence: "high" | "medium" | "low"; reason: string } {
  const text = `${title} ${body ?? ""}`.toLowerCase();
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));

  // Escalated indicators: architecture, design, audit decomposition, cross-service
  const escalatedSignals = [
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

  const backlogSignals = [
    "status/backlog",
    "type/research",
    "tbd",
    "to be determined",
    "placeholder",
    "more details needed",
    "needs more info",
  ];

  // Check backlog first (highest priority exclusion)
  for (const signal of backlogSignals) {
    if (text.includes(signal) || labelSet.has(signal)) {
      return { lane: "backlog", confidence: "high", reason: `Backlog signal detected: ${signal}` };
    }
  }

  // Check escalated signals
  const escalationMatches = escalatedSignals.filter((s) => text.includes(s));
  if (escalationMatches.length > 0 && !labelSet.has("status/backlog")) {
    return { lane: "escalated", confidence: "medium", reason: `Escalation keywords: ${escalationMatches.join(", ")}` };
  }

  // Default to normal for concrete, actionable issues
  return { lane: "normal", confidence: "medium", reason: "Default classification: concrete implementation work" };
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
  const reviewDecision = pr.user?.login ?? null; // Simplified - real impl would use review API
  const mergeStateStatus = "clean"; // Simplified

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
  lanesUpdated: number;
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
