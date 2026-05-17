/**
 * PR Follow-up Event Ingestion Module
 *
 * Detects PR follow-up events (comments, reviews, failing checks) for tracked repos
 * and enqueues PR-fix work into the assignment queue.
 *
 * Ingestion strategy: pull-based sync (periodic scan of PRs) + webhook-based delivery
 * (real-time GitHub event reception). Both paths converge on the same ingestion logic.
 */

import { EnqueuePrFixInput, enqueuePrFixItem, PrFixQueueClient } from "@/lib/pr-fix-queue";

// ─── Types ──────────────────────────────────────────────────────────────────

export type BotIdentity = string; // GitHub login (e.g. "itsmiso-ai", "github-actions[bot]")

/**
 * Allowed branch owners — the repo owner or specific user logins whose branches
 * are eligible for automatic PR-fix queueing.
 */
export type BranchOwnerAllowlist = string[];

/**
 * Configured bot identities whose PRs are eligible for automatic PR-fix queueing.
 * No hardcoded agent or repo names — this is a flat list of GitHub logins.
 */
export interface PrFollowupConfig {
  botIdentities: BotIdentity[];
  branchOwnerAllowlist: BranchOwnerAllowlist;
}

/** Classification result from feedback analysis */
export type FeedbackClassification = "actionable" | "needs_human";

// ─── Default config (no hardcoded agent names or repo names) ────────────────

const DEFAULT_BOT_IDENTITIES: BotIdentity[] = ["itsmiso-ai", "github-actions[bot]"];

function getConfig(): PrFollowupConfig {
  const rawIdentities = process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  const botIdentities = rawIdentities
    ? rawIdentities.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_BOT_IDENTITIES;

  const rawOwners = process.env.PR_FOLLOWUP_BRANCH_OWNERS;
  const branchOwnerAllowlist = rawOwners
    ? rawOwners.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return { botIdentities, branchOwnerAllowlist };
}

// ─── Author / Branch Allowlist ──────────────────────────────────────────────

/**
 * Check if a PR author is an allowed bot identity.
 */
export function isAllowedBotAuthor(author: string | null | undefined): boolean {
  if (!author) return false;
  const config = getConfig();
  return config.botIdentities.includes(author);
}

/**
 * Check if the branch owner is in the allowlist.
 * If no allowlist is configured, all owners are allowed (opt-in safety).
 * If an allowlist is configured, the repo owner or listed user logins are allowed.
 */
export function isAllowedBranchOwner(
  repoFullName: string,
  branch: string | null | undefined,
): boolean {
  const config = getConfig();
  if (config.branchOwnerAllowlist.length === 0) {
    // No explicit allowlist — default to repo owner only (safe default).
    const [owner] = repoFullName.split("/");
    return Boolean(owner);
  }
  // Allowlisted: repo owner is always allowed, plus specific user logins.
  const [owner] = repoFullName.split("/");
  if (config.branchOwnerAllowlist.includes(owner)) return true;
  // Also check if the branch owner (repo owner) matches
  return config.branchOwnerAllowlist.some((allowed) => {
    if (allowed === owner) return true;
    return false;
  });
}

// ─── Feedback Classification ────────────────────────────────────────────────

/**
 * Classify feedback content as actionable or needing human review.
 *
 * Checks actionable patterns FIRST (most specific), then ambiguous patterns,
 * then defaults to needs_human when uncertain.
 *
 * Actionable patterns:
 * - Specific error messages or test failures cited
 * - Clear instructions with reproducible steps
 * - Code-level fixes suggested (e.g. "change X to Y")
 * - Lint/formatting complaints with specific violations
 *
 * Ambiguous / high-risk patterns that route to NEEDS_HUMAN:
 * - Vague requests ("make it better", "fix this", "looks wrong") without specifics
 * - Security-sensitive changes without clear reproduction steps
 * - Requests that could break behavior (refactors, dependency updates)
 * - Missing context or unclear acceptance criteria
 */
export function classifyFeedback(content: string): FeedbackClassification {
  if (!content || !content.trim()) return "needs_human";

  const text = content.toLowerCase().trim();

  // ── Actionable patterns (check first — most specific) ──────────────────

  const actionablePatterns = [
    // Error/exception messages with details (e.g. "Error: Cannot read...")
    /\b(error|exception)\s*:.*/i,
    // AssertionError style (e.g. "AssertionError: values don't match")
    /\bassertion\s*(error|mismatch|fail)\w*\b/i,
    // Test/spec references with pass/fail context (e.g. "Test failed: expected 200...")
    /\b(test|spec)\s+(pass|fail|skip|update)\w*\b.*\b(\w+)\b/i,
    // CI/check pipeline failures (e.g. "CI check lint failed with 3 errors")
    /\b(ci|check|pipeline|workflow)[\s:,.]+(fail|error|pass)\w*\b/i,
    // Lint/formatting complaints (e.g. "eslint error: unused import")
    /\b(lint|format|prettier|eslint)[\s:,.]*(error|warn|fix)\w*\b/i,
    // Generic failure with specific context (e.g. "failed with 3 errors")
    /\b(fail|error|exception)(?:ed|s)?[\s:,.]*(?:with|\d+)/i,
    // Code-level suggestions: Change/Replace X to/with Y (with backticks or words)
    /\b(change|replace|use)\s+\`?\w+\`?\s+(to|with)\s+\`?\w+\`?/i,
    // Add/remove/move instructions with code references (e.g. "Add `import ...` at the top")
    /\b(add|remove|move|rename)\s+`[^`]+`/i,
  ];

  for (const pattern of actionablePatterns) {
    if (pattern.test(text)) return "actionable";
  }

  // ── Ambiguous / high-risk patterns (NEEDS_HUMAN) ────────────────────────

  const ambiguousPatterns = [
    // Vague requests
    /\b(make|fix|improve|update|change)\s+(it|this|that|the\s+\w+)\s+(better|more|up|around)\b/i,
    /\blooks?\s+(wrong|bad|off|weird|suspicious)\b/i,
    /\bsomething\s+is?\s+(wrong|broken|off)\b/i,
    /\bcan\s+you\s+(fix|handle|look\s+at|check)\s+(this|it)\b/i,
    // Missing context
    /\bno\s+(context|explanation|details|description|repro)\b/i,
    /\bunclear|ambiguous|vague\b/i,
    // Security-sensitive without specifics
    /\bsecurity\s+(concern|issue|flag)\b.*\bwithout\s+\b(repro|example|detail)\b/i,
  ];

  for (const pattern of ambiguousPatterns) {
    if (pattern.test(text)) return "needs_human";
  }

  // ── Default: needs human review when uncertain ─────────────────────────

  return "needs_human";
}

// ─── Evidence Key ───────────────────────────────────────────────────────────

/**
 * Compute a unique evidence key for deduplication.
 * Format: {eventType}:{source}:{identifier}
 */
export function computeEvidenceKey(
  eventType: "comment" | "review" | "check_run" | "merge_state",
  sourceId: string, // comment ID, review ID, check run ID
  repoFullName: string,
  prNumber: number,
): string {
  return `${eventType}:${repoFullName}#${prNumber}:${sourceId}`;
}

// ─── Event Ingestion ────────────────────────────────────────────────────────

/**
 * Ingest a new PR comment event.
 * Returns the enqueued item ID if the event was actionable and eligible,
 * or null if it was filtered out (not bot-authored, ambiguous feedback, or duplicate).
 */
export async function ingestCommentEvent(
  client: PrFixQueueClient,
  opts: {
    repoFullName: string;
    prNumber: number;
    branch: string | null;
    url: string;
    title: string;
    author: string | null;
    commentBody: string;
    commentId: string;
    linkedIssue?: number | null;
  },
): Promise<string | null> {
  // Check author eligibility
  if (!isAllowedBotAuthor(opts.author)) return null;

  // Check branch owner eligibility
  if (!isAllowedBranchOwner(opts.repoFullName, opts.branch)) return null;

  // Classify feedback
  const classification = classifyFeedback(opts.commentBody);
  const lane = classification === "needs_human" ? "NEEDS_HUMAN" : "NORMAL";

  const evidenceKey = computeEvidenceKey("comment", opts.commentId, opts.repoFullName, opts.prNumber);

  await enqueuePrFixItem(client, {
    repo: opts.repoFullName,
    pr: opts.prNumber,
    lane,
    reason: `PR comment: ${classification === "needs_human" ? "ambiguous feedback" : "actionable feedback"}`,
    feedback: opts.commentBody,
    evidenceKey,
    issue: opts.linkedIssue,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
  });

  return evidenceKey;
}

/**
 * Ingest a PR review event (CHANGES_REQUESTED triggers PR-fix work).
 */
export async function ingestReviewEvent(
  client: PrFixQueueClient,
  opts: {
    repoFullName: string;
    prNumber: number;
    branch: string | null;
    url: string;
    title: string;
    author: string | null;
    reviewBody: string;
    reviewId: string;
    reviewState: string; // "APPROVED", "CHANGES_REQUESTED", "COMMENTED"
    linkedIssue?: number | null;
  },
): Promise<string | null> {
  // Only CHANGES_REQUESTED triggers PR-fix work (not APPROVED or COMMENTED)
  if (opts.reviewState !== "CHANGES_REQUESTED") return null;

  // Check author eligibility
  if (!isAllowedBotAuthor(opts.author)) return null;

  // Check branch owner eligibility
  if (!isAllowedBranchOwner(opts.repoFullName, opts.branch)) return null;

  const classification = classifyFeedback(opts.reviewBody);
  const lane = classification === "needs_human" ? "NEEDS_HUMAN" : "NORMAL";

  const evidenceKey = computeEvidenceKey("review", opts.reviewId, opts.repoFullName, opts.prNumber);

  await enqueuePrFixItem(client, {
    repo: opts.repoFullName,
    pr: opts.prNumber,
    lane,
    reason: `PR review: CHANGES_REQUESTED`,
    feedback: opts.reviewBody,
    evidenceKey,
    issue: opts.linkedIssue,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
  });

  return evidenceKey;
}

/**
 * Ingest a failing check run event.
 */
export async function ingestCheckRunEvent(
  client: PrFixQueueClient,
  opts: {
    repoFullName: string;
    prNumber: number;
    branch: string | null;
    url: string;
    title: string;
    author: string | null;
    checkName: string;
    conclusion: string; // "failure", "cancelled", "timed_out" etc.
    checkRunId: string;
    checkDetails?: string;
    linkedIssue?: number | null;
  },
): Promise<string | null> {
  // Only failing checks trigger PR-fix work
  const failureConclusions = ["failure", "cancelled", "timed_out", "action_required"];
  if (!failureConclusions.includes(opts.conclusion.toLowerCase())) return null;

  // Check author eligibility
  if (!isAllowedBotAuthor(opts.author)) return null;

  // Check branch owner eligibility
  if (!isAllowedBranchOwner(opts.repoFullName, opts.branch)) return null;

  const classification = classifyFeedback(opts.checkDetails ?? `Check "${opts.checkName}" ${opts.conclusion}`);
  const lane = classification === "needs_human" ? "NEEDS_HUMAN" : "NORMAL";

  const evidenceKey = computeEvidenceKey("check_run", opts.checkRunId, opts.repoFullName, opts.prNumber);

  await enqueuePrFixItem(client, {
    repo: opts.repoFullName,
    pr: opts.prNumber,
    lane,
    reason: `Failing check: ${opts.checkName} (${opts.conclusion})`,
    feedback: opts.checkDetails ?? `Check "${opts.checkName}" concluded ${opts.conclusion}`,
    evidenceKey,
    issue: opts.linkedIssue,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
  });

  return evidenceKey;
}

/**
 * Ingest a merge state change event (e.g., mergeable changed from true to false).
 */
export async function ingestMergeStateEvent(
  client: PrFixQueueClient,
  opts: {
    repoFullName: string;
    prNumber: number;
    branch: string | null;
    url: string;
    title: string;
    author: string | null;
    mergeStateStatus: string; // "BEHIND", "DIRTY", "UNSTABLE", "HAS_HOOKS", etc.
    linkedIssue?: number | null;
  },
): Promise<string | null> {
  // Only problematic states trigger PR-fix work
  const problematicStates = ["behind", "dirty", "unstable", "has_hooks"];
  if (!problematicStates.includes(opts.mergeStateStatus.toLowerCase())) return null;

  // Check author eligibility
  if (!isAllowedBotAuthor(opts.author)) return null;

  // Check branch owner eligibility
  if (!isAllowedBranchOwner(opts.repoFullName, opts.branch)) return null;

  const evidenceKey = computeEvidenceKey("merge_state", opts.mergeStateStatus, opts.repoFullName, opts.prNumber);

  await enqueuePrFixItem(client, {
    repo: opts.repoFullName,
    pr: opts.prNumber,
    lane: "NORMAL",
    reason: `Merge state change: ${opts.mergeStateStatus}`,
    feedback: `PR merge state is now ${opts.mergeStateStatus}`,
    evidenceKey,
    issue: opts.linkedIssue,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
  });

  return evidenceKey;
}

// ─── Bulk Sync ──────────────────────────────────────────────────────────────

/**
 * Scan a single PR for new follow-up events and enqueue actionable ones.
 * This is used by the periodic sync to catch up on missed events.
 */
export interface PrFollowupEvent {
  eventType: "comment" | "review" | "check_run" | "merge_state";
  repoFullName: string;
  prNumber: number;
  branch: string | null;
  url: string;
  title: string;
  author: string | null;
  body?: string;
  id: string;
  state?: string;
  conclusion?: string;
  checkName?: string;
  mergeStateStatus?: string;
  linkedIssue?: number | null;
}

/**
 * Process a batch of PR follow-up events.
 * Returns counts for tracking.
 */
export async function processPrFollowupEvents(
  client: PrFixQueueClient,
  events: PrFollowupEvent[],
): Promise<{ enqueued: number; skipped: number }> {
  let enqueued = 0;
  let skipped = 0;

  for (const event of events) {
    try {
      switch (event.eventType) {
        case "comment":
          if (event.body && event.id) {
            const key = await ingestCommentEvent(client, {
              repoFullName: event.repoFullName,
              prNumber: event.prNumber,
              branch: event.branch,
              url: event.url,
              title: event.title,
              author: event.author,
              commentBody: event.body,
              commentId: event.id,
              linkedIssue: event.linkedIssue,
            });
            if (key) enqueued++; else skipped++;
          } else {
            skipped++;
          }
          break;

        case "review":
          if (event.state && event.id) {
            const key = await ingestReviewEvent(client, {
              repoFullName: event.repoFullName,
              prNumber: event.prNumber,
              branch: event.branch,
              url: event.url,
              title: event.title,
              author: event.author,
              reviewBody: event.body ?? "",
              reviewId: event.id,
              reviewState: event.state,
              linkedIssue: event.linkedIssue,
            });
            if (key) enqueued++; else skipped++;
          } else {
            skipped++;
          }
          break;

        case "check_run":
          if (event.conclusion && event.id) {
            const key = await ingestCheckRunEvent(client, {
              repoFullName: event.repoFullName,
              prNumber: event.prNumber,
              branch: event.branch,
              url: event.url,
              title: event.title,
              author: event.author,
              checkName: event.checkName ?? "unknown",
              conclusion: event.conclusion,
              checkRunId: event.id,
              checkDetails: event.body,
              linkedIssue: event.linkedIssue,
            });
            if (key) enqueued++; else skipped++;
          } else {
            skipped++;
          }
          break;

        case "merge_state":
          if (event.mergeStateStatus) {
            const key = await ingestMergeStateEvent(client, {
              repoFullName: event.repoFullName,
              prNumber: event.prNumber,
              branch: event.branch,
              url: event.url,
              title: event.title,
              author: event.author,
              mergeStateStatus: event.mergeStateStatus,
              linkedIssue: event.linkedIssue,
            });
            if (key) enqueued++; else skipped++;
          } else {
            skipped++;
          }
          break;

        default:
          skipped++;
      }
    } catch (error) {
      console.error(`Failed to ingest PR followup event (${event.eventType} for ${event.repoFullName}#${event.prNumber}):`, error);
      skipped++;
    }
  }

  return { enqueued, skipped };
}
