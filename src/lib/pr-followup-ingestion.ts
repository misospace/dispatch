/**
 * PR Follow-up Event Ingestion Module
 *
 * Detects PR follow-up events (comments, reviews, failing checks) for tracked repos
 * and enqueues PR-fix work into the assignment queue.
 *
 * Ingestion strategy: pull-based sync (periodic scan of PRs) + webhook-based delivery
 * (real-time GitHub event reception). Both paths converge on the same ingestion logic.
 */

import { EnqueuePrFixInput, enqueuePrFixItem, normalizeQueueRepo, recordPrFixEvidenceBaseline, PrFixQueueClient } from "@/lib/pr-fix-queue";
import { CONFLICTING_STATUSES, FAILURE_CONCLUSIONS } from "@/lib/linked-pr-health";
import { rebaseWorkItem } from "@/lib/pr-fix-rebase";
import { extractFailureMarker, extractFailureWorkflow, isScanFailure } from "@/lib/ci-failure-ingestion";
import { getConfiguredLanes, getEscalationLane } from "@/lib/lane-config";
import { PARKED_COMMENT_MARKER, DISPATCH_FIX_REPLY_MARKER } from "@/lib/pr-fix-surfacing";
import {
  conditionEvidenceKey,
  computeEvidenceContentSignature,
  computeEvidenceVersion,
  isActionableEvidenceVersion,
  type EvidenceVersionFields,
  type PrFixEvidenceKind,
} from "@/lib/pr-fix-evidence";
import { parseFollowupIdentityScopes, type FollowupIdentityScope } from "@/lib/config-parsers";

// The mechanical rebase contract lives in its own module (#1327) so the
// linked-PR health materialization writes the same instruction wall. It is
// re-exported here so every existing importer of the ingestion module keeps
// working unchanged.
export { rebaseWorkItem } from "@/lib/pr-fix-rebase";

// The head/base-repo predicate (#1637/#1638) lives in the pr-fix-queue
// package so every producer and consumer of `PrFixQueueItem` — ingestion,
// the direct enqueue writer, the reconcile drains — enforces the same rule
// without pulling this module's ingestion graph into the queue package.
// Re-exported here so importers of the pinned shared-helper location keep
// working unchanged. Imported (not just export-from) because this module's
// own ingestion gates below call it.
import { isHeadRepoOfBaseRepo } from "./pr-fix-queue/head-repo";
export { isHeadRepoOfBaseRepo };

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
  /**
   * #1665: operator-configured per-identity scopes. An identity named here is
   * narrowed to PRs whose head repository is the base repository AND whose
   * head branch carries one of its prefixes. Logins and prefixes are operator
   * configuration; there are no product defaults.
   */
  identityScopes: FollowupIdentityScope[];
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

  const identityScopes = parseFollowupIdentityScopes(process.env.PR_FOLLOWUP_BOT_IDENTITY_SCOPES);

  return { botIdentities, branchOwnerAllowlist, identityScopes };
}

// ─── Author / Branch Allowlist ──────────────────────────────────────────────

/**
 * Head-repository / head-branch facts a follow-up author decision may need
 * (#1665). All fields optional so legacy single-argument callers keep
 * type-checking; a scoped identity called WITHOUT this context fails closed.
 */
export interface FollowupAuthorContext {
  /** The base (tracked) repository the event was observed in. */
  baseRepoFullName?: string | null;
  /** The PR's head repository full name; null/absent means unverifiable. */
  headRepoFullName?: string | null;
  /** The PR's head branch ref; null/absent means unknown. */
  headBranch?: string | null;
}

/** The operator-configured scope for this login, if any (#1665). */
function identityScopeFor(config: PrFollowupConfig, login: string): FollowupIdentityScope | null {
  return config.identityScopes.find((scope) => scope.login === login) ?? null;
}

/**
 * Check if PR author is allowed bot identity.
 *
 * #1665: an identity carrying an operator-configured scope is narrowed to
 * PRs from the base repository whose head branch matches one of the scope's
 * branch prefixes. The scope FAILS CLOSED when the head facts it needs are
 * missing — no head repository, an unverifiable (foreign or absent) head
 * repo, or no head branch never qualifies — and when the caller supplies no
 * context at all. Unscoped identities keep the exact legacy behavior: this
 * predicate is author-membership only, and the pre-existing gates (terminal
 * PR, branch owner, head-repo proof #1637) still apply downstream to
 * everyone. The explicit /dispatch-fix handoff (#1622) does not run through
 * this predicate and stays unaffected.
 */
export function isAllowedBotAuthor(
  author: string | null | undefined,
  context?: FollowupAuthorContext,
): boolean {
  if (!author) return false;
  const config = getConfig();
  const scope = identityScopeFor(config, author);
  if (!scope && !config.botIdentities.includes(author)) return false;
  if (!scope) return true;

  // Scoped identity: head repository must be proven to be the base repo and
  // the head branch must carry one of the configured prefixes.
  if (!isHeadRepoOfBaseRepo(context?.headRepoFullName, context?.baseRepoFullName)) return false;
  const headBranch = context?.headBranch;
  if (!headBranch) return false;
  return scope.branchPrefixes.some((prefix) => headBranch.startsWith(prefix));
}

/**
 * Check if a login is one of the configured bot identities (the loop's own
 * automation logins). The /dispatch-fix command uses this to stay silent
 * toward bot commenters (#1622): replying to another bot's comment is how
 * bot-to-bot reply loops start.
 *
 * #1665: a login scoped via `PR_FOLLOWUP_BOT_IDENTITY_SCOPES` is also a
 * configured automation identity (it is the operator's declaration that this
 * login is automation), so membership is the union of the flat allowlist and
 * the scoped logins. Scoping narrows automatic follow-up only; it does not
 * change which commenters the reply guard stays silent toward beyond adding
 * these declared automation identities.
 */
export function isBotIdentity(login: string | null | undefined): boolean {
  if (!login) return false;
  const config = getConfig();
  return config.botIdentities.includes(login) || identityScopeFor(config, login) !== null;
}

/**
 * Project the head facts an event carries onto the author-decision context
 * (#1665). Shared by every gate inside this module so the work path, the
 * record-only path, and the conflict path cannot drift apart.
 */
function followupAuthorContextFor(event: {
  repoFullName: string;
  headRepoFullName?: string | null;
  branch: string | null;
}): FollowupAuthorContext {
  return {
    baseRepoFullName: event.repoFullName,
    headRepoFullName: event.headRepoFullName ?? null,
    headBranch: event.branch ?? null,
  };
}

/**
 * Check if the repo owner is in the allowlist.
 * If no allowlist is configured, all owners are allowed (opt-in safety).
 */
export function isAllowedBranchOwner(repoFullName: string | null | undefined): boolean {
  if (!repoFullName) return false;
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
  PARKED_COMMENT_MARKER,
  DISPATCH_FIX_REPLY_MARKER,
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

/**
 * Report whether a comment explicitly directs the loop at itself.
 *
 * An @-mention of a configured bot identity is the only unambiguous "this one is
 * for you" signal a comment carries, so it takes precedence over classification:
 * a human who deliberately asks for a fix should not need to phrase it so that a
 * regex recognises it.
 */
export function mentionsBotIdentity(body: string | undefined | null): boolean {
  if (!body) return false;
  const { botIdentities } = getConfig();
  return botIdentities.some((identity) => body.includes(`@${identity}`));
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
 *
 * `commitMessages` is a fallback for PRs whose title and body carry no
 * reference at all. A PR opened by automation can lose the reference in its
 * body while the commit that did the work still names the issue, and an
 * unlinked PR drops out of follow-up entirely — no linked-issue health, no
 * queued fix, so a CHANGES_REQUESTED review is never acted on.
 *
 * Commits are matched more strictly than the body: only a closing keyword
 * counts. A bare "#123" in a commit message is as likely to be a reference to
 * a prior PR as a declaration of what this one fixes, and a wrong link is
 * worse than none.
 */
const CLOSING_KEYWORD = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/i;

export function extractLinkedIssue(pr: {
  title?: string | null;
  body?: string | null;
  commitMessages?: readonly (string | null | undefined)[];
}): number | null {
  const text = [pr.title, pr.body].filter(Boolean).join("\n");
  const match = text.match(/#(\d+)/);
  if (match) return parseInt(match[1], 10);

  for (const message of pr.commitMessages ?? []) {
    const closing = (message ?? "").match(CLOSING_KEYWORD);
    if (closing) return parseInt(closing[1], 10);
  }
  return null;
}

// ─── Event Ingestion ────────────────────────────────────────────────────────

/** Lane + work-item fields derived from an event by its descriptor. */
interface IngestWorkItem {
  lane: "NORMAL" | "ESCALATED" | "NEEDS_HUMAN";
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
  /**
   * Whether this event is a RECORD-ONLY observation (#1276): a state
   * transition that must update the durable evidence ledger for an existing
   * PR-fix item without enqueueing, reopening, or otherwise touching work.
   * Optional — event types that never observe state transitions omit it.
   */
  recordOnly?: (event: PrFollowupEvent) => boolean;
}

function laneFor(feedback: string): "NORMAL" | "NEEDS_HUMAN" {
  return classifyFeedback(feedback) === "needs_human" ? "NEEDS_HUMAN" : "NORMAL";
}

/**
 * Lane for a CHANGES_REQUESTED review. An ai-pr-reviewer verdict carrying
 * concrete findings is actionable by definition, so route it to NORMAL and let
 * the coder attempt a fix — the stagnation budget (#1543) → ESCALATED → NEEDS_HUMAN
 * ladder handles "coder can't fix it", exactly as it does for CI failures.
 * Without this, the reviewer's narrative prose matches no classifyFeedback
 * pattern and every AI review dead-ends at needs_human. Human prose reviews
 * (no structured payload) still fall back to the keyword classifier.
 *
 * Exported for the /dispatch-fix command (#1622), which enqueues through the
 * same review evidence path and must not grow a diverging lane rule.
 */
export function reviewLane(body: string): "NORMAL" | "NEEDS_HUMAN" {
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
  // attempts the fix, and stagnation exhaustion (#1543) moves it to NEEDS_HUMAN once it has
  // actually failed. "A model tried and could not" beats "a regex guessed it would
  // not". An empty body carries nothing to act on, so that alone stays human.
  return body && body.trim() ? "NORMAL" : "NEEDS_HUMAN";
}


const INGEST_DESCRIPTORS: Record<PrFollowupEvent["eventType"], IngestDescriptor> = {
  comment: {
    isIngestible: (event) => Boolean(event.body && event.id),
    // A comment enqueues work only when it carries actionable signal, or when it
    // @-mentions the loop. Everything else — CI chatter, status reports, human
    // discussion — is left alone.
    //
    // This default used to point the other way: an unclassifiable comment became
    // NEEDS_HUMAN and blocked the PR, so any comment nobody had anticipated
    // stopped the loop. The costs are lopsided. Ignoring a real ask delays it
    // until someone follows up; ingesting a state report re-enqueues the item on
    // every sweep, burns a coder each time, and needs a human to unstick.
    // Observed on misospace/pinchflat#25, where a "🐳 Image for commit ...
    // published" comment re-queued the item four sweeps running.
    //
    // Marker-matching alone loses this race: INFORMATIONAL_COMMENT_MARKERS was
    // extended once already for a size-diff table (llmkube-images#114) and the
    // next bot's format walked straight through it.
    gate: (event) =>
      !isInformationalComment(event.body) &&
      (mentionsBotIdentity(event.body) || classifyFeedback(event.body ?? "") === "actionable"),
    filterTerminalPr: false,
    sourceId: (event) => event.id,
    workItem: (event) => ({
      lane: "NORMAL",
      type: "REVIEW_FEEDBACK",
      reason: "PR comment: actionable feedback",
      feedback: event.body ?? "",
    }),
  },
  review: {
    isIngestible: (event) => Boolean(event.state && event.id),
    // Only a review that DEMANDS work triggers PR-fix work (not APPROVED or
    // COMMENTED). Both predicates below read the ledger's own actionability
    // decision rather than string literals, so the work gate, the record-only
    // branch, and the `actionable` stamp the row is written with can never
    // disagree about the same state (#1276 review).
    gate: (event) => isActionableEvidenceVersion("review", { state: event.state }),
    // Every OTHER review state is a record-only observation of the same
    // identity (#1276). The sync used to drop APPROVED/COMMENTED/DISMISSED
    // reviews on the way in, so a review leaving CHANGES_REQUESTED never
    // reached the ledger and the item kept a stale actionable baseline forever.
    // Recording the transition is what makes the dismissal visible; enqueueing
    // from it is exactly what must not happen.
    recordOnly: (event) => Boolean(event.state) && !isActionableEvidenceVersion("review", { state: event.state }),
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
      // The job URL is evidence, not the item URL: `url` is the PR URL and the
      // job URL belongs in the feedback text. The `?? event.url` fallback keeps
      // legacy callers (no checkRunUrl) behaving as before (#1098).
      const logUrl = event.checkRunUrl ?? event.url;
      const excerpt = event.body?.trim();
      const lines = [`CI check "${checkName}" failed (${event.conclusion}) on this PR.`];
      if (excerpt) {
        lines.push("", "Error from the job log:", excerpt);
      }
      if (logUrl) {
        lines.push("", `Full log: ${logUrl}`);
      }
      if (!excerpt) {
        lines.push("Read the full log at the URL above to find the error, then fix the root cause.");
      } else {
        lines.push("", "Fix the root cause the log shows.");
      }
      return {
        // A failing check is actionable work for coder-revision by definition —
        // don't classify it by prose (an empty body would misroute to NEEDS_HUMAN).
        // The escalation ladder (stagnation exhaustion -> ESCALATED -> NEEDS_HUMAN, #1543)
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
    // Only problematic states trigger PR-fix work. Like the `review` gate
    // above, this reads the ledger's own actionability decision rather than a
    // string list, so the work gate, the record-only branch, and the
    // `actionable` stamp the row is written with can never disagree about the
    // same state (#1276 review).
    gate: (event) => isActionableEvidenceVersion("merge_state", { mergeStateStatus: event.mergeStateStatus }),
    // A DEFINITE non-problematic state is a record-only observation of the
    // same stable identity (#1276 review). The sync used to drop `clean` and
    // every other non-problematic re-read on the way in, so the ledger row for
    // `merge_state:<repo>#<pr>` stayed frozen at its last `dirty`/`behind`
    // version with `actionable: true` — a baseline that no longer describes the
    // PR, and that any consumer of the durable per-condition baseline (#1253's
    // `evaluateEvidenceFreshness`) would read as a live condition. Recording
    // the cleared version is what makes the clearing visible; enqueueing from
    // it is exactly what must not happen.
    //
    // `unknown` DEFERS: GitHub is still computing mergeability, so it is the
    // absence of an observation, not a cleared one — recording it would
    // overwrite an actionable `dirty` baseline with a non-actionable version at
    // a higher sequence, silencing a real condition. This is the same defer
    // rule `evidenceFieldsFor` applies to an unread `review_comment` thread
    // state below.
    recordOnly: (event) =>
      Boolean(event.mergeStateStatus) &&
      (event.mergeStateStatus ?? "").toLowerCase() !== "unknown" &&
      !isActionableEvidenceVersion("merge_state", { mergeStateStatus: event.mergeStateStatus }),
    filterTerminalPr: true,
    sourceId: (event) => event.mergeStateStatus ?? "",
    workItem: (event) => {
      // dirty/conflicting merge states go through the mechanical rebase lane
      // (#1327) — code-fix attempts cannot resolve a merge conflict they
      // cannot rebase away. Everything else stays ordinary fix work.
      if (CONFLICTING_STATUSES.has((event.mergeStateStatus ?? "").toLowerCase())) {
        return rebaseWorkItem(event.mergeStateStatus ?? "dirty");
      }
      return {
        lane: "NORMAL",
        type: "OTHER",
        reason: `Merge state change: ${event.mergeStateStatus}`,
        feedback: `PR merge state is now ${event.mergeStateStatus}`,
      };
    },
  },
};

/**
 * Durable per-event evidence block (#1249). The pure helpers in `pr-fix-evidence`
 * own the canonical version / actionability / content-signature logic; this is a
 * thin projection from a follow-up event onto the ledger's `evidence*` fields.
 * `merge_state` uses a stable per-PR identity (`conditionEvidenceKey`) so a PR's
 * repeated merge-state observations are not treated as distinct work.
 */
function evidenceFieldsFor(event: PrFollowupEvent) {
  const kind: PrFixEvidenceKind = event.eventType;
  // #1249: a `review_comment` ledger row is only written when the thread
  // state was actually READ. Unknown thread state DEFERS: the observation
  // falls back to the pre-#1249 bounded-cache semantics instead of recording
  // an unknown-version row — a transient GraphQL failure never overwrites a
  // known resolved/unresolved baseline (which could either strand real
  // feedback or flip a cleared thread back to fresh).
  if (kind === "review_comment" && event.threadResolved == null && event.threadOutdated == null) {
    return {
      evidenceKind: null,
      evidenceVersion: null,
      evidenceContentSignature: null,
      evidenceObservedAt: null,
      evidenceActionable: null,
      evidenceHeadSha: null,
      evidenceSource: null,
      evidenceKey: computeEvidenceKey(
        event.eventType,
        INGEST_DESCRIPTORS[event.eventType].sourceId(event),
        event.repoFullName,
        event.prNumber,
      ),
    };
  }
  const fields: EvidenceVersionFields = {
    state: event.state ?? null,
    commitId: event.commitId ?? null,
    updatedAt: event.updatedAt ?? null,
    resolved: event.threadResolved ?? null,
    outdated: event.threadOutdated ?? null,
    actorLogin: event.actorLogin ?? event.author ?? null,
    headSha: event.headSha ?? null,
    checkStatus: event.checkStatus ?? null,
    conclusion: event.conclusion ?? null,
    mergeStateStatus: event.mergeStateStatus ?? null,
  };
  const evidenceVersion = computeEvidenceVersion(kind, fields);
  const evidenceActionable = isActionableEvidenceVersion(kind, fields);
  const hasBody = kind === "review" || kind === "comment" || kind === "review_comment";
  const evidenceContentSignature = hasBody
    ? computeEvidenceContentSignature({
        body: event.body ?? null,
        actorLogin: fields.actorLogin,
        state: event.state ?? null,
        commitId: event.commitId ?? null,
      })
    : null;
  const evidenceObservedAt =
    kind === "review"
      ? event.submittedAt ?? null
      : kind === "comment" || kind === "review_comment"
        ? event.updatedAt ?? null
        : kind === "check_run"
          ? event.completedAt ?? null
          : null;
  const evidenceKey =
    kind === "merge_state"
      ? conditionEvidenceKey("merge_state", event.repoFullName, event.prNumber)
      : computeEvidenceKey(event.eventType, INGEST_DESCRIPTORS[event.eventType].sourceId(event), event.repoFullName, event.prNumber);

  return {
    evidenceKind: kind,
    evidenceVersion,
    evidenceContentSignature,
    evidenceObservedAt,
    evidenceActionable,
    evidenceHeadSha: event.headSha ?? null,
    evidenceSource: event.source ?? null,
    evidenceKey,
  };
}

/**
 * Shared ingestion path for all PR follow-up event types.
 * Returns the evidence key if the event was eligible and enqueued,
 * or null if it was filtered out (gated, terminal PR, not bot-authored,
 * or owner not allowed), or if it was a record-only observation (#1276) —
 * a ledger update that enqueues nothing and is therefore reported as
 * not-enqueued so the caller's counters stay honest about real work.
 */
async function ingestEvent(client: PrFixQueueClient, event: PrFollowupEvent): Promise<string | null> {
  const descriptor = INGEST_DESCRIPTORS[event.eventType];

  // #1276: a record-only observation short-circuits BEFORE the work gate. It
  // enqueues nothing, so it must never be decided by `gate` (which exists to
  // filter work), but it IS still subject to the same eligibility filters as a
  // work event: a terminal PR, a non-bot-authored PR, or a disallowed branch
  // owner is not an observation of this queue's work at all.
  if (descriptor.recordOnly?.(event)) {
    if (descriptor.filterTerminalPr && (event.prMergedAt || event.prState === "closed")) return null;
    // #1665: the same eligibility filters as a work event, scoping included —
    // an observation of a PR outside a scoped identity's rule is not an
    // observation of this queue's work either.
    if (!isAllowedBotAuthor(event.author, followupAuthorContextFor(event))) return null;
    if (!isAllowedBranchOwner(event.repoFullName)) return null;
    // #1637: an observation of a fork PR is not an observation of this queue's
    // work either — the same eligibility filter as a work event. Consequence:
    // a legacy fork row's actionable baseline stops advancing, so it can no
    // longer be re-offered by evidence-driven recovery; conflict rows still
    // drain through the ungated `clearResolvedConflictItems` settle path.
    if (!isHeadRepoOfBaseRepo(event.headRepoFullName, event.repoFullName)) return null;
    if (!descriptor.isIngestible(event)) return null;
    const { evidenceKey, ...evidence } = evidenceFieldsFor(event);
    await recordPrFixEvidenceBaseline(client, {
      repo: event.repoFullName,
      pr: event.prNumber,
      evidenceKey,
      ...evidence,
    });
    return null;
  }

  if (!descriptor.gate(event)) return null;

  // Filter merged/closed PRs — do not enqueue work for terminal PRs
  if (descriptor.filterTerminalPr && (event.prMergedAt || event.prState === "closed")) return null;

  // Check author eligibility. #1665: a scoped identity must also match its
  // head-repository + head-branch rule; unscoped identities pass on
  // membership alone, unchanged.
  if (!isAllowedBotAuthor(event.author, followupAuthorContextFor(event))) return null;

  // Check repo owner eligibility
  if (!isAllowedBranchOwner(event.repoFullName)) return null;

  // #1637: the owner check above reads the BASE repo, so a fork PR passes it
  // while its branch names a branch of the fork. Verify the head repo IS the
  // base repo before accepting queue work; refuse when it is a different repo
  // or cannot be verified at all (fail-closed, mirroring the /dispatch-fix
  // gate in #1622/#1634).
  if (!isHeadRepoOfBaseRepo(event.headRepoFullName, event.repoFullName)) return null;

  let { lane, type, reason, feedback } = descriptor.workItem(event);
  if (event.eventType === "check_run" && event.linkedIssue !== null && event.linkedIssue !== undefined) {
    const checkName = event.checkName ?? "unknown";
    const excerpt = event.body?.trim() ?? "";
    try {
      const issue = await client.issue.findFirst({
        where: {
          repository: { fullName: event.repoFullName },
          number: event.linkedIssue,
        },
        select: { body: true, currentLane: true },
      });
      const signature = extractFailureMarker(issue?.body);
      const escalationLane = getEscalationLane();
      const hasExplicitEscalationLane = getConfiguredLanes().some(
        (lane) => lane.claimable && lane.role === "escalation" && lane.id === escalationLane?.id,
      );
      if (
        signature &&
        isScanFailure(checkName, checkName, excerpt) &&
        hasExplicitEscalationLane &&
        issue?.currentLane === escalationLane?.id
      ) {
        const workflow = extractFailureWorkflow(issue.body) ?? checkName;
        lane = "ESCALATED";
        feedback = `Recurrence of scan failure filed as #${event.linkedIssue} (workflow ${workflow}, signature ${signature}).\n${feedback}`;
      }
    } catch (error) {
      console.warn("[pr-followup-ingestion] linked issue lookup failed", {
        repo: event.repoFullName,
        issue: event.linkedIssue,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  const { evidenceKey, ...evidence } = evidenceFieldsFor(event);

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
    headSha: event.headSha ?? null,
    author: event.author,
    ...evidence,
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
    /** PR head repository full name (#1637); required proof for queue work. */
    headRepoFullName?: string | null;
    linkedIssue?: number | null;
    /** The comment author's login (drives the durable `actor=` slot). */
    actorLogin?: string | null;
    updatedAt?: string | null;
    headSha?: string | null;
    source?: "sync" | "webhook";
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
    headRepoFullName: opts.headRepoFullName ?? null,
    linkedIssue: opts.linkedIssue,
    actorLogin: opts.actorLogin,
    updatedAt: opts.updatedAt,
    headSha: opts.headSha ?? null,
    source: opts.source,
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
    /** PR head repository full name (#1637); required proof for queue work. */
    headRepoFullName?: string | null;
    prState?: string | null;
    prMergedAt?: string | null;
    linkedIssue?: number | null;
    /** The review author's login (drives the durable `actor=` slot). */
    actorLogin?: string | null;
    commitId?: string | null;
    submittedAt?: string | null;
    headSha?: string | null;
    source?: "sync" | "webhook";
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
    headRepoFullName: opts.headRepoFullName ?? null,
    prState: opts.prState,
    prMergedAt: opts.prMergedAt,
    linkedIssue: opts.linkedIssue,
    actorLogin: opts.actorLogin,
    commitId: opts.commitId,
    submittedAt: opts.submittedAt,
    headSha: opts.headSha ?? null,
    source: opts.source,
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
    /** PR head repository full name (#1637); required proof for queue work. */
    headRepoFullName?: string | null;
    prState?: string | null;
    prMergedAt?: string | null;
    linkedIssue?: number | null;
    /** The review-comment author's login (drives the durable `actor=` slot). */
    actorLogin?: string | null;
    commitId?: string | null;
    updatedAt?: string | null;
    threadResolved?: boolean | null;
    threadOutdated?: boolean | null;
    headSha?: string | null;
    source?: "sync" | "webhook";
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
    headRepoFullName: opts.headRepoFullName ?? null,
    prState: opts.prState,
    prMergedAt: opts.prMergedAt,
    linkedIssue: opts.linkedIssue,
    actorLogin: opts.actorLogin,
    commitId: opts.commitId,
    updatedAt: opts.updatedAt,
    threadResolved: opts.threadResolved,
    threadOutdated: opts.threadOutdated,
    headSha: opts.headSha ?? null,
    source: opts.source,
  });
}

/**
 * Ingest a failing check run event.
 *
 * `url` must be the PR URL; the check-run job URL goes in `checkRunUrl`
 * (#1098) — it is evidence for the feedback text, not the item identity.
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
    checkRunUrl?: string | null;
    checkDetails?: string;
    /** PR head repository full name (#1637); required proof for queue work. */
    headRepoFullName?: string | null;
    linkedIssue?: number | null;
    checkStatus?: string | null;
    completedAt?: string | null;
    headSha?: string | null;
    source?: "sync" | "webhook";
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
    checkRunUrl: opts.checkRunUrl ?? null,
    conclusion: opts.conclusion,
    checkName: opts.checkName,
    headRepoFullName: opts.headRepoFullName ?? null,
    linkedIssue: opts.linkedIssue,
    checkStatus: opts.checkStatus,
    completedAt: opts.completedAt,
    headSha: opts.headSha ?? null,
    source: opts.source,
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
    /** PR head repository full name (#1637); required proof for queue work. */
    headRepoFullName?: string | null;
    prState?: string | null;
    prMergedAt?: string | null;
    linkedIssue?: number | null;
    headSha?: string | null;
    source?: "sync" | "webhook";
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
    // The evidence key for merge_state events is now a stable per-PR identity.
    id: opts.mergeStateStatus,
    headRepoFullName: opts.headRepoFullName ?? null,
    mergeStateStatus: opts.mergeStateStatus,
    prState: opts.prState,
    prMergedAt: opts.prMergedAt,
    linkedIssue: opts.linkedIssue,
    headSha: opts.headSha ?? null,
    source: opts.source,
  });
}


// ─── Merge Conflict Detection ───────────────────────────────────────────────

/**
 * Detect and enqueue merge conflict items for PRs with mergeable=CONFLICTING.
 * This is the primary function for surfacing merge conflicts as PR review-fix items.
 *
 * Since #1327 the item is type REBASE (mechanical rebase lane), not
 * MERGE_CONFLICT: the fix loop's code attempts cannot rebase, so a DIRTY PR
 * cycling fixed generations was pure quota burn. The `MERGE_CONFLICT` type
 * remains valid for legacy rows.
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
    /**
     * PR head repository full name (#1637). The conflict/REBASE work is only
     * accepted when this matches the base repo (case-insensitive); null or a
     * foreign repo refuses the row fail-closed.
     */
    headRepoFullName?: string | null;
    linkedIssue?: number | null;
    headSha?: string | null;
    source?: "sync" | "webhook";
  },
): Promise<string | null> {
  // Only CONFLICTING PRs trigger merge conflict items
  if (opts.mergeable.toUpperCase() !== "CONFLICTING") return null;

  // Check author eligibility. #1665: a scoped identity must also match its
  // head-repository + head-branch rule here (merge conflicts are ingested
  // directly by the sync scan, not through ingestEvent).
  if (
    !isAllowedBotAuthor(opts.author, {
      baseRepoFullName: opts.repoFullName,
      headRepoFullName: opts.headRepoFullName ?? null,
      headBranch: opts.branch ?? null,
    })
  ) {
    return null;
  }

  // Check repo owner eligibility
  if (!isAllowedBranchOwner(opts.repoFullName)) return null;

  // #1637: a CONFLICTING fork PR must not enter the REBASE lane either — the
  // rebase worker operates on the base repo, where the fork's branch does not
  // exist. Fail closed when the head repo is unverifiable or foreign.
  if (!isHeadRepoOfBaseRepo(opts.headRepoFullName, opts.repoFullName)) return null;

  // #1249: a stable per-PR identity (not state-derived) so repeated
  // conflicting observations on the same PR are not distinct work.
  const evidenceKey = conditionEvidenceKey("merge_conflict", opts.repoFullName, opts.prNumber);
  const conditionFields: EvidenceVersionFields = {
    mergeable: opts.mergeable,
    headSha: opts.headSha ?? null,
  };
  const evidenceVersion = computeEvidenceVersion("merge_conflict", conditionFields);
  const evidenceActionable = isActionableEvidenceVersion("merge_conflict", conditionFields);

  await enqueuePrFixItem(client, {
    repo: opts.repoFullName,
    pr: opts.prNumber,
    ...rebaseWorkItem(`CONFLICTING`),
    evidenceKey,
    issue: opts.linkedIssue,
    branch: opts.branch,
    url: opts.url,
    title: opts.title,
    headSha: opts.headSha ?? null,
    author: opts.author,
    evidenceKind: "merge_conflict",
    evidenceVersion,
    evidenceContentSignature: null,
    evidenceObservedAt: null,
    evidenceActionable,
    evidenceHeadSha: opts.headSha ?? null,
    evidenceSource: opts.source ?? null,
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
    /**
     * PR head SHA at observation time. Drives the cleared condition's version
     * (`mergeable=<state>|head=<sha>`), so a re-conflict at the same head is
     * still a transition rather than a replay of the cleared version.
     */
    headSha?: string | null;
  },
): Promise<boolean> {
  // Only clear when PR is no longer conflicting
  if (opts.mergeable.toUpperCase() === "CONFLICTING") return false;

  const existing = await client.prFixQueueItem.findUnique({
    where: { repo_pr: { repo: normalizeQueueRepo(opts.repoFullName), pr: opts.prNumber } },
  });

  if (!existing) return false;

  // Only clear if it is a conflicts item and still queued. New items are
  // type REBASE (#1327); MERGE_CONFLICT covers legacy rows the fix loop may
  // still hold. A REBASE row clearing here is the lane's success path when
  // GitHub's merge-state recomputes lag the pushed rebase.
  if (existing.type !== "REBASE" && existing.type !== "MERGE_CONFLICT") return false;
  if (existing.status !== "QUEUED") return false;

  // #1276 review: settle nothing before the ledger says the condition cleared.
  // The `merge_conflict:<repo>#<pr>` row is otherwise left at its last
  // `mergeable=conflicting` version with `actionable: true` — a baseline that
  // contradicts the PR, which is why the clearing is recorded here rather than
  // only in the bounded cache. ORDER MATTERS: recording first means a crash
  // between the two leaves a stale QUEUED item (safe — the next sync re-runs
  // idempotently) rather than a settled item whose baseline still says
  // "conflicting" (unsafe — the contradiction outlives the settle).
  // `evidenceActionable: false` is literal because the guard above already
  // proved the PR is not CONFLICTING; the cleared write never re-derives
  // actionability from a second read.
  try {
    await recordPrFixEvidenceBaseline(client, {
      repo: opts.repoFullName,
      pr: opts.prNumber,
      evidenceKey: conditionEvidenceKey("merge_conflict", opts.repoFullName, opts.prNumber),
      evidenceKind: "merge_conflict",
      evidenceVersion: computeEvidenceVersion("merge_conflict", {
        mergeable: opts.mergeable,
        headSha: opts.headSha ?? null,
      }),
      evidenceContentSignature: null,
      evidenceObservedAt: null,
      evidenceActionable: false,
      evidenceHeadSha: opts.headSha ?? null,
      evidenceSource: "sync",
    });
  } catch (error) {
    // Best-effort with respect to the settle: the conflict really did clear,
    // so leaving the item QUEUED on a ledger write error would strand work
    // that no longer exists. The worst case is a stale actionable row on an
    // already-settled item, which contradicts the PR but enqueues nothing:
    // condition kinds are not actionable post-dispatch evidence today
    // (`hasActionablePostDispatchEvidence` reads only review/comment/check_run).
    console.warn("[pr-followup-ingestion] cleared merge-conflict ledger record failed", {
      repo: opts.repoFullName,
      pr: opts.prNumber,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }

  await client.prFixQueueItem.update({
    where: { id: existing.id },
    // #1249: settling FIXED here ends the attempt, so its evidence snapshot
    // boundary is cleared like every other terminal disposition — the durable
    // read of a settled item must find no post-watermark evidence.
    data: { status: "FIXED", attemptEvidenceWatermark: null },
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
  /**
   * Full name of the PR's HEAD repository (#1637). Queue work is accepted
   * only when this matches the base repo (case-insensitive): a fork PR's
   * `branch` names a branch of the fork, where the fix worker never operates.
   * Null/absent means unverifiable and is refused fail-closed — the payload
   * projections (sync route, webhook route) carry it from the PR object;
   * producers whose payload shape never does (webhook `issue_comment`) stop
   * enqueuing on this path and fall back to the sync scan, which does.
   */
  headRepoFullName?: string | null;
  url: string;
  title: string;
  author: string | null;
  body?: string;
  id: string;
  state?: string;
  conclusion?: string;
  checkName?: string;
  /**
   * The check-run job URL for `check_run` events. `url` is always the PR URL;
   * the job URL is evidence for the feedback text (#1098).
   */
  checkRunUrl?: string | null;
  mergeStateStatus?: string;
  prState?: string | null;
  prMergedAt?: string | null;
  linkedIssue?: number | null;
  /** review_comment only: the file and line the inline comment is anchored to. */
  path?: string | null;
  line?: number | null;
  /**
   * PR head SHA at enqueue time. Used by `enqueuePrFixItem` and `markPrFixItem`
   * to detect "the workload reported done but the PR head never moved" — without
   * it, a successful run that pushed nothing strands the PR with `CHANGES_REQUESTED`
   * and the queue records `FIXED` (#940).
   */
  headSha?: string | null;
  /**
   * The feedback author's login (comment/review body author). Distinct from
   * `author` (the PR's author, used for the bot-author gate). Drives the
   * durable `actor=` slot in the evidence version / content signature.
   */
  actorLogin?: string | null;
  /** The commit the review/comment was written against (REST `commit_id`). */
  commitId?: string | null;
  /** review: REST `submitted_at`. */
  submittedAt?: string | null;
  /** comment / review_comment: REST `updated_at`. */
  updatedAt?: string | null;
  /** review_comment: whether its review thread is resolved (GraphQL). */
  threadResolved?: boolean | null;
  /** review_comment: whether its review thread is outdated (GraphQL). */
  threadOutdated?: boolean | null;
  /** check_run: REST lifecycle `status`. */
  checkStatus?: string | null;
  /** check_run: REST `completed_at`. */
  completedAt?: string | null;
  /** Ingestion source label recorded in the ledger (`sync` / `webhook`). */
  source?: "sync" | "webhook";
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
    if (!event.repoFullName) {
      console.warn(
        `Skipping PR followup event (${event.eventType} #${event.prNumber}): no repository full name in payload`,
      );
      skipped++;
      continue;
    }
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
