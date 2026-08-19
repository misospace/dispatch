import {
  addIssueComment,
  addIssueLabel,
  fetchIssueComments,
  fetchPullRequestState,
  removeIssueLabel,
  updateIssueComment,
} from "@/lib/github";

export const NEEDS_HUMAN_LABEL = "needs-human";
export const NEEDS_HUMAN_COMMENT_MARKER = "<!-- dispatch-pr-fix-blocked -->";

export interface PrFixSurfaceContext {
  /** Total number of fix attempts observed, when known. */
  totalAttempts?: number | null;
  /** Fix attempts grouped by lane, keyed by lane name (or "unknown"). */
  attemptsByLane?: Record<string, number>;
  /** Concise description of the final failure once the loop gave up. */
  finalFailureSignature?: string | null;
  /** URLs of the failing runs that exhausted the attempts, when present. */
  failingRunLinks?: string[];
  /** Summary/context from the last attempt, when any data is available. */
  lastAttemptSummary?: string | null;
}

export interface SurfacePrFixBlockedInput {
  repo: string;
  pr: number;
  reason: string;
  latestNote?: string | null;
  context?: PrFixSurfaceContext | null;
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
    .map(([lane, count]) => `- **${lane}:** ${count} attempt${count === 1 ? "" : "s"}`)
    .join("\n");
  return `\n**Attempts by lane:**\n${parts}`;
}

function formatFailingRunLinks(links: string[] | undefined): string | null {
  const list = (links ?? []).filter((u) => u && typeof u === "string");
  if (list.length === 0) return null;
  return `\n**Failing run(s):**\n${list.map((u) => `- ${u}`).join("\n")}`;
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

  const totalAttempts = context.totalAttempts;
  if (typeof totalAttempts === "number" && totalAttempts > 0) {
    lines.push("", `**Total attempts:** ${totalAttempts}`);
  }

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

function isDispatchMarkerComment(body: string | null | undefined): boolean {
  return (body ?? "").trimStart().startsWith(NEEDS_HUMAN_COMMENT_MARKER);
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
  let prState: { state: string | null; mergedAt: string | null };
  try {
    prState = await fetchPullRequestState(input.repo, input.pr);
  } catch (error) {
    console.error(`pr-fix-surfacing PR state error for ${input.repo}#${input.pr}:`, error);
    prState = { state: null, mergedAt: null };
  }
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
    const existing = await fetchIssueComments(input.repo, input.pr, 100, "desc");
    const marker = existing.find((c) => isDispatchMarkerComment(c.body));
    const body = buildNeedsHumanComment(input);

    if (marker) {
      // If the marker lacks an id (old caller / mocked data), treat it as existing
      // and avoid a duplicate post — the anti-spam guard wins over freshness.
      if (typeof marker.id === "number") {
        await updateIssueComment(input.repo, marker.id, body);
        result.commentUpdated = true;
      }
    } else {
      await addIssueComment(input.repo, input.pr, body);
      result.commentPosted = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-fix-surfacing comment error for ${input.repo}#${input.pr}:`, error);
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
  const result: SurfacePrFixRequeuedResult = {
    labelRemoved: false,
    commentUpdated: false,
    skippedTerminal: false,
    errors: [],
  };

  let prState: { state: string | null; mergedAt: string | null };
  try {
    prState = await fetchPullRequestState(repo, pr);
  } catch (error) {
    console.error(`pr-fix-surfacing requeue PR state error for ${repo}#${pr}:`, error);
    prState = { state: null, mergedAt: null };
  }
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
    const marker = existing.find((c) => isDispatchMarkerComment(c.body));
    if (marker && typeof marker.id === "number") {
      const lines = [
        NEEDS_HUMAN_COMMENT_MARKER,
        "",
        "> 🔄 This PR fix item has been **requeued** and is active again — no human attention needed.",
      ];
      if (notice) lines.push("", `**Note:** ${notice}`);
      lines.push("", `Updated automatically by Dispatch on ${new Date().toISOString()}`);
      await updateIssueComment(repo, marker.id, lines.join("\n"));
      result.commentUpdated = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-fix-surfacing requeue comment error for ${repo}#${pr}:`, error);
    result.errors.push(`comment: ${message}`);
  }

  return result;
}
