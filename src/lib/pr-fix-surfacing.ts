import { addIssueComment, addIssueLabel, fetchIssueComments } from "@/lib/github";

export const NEEDS_HUMAN_LABEL = "needs-human";
export const NEEDS_HUMAN_COMMENT_MARKER = "<!-- dispatch-pr-fix-blocked -->";

export interface SurfacePrFixBlockedInput {
  repo: string;
  pr: number;
  reason: string;
  latestNote?: string | null;
}

export interface SurfacePrFixBlockedResult {
  labelApplied: boolean;
  commentPosted: boolean;
  errors: string[];
}

/**
 * Build the markdown comment body for a BLOCKED PR-fix item.
 */
export function buildNeedsHumanComment(input: SurfacePrFixBlockedInput): string {
  const lines: string[] = [
    NEEDS_HUMAN_COMMENT_MARKER,
    "",
    "> ⚠️ This PR fix item has been marked as **BLOCKED** and needs human attention.",
    "",
    `**Reason:** ${input.reason}`,
  ];

  if (input.latestNote) {
    lines.push("", `**Latest note:** ${input.latestNote}`);
  }

  lines.push(
    "",
    `Posted automatically by Dispatch on ${new Date().toISOString()}`,
  );

  return lines.join("\n");
}

/**
 * Surface a BLOCKED PR-fix item on GitHub: apply the needs-human label and post
 * an explanatory comment. Best-effort — never throws.
 */
export async function surfacePrFixBlocked(input: SurfacePrFixBlockedInput): Promise<SurfacePrFixBlockedResult> {
  const result: SurfacePrFixBlockedResult = {
    labelApplied: false,
    commentPosted: false,
    errors: [],
  };

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

  // Idempotency: the BLOCKED comment carries NEEDS_HUMAN_COMMENT_MARKER precisely so
  // we post it ONCE. surfacePrFixBlocked is invoked on every QUEUED->BLOCKED transition,
  // and the sync re-queues then reconcile re-blocks each cycle — so without this guard
  // it posts the same comment every ~15 min forever (the #264 spam). Check for an
  // existing marker comment first; skip if present. On a lookup failure, skip posting
  // (anti-spam wins over a possibly-missed first notification).
  try {
    const existing = await fetchIssueComments(input.repo, input.pr, 100);
    const alreadyPosted = existing.some((c) => (c.body ?? "").includes(NEEDS_HUMAN_COMMENT_MARKER));
    if (alreadyPosted) {
      result.commentPosted = false;
    } else {
      await addIssueComment(input.repo, input.pr, buildNeedsHumanComment(input));
      result.commentPosted = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-fix-surfacing comment error for ${input.repo}#${input.pr}:`, error);
    result.errors.push(`comment: ${message}`);
  }

  return result;
}
