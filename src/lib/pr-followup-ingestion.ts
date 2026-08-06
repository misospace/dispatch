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
import { CONFLICTING_STATUSES, FAILURE_CONCLUSIONS } from "@/lib/linked-pr-health";

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

const DEFAULT_BOT_IDENTITIES: BotIdentity[] = ["github-actions[bot]"];

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
 * Check if the repo owner is in the allowlist.
 * If no allowlist is configured, all owners are allowed (opt-in safety).
 */
export function isAllowedBranchOwner(repoFullName: string): boolean {
  const config = getConfig();
  if (config.branchOwnerAllowlist.length === 0) {
    // No explicit allowlist — default to repo owner only (safe default).
    const [owner] = repoFullName.split("/");
    return Boolean(owner);
  }
  const [owner] = repoFullName.split("/");
  return config.branchOwnerAllowlist.includes(owner);
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
const AMBIGUOUS_FEEDBACK_PATTERNS = [
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

  // (patterns live at module scope — see AMBIGUOUS_FEEDBACK_PATTERNS)

  if (AMBIGUOUS_FEEDBACK_PATTERNS.some((pattern) => pattern.test(text))) return "needs_human";

  // ── Default: needs human review when uncertain ─────────────────────────

  return "needs_human";
}

// ─── Structured AI-reviewer findings ────────────────────────────────────────

/** A single finding from the ai-pr-reviewer structured payload. */
export interface AiReviewerFinding {
  severity?: string;
  category?: string;
  file?: string | null;
  line?: number | null;
  message?: string;
}

/** The machine-readable verdict the ai-pr-reviewer embeds in a review body. */
export interface AiReviewerPayload {
  review_result?: string;
  open_findings?: AiReviewerFinding[];
}

/**
 * The ai-pr-reviewer embeds a machine-readable verdict in the review body as an
 * HTML comment: `<!-- ai-pr-reviewer:{...json...} -->`. Parse it so the router
 * can act on the structured findings instead of keyword-classifying the review
 * prose — the reviewer writes long narrative markdown that matches none of the
 * classifyFeedback patterns and would always fall through to needs_human,
 * dead-ending every AI review at human escalation.
 *
 * The bare `<!-- ai-pr-reviewer -->` marker and the sibling `ai-pr-review-sha:` /
 * `ai-pr-review-fingerprint:` comments are ignored (only the `ai-pr-reviewer:`
 * JSON payload matches). Returns null when absent or unparseable.
 */
export function parseAiReviewerFindings(body: string | undefined | null): AiReviewerPayload | null {
  if (!body) return null;
  // Capture up to the closing `-->`; JSON never contains it, so a non-greedy
  // match yields the whole object even though it has nested braces.
  const match = body.match(/<!--\s*ai-pr-reviewer:\s*([\s\S]*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim()) as AiReviewerPayload;
  } catch {
    return null;
  }
}

// ─── Informational bot comments ─────────────────────────────────────────────

/**
 * Markers identifying comments that report state rather than request work:
 * CI size-diff tables, coverage summaries, and dispatch's own BLOCKED notice.
 * The sticky-comment convention (marvinpinto/sticky-pull-request-comment and
 * friends) embeds a hidden marker so the action can update its comment in
 * place — which makes it a structural discriminator, not a prose guess.
 */
const INFORMATIONAL_COMMENT_MARKERS = [
  "<!-- Sticky Pull Request Comment",
  "<!-- dispatch-pr-fix-blocked -->",
];

/**
 * Report whether a comment is informational rather than review feedback.
 *
 * The comment path previously ingested every non-author comment on a bot PR,
 * so a CI bot posting "size change: +0 B" became a REVIEW_FEEDBACK item;
 * classifyFeedback finds no actionable pattern in a markdown table, defaults
 * to needs_human, and the PR is BLOCKED on a human forever. Observed on
 * misospace/llmkube-images#114: a mergeable PR blocked by a size-diff table
 * reporting no change at all.
 *
 * An ai-pr-reviewer comment is exempt even when it carries a marker: it ships
 * a structured findings payload and is genuine review feedback that the
 * routing in `reviewLane` is built to act on.
 */
export function isInformationalComment(body: string | undefined | null): boolean {
  if (!body) return false;
  if (parseAiReviewerFindings(body)) return false;
  return INFORMATIONAL_COMMENT_MARKERS.some((marker) => body.includes(marker));
}

// ─── Evidence Key ───────────────────────────────────────────────────────────

/**
 * Compute a unique evidence key for deduplication.
 * Format: {eventType}:{source}:{identifier}
 */
export function computeEvidenceKey(
  eventType: "comment" | "review" | "review_comment" | "check_run" | "merge_state" | "merge_conflict",
  sourceId: string, // comment ID, review ID, check run ID
  repoFullName: string,
  prNumber: number,
): string {
  return `${eventType}:${repoFullName}#${prNumber}:${sourceId}`;
}

// ─── Linked Issue Extraction ────────────────────────────────────────────────

/**
 * Extract the linked issue number from a PR's title and body.
 * Matches the first "#NNN" reference (e.g. "#42", "Fixes #42", "Closes #42").
 */
export function extractLinkedIssue(pr: { title?: string | null; body?: string | null }): number | null {
  const text = [pr.title, pr.body].filter(Boolean).join("\n");
  const match = text.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ─── Event Ingestion ────────────────────────────────────────────────────────

/** Lane + work-item fields derived from an event by its descriptor. */
interface IngestWorkItem {
  lane: "NORMAL" | "NEEDS_HUMAN";
  type: string;
  reason: string;
  feedback: string;
}

/**
 * Per-event-type ingestion descriptor. All event types share the same
 * skeleton (gate → terminal-PR filter → author check → owner check →
 * evidence key → enqueue); descriptors supply the type-specific parts.
 */
interface IngestDescriptor {
  /** Required event fields for batch processing — false counts as skipped. */
  isIngestible: (event: PrFollowupEvent) => boolean;
  /** Type-specific precondition — false filters the event out. */
  gate: (event: PrFollowupEvent) => boolean;
  /** Whether merged/closed PRs are filtered out for this event type. */
  filterTerminalPr: boolean;
  /** Source identifier used in the evidence key. */
  sourceId: (event: PrFollowupEvent) => string;
  /** Lane/type/reason/feedback for the enqueued item. */
  workItem: (event: PrFollowupEvent) => IngestWorkItem;
}

function laneFor(feedback: string): "NORMAL" | "NEEDS_HUMAN" {
  return classifyFeedback(feedback) === "needs_human" ? "NEEDS_HUMAN" : "NORMAL";
}

/**
 * Lane for a CHANGES_REQUESTED review. An ai-pr-reviewer verdict carrying
 * concrete findings is actionable by definition, so route it to NORMAL and let
 * the coder attempt a fix — the PR_FIX_MAX_ATTEMPTS → ESCALATED → NEEDS_HUMAN
 * ladder handles "coder can't fix it", exactly as it does for CI failures.
 * Without this, the reviewer's narrative prose matches no classifyFeedback
 * pattern and every AI review dead-ends at needs_human. Human prose reviews
 * (no structured payload) still fall back to the keyword classifier.
 */
function reviewLane(body: string): "NORMAL" | "NEEDS_HUMAN" {
  // CHANGES_REQUESTED goes to the fix lane. Full stop.
  //
  // This used to run the review body through classifyFeedback's keyword list, so a
  // regex decided whether a MODEL would be able to act on prose — while the thing
  // downstream is a model that receives the whole review as its feedback. It reads
  // "restore the validate job" and "ci.yaml:20 does not catch duplicate keys" fine.
  // Predicting on its behalf only produced false negatives: pr-reviewer-action#467,
  // a review with file:line references and explicit asks, matched no actionable
  // pattern and no ambiguous pattern, hit the needs_human default, and sat BLOCKED
  // for 13 hours while nothing acted on it.
  //
  // Escalation still exists, but on evidence instead of prediction: the coder
  // attempts the fix, and PR_FIX_MAX_ATTEMPTS moves it to NEEDS_HUMAN once it has
  // actually failed. "A model tried and could not" beats "a regex guessed it would
  // not". An empty body carries nothing to act on, so that alone stays human.
  return body && body.trim() ? "NORMAL" : "NEEDS_HUMAN";
}


const PROBLEMATIC_MERGE_STATES = ["behind", "dirty", "unstable", "has_hooks"];

const INGEST_DESCRIPTORS: Record<PrFollowupEvent["eventType"], IngestDescriptor> = {
  comment: {
    isIngestible: (event) => Boolean(event.body && event.id),
    // Informational bot comments (CI tables, dispatch's own BLOCKED notice)
    // are state reports, not work requests — ingesting them strands mergeable
    // PRs in NEEDS_HUMAN.
    gate: (event) => !isInformationalComment(event.body),
    filterTerminalPr: false,
    sourceId: (event) => event.id,
    workItem: (event) => {
      const classification = classifyFeedback(event.body ?? "");
      return {
        lane: classification === "needs_human" ? "NEEDS_HUMAN" : "NORMAL",
        type: "REVIEW_FEEDBACK",
        reason: `PR comment: ${classification === "needs_human" ? "ambiguous feedback" : "actionable feedback"}`,
        feedback: event.body ?? "",
      };
    },
  },
  review: {
    isIngestible: (event) => Boolean(event.state && event.id),
    // Only CHANGES_REQUESTED triggers PR-fix work (not APPROVED or COMMENTED)
    gate: (event) => event.state === "CHANGES_REQUESTED",
    filterTerminalPr: true,
    sourceId: (event) => event.id,
    workItem: (event) => ({
      lane: reviewLane(event.body ?? ""),
      type: "REVIEW_FEEDBACK",
      reason: `PR review: CHANGES_REQUESTED`,
      feedback: event.body ?? "",
    }),
  },
  review_comment: {
    isIngestible: (event) => Boolean(event.body && event.id),
    // Inline review comments are the reviewer's actual findings, and they arrive
    // independently of the review's verdict — which is what makes them worth
    // ingesting on their own. An APPROVED review carrying four "Minor (bug)" nits
    // was dropped entirely: the review path only acts on CHANGES_REQUESTED, and
    // these comments live on pulls/N/comments, an endpoint the sync never read.
    gate: (event) => !isInformationalComment(event.body),
    // A nit on an already-merged PR is not actionable.
    filterTerminalPr: true,
    sourceId: (event) => event.id,
    workItem: (event) => ({
      // Deliberately NOT run through classifyFeedback. A reviewer anchoring a
      // comment to a file and line has already done the triage that
      // classification guesses at; running review prose through a keyword list is
      // what stranded human reviews in NEEDS_HUMAN (#729). If the coder cannot
      // act on it, attempt-exhaustion escalates on evidence instead.
      lane: "NORMAL",
      type: "REVIEW_FEEDBACK",
      reason: event.path
        ? `Review comment on ${event.path}${event.line ? `:${event.line}` : ""}`
        : "Review comment",
      feedback: event.path
        ? `${event.path}${event.line ? `:${event.line}` : ""} — ${event.body ?? ""}`
        : (event.body ?? ""),
    }),
  },
  check_run: {
    isIngestible: (event) => Boolean(event.conclusion && event.id),
    // Only failing checks trigger PR-fix work
    gate: (event) => FAILURE_CONCLUSIONS.has((event.conclusion ?? "").toLowerCase()),
    filterTerminalPr: false,
    sourceId: (event) => event.id,
    workItem: (event) => {
      const checkName = event.checkName ?? "unknown";
      // event.body carries the job-log excerpt the sync fetched server-side (CI
      // checks rarely set output.summary, so without this the coder gets a
      // contentless "check failed" and fixes blind). Present the real error +
      // the log URL for reference; degrade to reason + URL when no excerpt.
      const excerpt = event.body?.trim();
      const lines = [`CI check "${checkName}" failed (${event.conclusion}) on this PR.`];
      if (excerpt) {
        lines.push("", "Error from the job log:", excerpt);
      }
      if (event.url) {
        lines.push("", `Full log: ${event.url}`);
      }
      if (!excerpt) {
        lines.push("Read the full log at the URL above to find the error, then fix the root cause.");
      } else {
        lines.push("", "Fix the root cause the log shows.");
      }
      return {
        // A failing check is actionable work for coder-revision by definition —
        // don't classify it by prose (an empty body would misroute to NEEDS_HUMAN).
        // The escalation ladder (PR_FIX_MAX_ATTEMPTS -> ESCALATED -> NEEDS_HUMAN)
        // handles "coder can't fix it".
        lane: "NORMAL",
        type: "CI_FAILURE",
        reason: `Failing check: ${checkName} (${event.conclusion})`,
        feedback: lines.join("\n"),
      };
    },
  },
  merge_state: {
    isIngestible: (event) => Boolean(event.mergeStateStatus),
    // Only problematic states trigger PR-fix work
    gate: (event) => PROBLEMATIC_MERGE_STATES.includes((event.mergeStateStatus ?? "").toLowerCase()),
    filterTerminalPr: true,
    sourceId: (event) => event.mergeStateStatus ?? "",
    workItem: (event) => ({
      lane: "NORMAL",
      // dirty/conflicting merge states are conflicts; everything else is OTHER
      type: CONFLICTING_STATUSES.has((event.mergeStateStatus ?? "").toLowerCase())
        ? "MERGE_CONFLICT"
        : "OTHER",
      reason: `Merge state change: ${event.mergeStateStatus}`,
      feedback: `PR merge state is now ${event.mergeStateStatus}`,
    }),
  },
};

/**
 * Shared ingestion path for all PR follow-up event types.
 * Returns the evidence key if the event was eligible and enqueued,
 * or null if it was filtered out (gated, terminal PR, not bot-authored,
 * or owner not allowed).
 */
async function ingestEvent(client: PrFixQueueClient, event: PrFollowupEvent): Promise<string | null> {
  const descriptor = INGEST_DESCRIPTORS[event.eventType];
  if (!descriptor.gate(event)) return null;

  // Filter merged/closed PRs — do not enqueue work for terminal PRs
  if (descriptor.filterTerminalPr && (event.prMergedAt || event.prState === "closed")) return null;

  // Check author eligibility
  if (!isAllowedBotAuthor(event.author)) return null;

  // Check repo owner eligibility
  if (!isAllowedBranchOwner(event.repoFullName)) return null;

  const { lane, type, reason, feedback } = descriptor.workItem(event);
  const evidenceKey = computeEvidenceKey(event.eventType, descriptor.sourceId(event), event.repoFullName, event.prNumber);

  await enqueuePrFixItem(client, {
    repo: event.repoFullName,
    pr: event.prNumber,
    lane,
    type,
    reason,
    feedback,
    evidenceKey,
    issue: event.linkedIssue,
    branch: event.branch,
    url: event.url,
    title: event.title,
    author: event.author,
  });

  return evidenceKey;
}

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
  return ingestEvent(client, {
    eventType: "comment",
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
    body: opts.commentBody,
    id: opts.commentId,
    linkedIssue: opts.linkedIssue,
  });
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
    prState?: string | null;
    prMergedAt?: string | null;
    linkedIssue?: number | null;
  },
): Promise<string | null> {
  return ingestEvent(client, {
    eventType: "review",
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
    body: opts.reviewBody,
    id: opts.reviewId,
    state: opts.reviewState,
    prState: opts.prState,
    prMergedAt: opts.prMergedAt,
    linkedIssue: opts.linkedIssue,
  });
}

/**
 * Ingest a single inline review comment (a reviewer finding anchored to a file).
 *
 * Separate from ingestReviewEvent because these are independent of the review
 * verdict: an APPROVED review still carries findings, and dropping them on state
 * alone loses real feedback — observed on foreman-dispatch-bridge#111, whose
 * approving review held four minor findings, two of them on silently swallowed
 * errors.
 */
export async function ingestReviewCommentEvent(
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
    path?: string | null;
    line?: number | null;
    prState?: string | null;
    prMergedAt?: string | null;
    linkedIssue?: number | null;
  },
): Promise<string | null> {
  return ingestEvent(client, {
    eventType: "review_comment",
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
    body: opts.commentBody,
    id: opts.commentId,
    path: opts.path ?? null,
    line: opts.line ?? null,
    prState: opts.prState,
    prMergedAt: opts.prMergedAt,
    linkedIssue: opts.linkedIssue,
  });
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
  return ingestEvent(client, {
    eventType: "check_run",
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
    body: opts.checkDetails,
    id: opts.checkRunId,
    conclusion: opts.conclusion,
    checkName: opts.checkName,
    linkedIssue: opts.linkedIssue,
  });
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
    prState?: string | null;
    prMergedAt?: string | null;
    linkedIssue?: number | null;
  },
): Promise<string | null> {
  return ingestEvent(client, {
    eventType: "merge_state",
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    author: opts.author,
    // The evidence key for merge_state events derives from the status itself.
    id: opts.mergeStateStatus,
    mergeStateStatus: opts.mergeStateStatus,
    prState: opts.prState,
    prMergedAt: opts.prMergedAt,
    linkedIssue: opts.linkedIssue,
  });
}


// ─── Merge Conflict Detection ───────────────────────────────────────────────

/**
 * Detect and enqueue merge conflict items for PRs with mergeable=CONFLICTING.
 * This is the primary function for surfacing merge conflicts as PR review-fix items.
 * 
 * Returns the evidence key if a new item was enqueued, null if skipped (not conflicting,
 * not eligible, or already queued).
 */
export async function ingestMergeConflict(
  client: PrFixQueueClient,
  opts: {
    repoFullName: string;
    prNumber: number;
    branch: string | null;
    url: string;
    title: string;
    author: string | null;
    mergeable: string; // "CONFLICTING", "MERGEABLE", "UNKNOWN"
    linkedIssue?: number | null;
  },
): Promise<string | null> {
  // Only CONFLICTING PRs trigger merge conflict items
  if (opts.mergeable.toUpperCase() !== "CONFLICTING") return null;

  // Check author eligibility
  if (!isAllowedBotAuthor(opts.author)) return null;

  // Check repo owner eligibility
  if (!isAllowedBranchOwner(opts.repoFullName)) return null;

  const evidenceKey = computeEvidenceKey("merge_conflict", "conflicting", opts.repoFullName, opts.prNumber);

  await enqueuePrFixItem(client, {
    repo: opts.repoFullName,
    pr: opts.prNumber,
    lane: "NORMAL",
    type: "MERGE_CONFLICT",
    reason: `Merge conflict detected: PR is CONFLICTING`,
    feedback: `PR has merge conflicts and needs rebase. Use \`git rebase\` to resolve, not patch.`,
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
 * Clear merge conflict items for PRs that are no longer conflicting.
 * This handles idempotent cleanup — items are marked FIXED when the PR
 * becomes mergeable or is closed.
 */
export async function clearResolvedConflictItems(
  client: PrFixQueueClient,
  opts: {
    repoFullName: string;
    prNumber: number;
    mergeable: string; // "MERGEABLE", "CONFLICTING", "UNKNOWN"
  },
): Promise<boolean> {
  // Only clear when PR is no longer conflicting
  if (opts.mergeable.toUpperCase() === "CONFLICTING") return false;

  const existing = await client.prFixQueueItem.findUnique({
    where: { repo_pr: { repo: opts.repoFullName, pr: opts.prNumber } },
  });

  if (!existing) return false;

  // Only clear if it's a merge conflict item and still queued
  if (existing.type !== "MERGE_CONFLICT" || existing.status !== "QUEUED") return false;

  await client.prFixQueueItem.update({
    where: { id: existing.id },
    data: { status: "FIXED" },
  });

  await client.prFixHistory.create({
    data: {
      itemId: existing.id,
      action: "mark",
      status: "FIXED",
      note: `PR is now ${opts.mergeable} — conflict resolved`,
    },
  });

  return true;
}

// ─── Bulk Sync ──────────────────────────────────────────────────────────────

/**
 * Scan a single PR for new follow-up events and enqueue actionable ones.
 * This is used by the periodic sync to catch up on missed events.
 */
export interface PrFollowupEvent {
  eventType: "comment" | "review" | "review_comment" | "check_run" | "merge_state";
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
  prState?: string | null;
  prMergedAt?: string | null;
  linkedIssue?: number | null;
  /** review_comment only: the file and line the inline comment is anchored to. */
  path?: string | null;
  line?: number | null;
}

/**
 * linkedIssue flow: extracted in sync/webhook routes → stored on PrFollowupEvent →
 * passed as `issue` to enqueuePrFixItem → written to Prisma PrFixQueueItem.issue field.
 */

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
      const descriptor = INGEST_DESCRIPTORS[event.eventType];
      if (!descriptor || !descriptor.isIngestible(event)) {
        skipped++;
        continue;
      }
      const key = await ingestEvent(client, event);
      if (key) enqueued++; else skipped++;
    } catch (error) {
      console.error(`Failed to ingest PR followup event (${event.eventType} for ${event.repoFullName}#${event.prNumber}):`, error);
      skipped++;
    }
  }

  return { enqueued, skipped };
}
