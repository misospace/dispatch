import {
  addIssueComment,
  addIssueLabel,
  fetchIssueComments,
  fetchPullRequestState,
  removeIssueLabel,
  updateIssueComment,
} from "@/lib/github";
import { normalizePrFixOutcome, type PrFixDecisionContext, type PrFixOutcome } from "@/types";

export const NEEDS_HUMAN_LABEL = "needs-human";
export const NEEDS_HUMAN_COMMENT_MARKER = "<!-- dispatch-pr-fix-blocked -->";
export const PARKED_COMMENT_MARKER = "<!-- dispatch-pr-fix-parked -->";

export interface PrFixSurfaceContext {
  /**
   * Dispatchable worker executions for this item (`PrFixQueueItem.fixAttempts`).
   * This — not the enqueue/feedback row count — is the number that actually
   * bounds the loop.
   */
  workerExecutions?: number | null;
  /**
   * Number of `enqueue` history rows (evidence observations), reported
   * separately from worker executions so the two are never conflated (#1218).
   */
  enqueueRows?: number | null;
  /** Enqueue rows grouped by lane, keyed by lane name (or "unknown"). */
  attemptsByLane?: Record<string, number>;
  /** Concise description of the final failure once the loop gave up. */
  finalFailureSignature?: string | null;
  /** URLs of the failing runs that exhausted the attempts, when present. */
  failingRunLinks?: string[];
  /** Summary/context from the last attempt, when any data is available. */
  lastAttemptSummary?: string | null;
  /**
   * #1253: fresh actionable evidence arrived while the item sat in a
   * disposition evidence must not override (BLOCKED human decision,
   * cap-exhausted or fail-closed PARKED). Surfaced for operators; the flag
   * never reopens anything by itself.
   */
  staleDisposition?: boolean;
  /** Retained for back-compat; do NOT render it as "attempts" (#1218). */
  totalAttempts?: number | null;
}

export interface SurfacePrFixBlockedInput {
  repo: string;
  pr: number;
  reason: string;
  latestNote?: string | null;
  context?: PrFixSurfaceContext | null;
  decision?: PrFixDecisionContext | null;
}

export interface SurfacePrFixParkedInput {
  repo: string;
  pr: number;
  reason: string;
  outcome?: string | null;
  latestNote?: string | null;
  context?: PrFixSurfaceContext | null;
  /**
   * Best-effort retraction of the `needs-human` label (#1218). A BLOCKED item
   * that later parks (bounded exhaustion / infra / security) must not keep the
   * label that claims a human decision is pending. Off by default.
   */
  removeNeedsHumanLabel?: boolean;
}

export interface SurfacePrFixParkedResult {
  /** True when the `needs-human` label was removed (only when requested). */
  labelRemoved: boolean;
  /** True when a fresh marker comment was posted. */
  commentPosted: boolean;
  /** True when an existing marker comment was PATCHed in place. */
  commentUpdated: boolean;
  /** True when the PR was already merged or closed, so nothing was written. */
  skippedTerminal: boolean;
  errors: string[];
}

export interface SurfacePrFixBlockedResult {
  labelApplied: boolean;
  /** True when a fresh marker comment was posted. */
  commentPosted: boolean;
  /** True when an existing marker comment was PATCHed in place. */
  commentUpdated: boolean;
  /** True when the PR was already merged or closed, so nothing was written. */
  skippedTerminal: boolean;
  errors: string[];
}

function formatLaneAttempts(context: PrFixSurfaceContext): string | null {
  if (!context.attemptsByLane || Object.keys(context.attemptsByLane).length === 0) return null;
  const parts = Object.entries(context.attemptsByLane)
    .map(([lane, count]) => `- **${lane}:** ${count}`)
    .join("\n");
  return `\n**Enqueues by lane:**\n${parts}`;
}

function formatFailingRunLinks(links: string[] | undefined): string | null {
  const list = (links ?? []).filter((u) => u && typeof u === "string");
  if (list.length === 0) return null;
  return `\n**Failing run(s):**\n${list.map((u) => `- ${u}`).join("\n")}`;
}

/**
 * Metrics truthfulness (#1218): report the worker-execution count and the
 * enqueue/evidence row count as two distinct numbers. Neither is labelled
 * "attempts" — conflating them is exactly what made exhaustion look like a
 * design decision.
 */
function formatMetrics(context: PrFixSurfaceContext): string[] {
  const lines: string[] = [];
  if (typeof context.workerExecutions === "number") {
    lines.push(`**Worker executions:** ${context.workerExecutions}`);
  }
  if (typeof context.enqueueRows === "number") {
    lines.push(`**Enqueue rows:** ${context.enqueueRows}`);
  }
  return lines;
}

function formatDecision(decision: PrFixDecisionContext | null | undefined): string[] {
  if (!decision) return [];
  const lines: string[] = [];
  if (decision.question) lines.push("", `**Decision needed:** ${decision.question}`);
  if (Array.isArray(decision.options) && decision.options.length > 0) {
    lines.push("", "**Options:**", ...decision.options.map((o) => `- ${o}`));
  }
  if (decision.evidence) lines.push("", `**Evidence:** ${decision.evidence}`);
  return lines;
}

/**
 * Append the attempt context shared by the BLOCKED and PARKED notices: metrics,
 * per-lane enqueue counts, final failure, failing run links, last attempt
 * summary, and the stale-disposition note (#1253). Kept in one place so the two
 * surfaces cannot drift apart.
 */
function appendSurfaceContext(lines: string[], context: PrFixSurfaceContext): void {
  for (const metric of formatMetrics(context)) lines.push("", metric);

  const laneText = formatLaneAttempts(context);
  if (laneText) lines.push("", laneText);

  if (context.finalFailureSignature) {
    lines.push("", `**Final failure:** ${context.finalFailureSignature}`);
  }

  const runLinks = formatFailingRunLinks(context.failingRunLinks);
  if (runLinks) lines.push("", runLinks);

  if (context.lastAttemptSummary) {
    lines.push("", `**Last attempt:** ${context.lastAttemptSummary}`);
  }

  if (context.staleDisposition) {
    lines.push(
      "",
      "**Note:** Fresh actionable feedback arrived after this disposition was recorded; it did not reopen the item (#1253).",
    );
  }
}

/**
 * Build the markdown comment body for a BLOCKED PR-fix item.
 *
 * Everything except `reason` is optional so historical and minimally-reported
 * blocks (a plain enqueue with no attempt context) still render a useful,
 * non-empty comment.
 */
export function buildNeedsHumanComment(input: SurfacePrFixBlockedInput): string {
  const context = input.context ?? {};
  const lines: string[] = [
    NEEDS_HUMAN_COMMENT_MARKER,
    "",
    "> ⚠️ This PR fix item has been marked as **BLOCKED** and needs human attention.",
    "",
    `**Reason:** ${input.reason}`,
  ];

  appendSurfaceContext(lines, context);

  lines.push(...formatDecision(input.decision));

  if (input.latestNote) {
    lines.push("", `**Latest note:** ${input.latestNote}`);
  }

  lines.push(
    "",
    `Posted automatically by Dispatch on ${new Date().toISOString()}`,
  );

  return lines.join("\n");
}

const PARKED_HEADLINES: Record<PrFixOutcome, string> = {
  no_progress:
    "> ⏸️ This PR fix item is **PARKED** after repeated attempts without progress. It is not waiting on a human decision; an operator can requeue it to retry.",
  infra_failure:
    "> ⏸️ This PR fix item is **PARKED** after an infrastructure or authentication failure. An operator can requeue it once the environment is healthy.",
  security_failure:
    "> ⏸️ This PR fix item is **PARKED** after a security failure. An operator must investigate before requeuing.",
  human_decision:
    "> ⏸️ This PR fix item is **PARKED**. An operator can requeue it to retry.",
  invalid_wait:
    "> ⏸️ This PR fix item reported an external wait without a verifiable dependency, so it was parked fail-closed (#1250). An operator can requeue it once a concrete dependency is identified.",
};

/**
 * Build the markdown comment body for a PARKED PR-fix item (#1218). Mirrors
 * `buildNeedsHumanComment` but carries no needs-human claim: a parked item is
 * bounded exhaustion or an operational failure, not a design decision.
 */
export function buildParkedComment(input: SurfacePrFixParkedInput): string {
  const context = input.context ?? {};
  const outcome = normalizePrFixOutcome(input.outcome) ?? "no_progress";
  const lines: string[] = [
    PARKED_COMMENT_MARKER,
    "",
    PARKED_HEADLINES[outcome],
    "",
    `**Reason:** ${input.reason}`,
    "",
    `**Outcome:** ${outcome}`,
  ];

  appendSurfaceContext(lines, context);

  if (input.latestNote) {
    lines.push("", `**Latest note:** ${input.latestNote}`);
  }

  lines.push(
    "",
    `Posted automatically by Dispatch on ${new Date().toISOString()}`,
  );

  return lines.join("\n");
}

/** Extract `https://...` URLs conservatively from free text and dedupe. */
export function extractUrlsFromText(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const regex = /https:\/\/[^\s"'<>]+/g;
  for (const match of text.matchAll(regex)) {
    const url = match[0].replace(/[),.;]+$/, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function isTerminalState(prState: { state: string | null; mergedAt: string | null }): boolean {
  return prState.state === null || prState.state === "closed" || Boolean(prState.mergedAt);
}

/**
 * The marker a Dispatch-owned comment starts with, if any (#1218). A BLOCKED
 * item writes the needs-human marker; a PARKED item writes the parked marker.
 * Both surfaces recognize EITHER marker so a re-surface (or an unblock) folds
 * the single existing comment in place instead of posting a duplicate.
 */
function detectDispatchMarker(body: string | null | undefined): string | null {
  const trimmed = (body ?? "").trimStart();
  if (trimmed.startsWith(NEEDS_HUMAN_COMMENT_MARKER)) return NEEDS_HUMAN_COMMENT_MARKER;
  if (trimmed.startsWith(PARKED_COMMENT_MARKER)) return PARKED_COMMENT_MARKER;
  return null;
}

function isDispatchMarkerComment(body: string | null | undefined): boolean {
  return detectDispatchMarker(body) !== null;
}

/**
 * Post a surface notice, or PATCH the existing Dispatch marker comment in
 * place. `buildBody` receives the existing marker body (null when there is
 * none) so a caller can fold its notice into the comment already on the PR.
 */
async function writeMarkerComment(
  repo: string,
  pr: number,
  buildBody: (existingBody: string | null) => string | null,
): Promise<{ posted: boolean; updated: boolean }> {
  const existing = await fetchIssueComments(repo, pr, 100, "desc");
  const marker = existing.find((c) => isDispatchMarkerComment(c.body));
  if (marker) {
    // A marker without an id (old caller / mocked data) is treated as present:
    // the anti-spam guard wins over freshness.
    if (typeof marker.id !== "number") return { posted: false, updated: false };
    const body = buildBody(marker.body ?? null);
    if (body === null) return { posted: false, updated: false };
    await updateIssueComment(repo, marker.id, body);
    return { posted: false, updated: true };
  }
  const body = buildBody(null);
  if (body === null) return { posted: false, updated: false };
  await addIssueComment(repo, pr, body);
  return { posted: true, updated: false };
}

/**
 * Live PR state for a surface write. A failed lookup reads as a synthetic
 * terminal state: when in doubt, do not write to a PR.
 */
async function fetchPrStateForSurface(
  repo: string,
  pr: number,
  logLabel: string,
): Promise<{ state: string | null; mergedAt: string | null }> {
  try {
    return await fetchPullRequestState(repo, pr);
  } catch (error) {
    console.error(`pr-fix-surfacing ${logLabel} for ${repo}#${pr}:`, error);
    return { state: null, mergedAt: null };
  }
}

/**
 * Surface a BLOCKED PR-fix item on GitHub: apply the needs-human label and post
 * (or update in place) an explanatory marker comment. Best-effort — never throws.
 *
 * The marker comment is updated in place rather than duplicated so re-blocks (the
 * sync re-queues then reconcile re-blocks each cycle) refresh the existing notice
 * with the latest attempt context instead of spamming new comments.
 */
export async function surfacePrFixBlocked(input: SurfacePrFixBlockedInput): Promise<SurfacePrFixBlockedResult> {
  const result: SurfacePrFixBlockedResult = {
    labelApplied: false,
    commentPosted: false,
    commentUpdated: false,
    skippedTerminal: false,
    errors: [],
  };

  // Never write to a finished PR. A BLOCKED item can outlive its PR — a leftover
  // queue row, a late status transition, a re-queue racing a merge — and asking for
  // "human attention" on something merged months ago is pure noise. Unknown state
  // (lookup failed) is treated as terminal and skipped: when in doubt, do not write.
  const prState = await fetchPrStateForSurface(input.repo, input.pr, "PR state error");
  if (isTerminalState(prState)) {
    result.skippedTerminal = true;
    console.warn(
      `pr-fix-surfacing: skipping ${input.repo}#${input.pr} — PR state=${prState.state ?? "unknown"}` +
        `${prState.mergedAt ? ` merged=${prState.mergedAt}` : ""}; not labelling or commenting on a finished PR`,
    );
    return result;
  }

  try {
    await addIssueLabel(input.repo, input.pr, NEEDS_HUMAN_LABEL);
    result.labelApplied = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("422")) {
      result.labelApplied = true;
    } else {
      console.error(`pr-fix-surfacing label error for ${input.repo}#${input.pr}:`, error);
      result.errors.push(`label: ${message}`);
    }
  }

  try {
    const written = await writeMarkerComment(input.repo, input.pr, () =>
      buildNeedsHumanComment(input),
    );
    result.commentPosted = written.posted;
    result.commentUpdated = written.updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-fix-surfacing comment error for ${input.repo}#${input.pr}:`, error);
    result.errors.push(`comment: ${message}`);
  }

  return result;
}

/**
 * Surface a PARKED PR-fix item on GitHub (#1218): post (or update in place) an
 * explanatory marker comment. Unlike `surfacePrFixBlocked` it applies NO label
 * — a parked item is bounded exhaustion or an operational failure, not a
 * request for a human design decision. Best-effort — never throws, never writes
 * to a terminal/unknown PR.
 */
export async function surfacePrFixParked(input: SurfacePrFixParkedInput): Promise<SurfacePrFixParkedResult> {
  const result: SurfacePrFixParkedResult = {
    labelRemoved: false,
    commentPosted: false,
    commentUpdated: false,
    skippedTerminal: false,
    errors: [],
  };

  const prState = await fetchPrStateForSurface(input.repo, input.pr, "parked PR state error");
  if (isTerminalState(prState)) {
    result.skippedTerminal = true;
    console.warn(
      `pr-fix-surfacing: skipping parked surface for ${input.repo}#${input.pr} — PR state=${prState.state ?? "unknown"}` +
        `${prState.mergedAt ? ` merged=${prState.mergedAt}` : ""}; not commenting on a finished PR`,
    );
    return result;
  }

  // A BLOCKED item that parks is no longer awaiting a human decision (#1218):
  // retract the needs-human label before writing the parked notice so the two
  // never disagree. Best-effort — a failed retraction is recorded, never thrown.
  if (input.removeNeedsHumanLabel === true) {
    try {
      await removeIssueLabel(input.repo, input.pr, NEEDS_HUMAN_LABEL);
      result.labelRemoved = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`pr-fix-surfacing parked label error for ${input.repo}#${input.pr}:`, error);
      result.errors.push(`label: ${message}`);
    }
  }

  try {
    const written = await writeMarkerComment(input.repo, input.pr, () =>
      buildParkedComment(input),
    );
    result.commentPosted = written.posted;
    result.commentUpdated = written.updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-fix-surfacing parked comment error for ${input.repo}#${input.pr}:`, error);
    result.errors.push(`comment: ${message}`);
  }

  return result;
}

export interface SurfacePrFixRequeuedResult {
  labelRemoved: boolean;
  commentUpdated: boolean;
  skippedTerminal: boolean;
  errors: string[];
}

/**
 * How a BLOCKED item left BLOCKED: back to work (`requeued`) or settled as
 * fixed (`resolved`). Picks the notice the marker comment is folded into.
 */
export type PrFixUnblockOutcome = "requeued" | "resolved";

const UNBLOCK_HEADLINES: Record<PrFixUnblockOutcome, string> = {
  requeued: "> 🔄 This PR fix item has been **requeued** and is active again — no human attention needed.",
  resolved: "> ✅ This PR fix item has been **resolved** — no human attention needed.",
};

/**
 * Best-effort cleanup when a BLOCKED item is requeued: drop the needs-human label
 * and fold the existing marker comment into a concise "back to active" notice so
 * the label/comment no longer claim the PR is abandoned. History is untouched.
 *
 * Never throws. Unknown/terminal PR state (lookup failure, merged, closed) is
 * skipped so a finished PR is not "reactivated".
 */
export async function surfacePrFixRequeued(
  repo: string,
  pr: number,
  notice?: string,
): Promise<SurfacePrFixRequeuedResult> {
  return surfacePrFixUnblocked(repo, pr, "requeued", notice);
}

/**
 * The same cleanup for any exit from BLOCKED, not only an operator requeue: a
 * mark to QUEUED or FIXED, or new evidence reopening the item (#1105). A
 * `resolved` exit folds the marker into a resolved notice instead.
 */
export async function surfacePrFixUnblocked(
  repo: string,
  pr: number,
  outcome: PrFixUnblockOutcome,
  notice?: string,
): Promise<SurfacePrFixRequeuedResult> {
  const result: SurfacePrFixRequeuedResult = {
    labelRemoved: false,
    commentUpdated: false,
    skippedTerminal: false,
    errors: [],
  };

  const prState = await fetchPrStateForSurface(repo, pr, "requeue PR state error");
  if (isTerminalState(prState)) {
    result.skippedTerminal = true;
    return result;
  }

  try {
    await removeIssueLabel(repo, pr, NEEDS_HUMAN_LABEL);
    result.labelRemoved = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-fix-surfacing requeue label error for ${repo}#${pr}:`, error);
    result.errors.push(`label: ${message}`);
  }

  try {
    const existing = await fetchIssueComments(repo, pr, 100, "desc");
    const markerComment = existing.find((c) => isDispatchMarkerComment(c.body));
    if (markerComment && typeof markerComment.id === "number") {
      // Preserve whichever marker the existing comment carried (needs-human or
      // parked, #1218) so the folded notice stays recognizable and no second
      // marker comment is created.
      const marker = detectDispatchMarker(markerComment.body) ?? NEEDS_HUMAN_COMMENT_MARKER;
      const lines = [
        marker,
        "",
        UNBLOCK_HEADLINES[outcome],
      ];
      if (notice) lines.push("", `**Note:** ${notice}`);
      lines.push("", `Updated automatically by Dispatch on ${new Date().toISOString()}`);
      await updateIssueComment(repo, markerComment.id, lines.join("\n"));
      result.commentUpdated = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-fix-surfacing requeue comment error for ${repo}#${pr}:`, error);
    result.errors.push(`comment: ${message}`);
  }

  return result;
}
