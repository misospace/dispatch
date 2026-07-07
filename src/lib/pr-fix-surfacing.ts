import { addIssueComment, addIssueLabel } from "@/lib/github";

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

  try {
    await addIssueComment(input.repo, input.pr, buildNeedsHumanComment(input));
    result.commentPosted = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-fix-surfacing comment error for ${input.repo}#${input.pr}:`, error);
    result.errors.push(`comment: ${message}`);
  }

  return result;
}
