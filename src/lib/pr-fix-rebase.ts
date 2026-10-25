/**
 * Mechanical rebase lane (#1327).
 *
 * A bot-authored PR that goes DIRTY (merge conflict) cannot be repaired by a
 * code-fix attempt: the conflict has to be rebased away first, and only
 * mechanically. The lane's worker contract lives in this module so every
 * producer of a rebase work item — the PR follow-up ingestion path AND the
 * linked-PR health materialization in the agent queue — writes the SAME
 * instruction wall.
 */

/**
 * Worker-facing contract for the mechanical rebase lane (#1327). Every
 * conflict call-site shares it — the merge_state event descriptor, the
 * mergeable=CONFLICTING ingestion, and the linked-PR health materialization:
 * the item's reasons ARE the instruction wall, since a rebase hand-off is a
 * followup-pr task and the queue carries no separate instruction channel.
 */
export function rebaseWorkItem(stateLabel: string): {
  lane: "NORMAL";
  type: "REBASE";
  reason: string;
  feedback: string;
} {
  return {
    lane: "NORMAL",
    type: "REBASE",
    reason: `Mechanical rebase: PR ${stateLabel} against base (#1327)`,
    feedback: [
      `Mechanical rebase required: this PR is ${stateLabel} against its base branch (#1327).`,
      "Rebase the PR branch onto the base and resolve conflicts MECHANICALLY ONLY:",
      "lockfiles, version strings, import order, doc indexes, adjacent",
      "non-overlapping hunks, and comment-only overlaps where one side is a",
      "strict subset. Never edit the same logic on both sides; never merge;",
      "never open a new PR. Push with --force-with-lease, then run the repo's",
      "bounded typecheck; an unfixable error in a file this PR touches says the",
      "rebase is not mechanical. On ANY semantic conflict, report outcome",
      '"blocked" with blockReason "human_decision", the conflicting files, and',
      "why the conflict is not mechanical — do NOT resolve it yourself. One",
      "attempt per DIRTY episode; do not retry.",
    ].join("\n"),
  };
}
