/**
 * Verify the PR's head repository is the base repository (#1637).
 *
 * `isAllowedBranchOwner` in the ingestion module reads the BASE repo's owner,
 * so a fork PR passes the owner gate while its `branch` names a branch of the
 * fork — the fix worker handed the row operates on the base repo, where that
 * branch usually does not exist (or worse, exists with different content).
 * Same-owner forks under a tracked-repo owner's namespace pass the owner
 * check outright, so the head repo must be compared against the base repo
 * itself, not just its owner.
 *
 * Fail closed on an unverifiable head repo (`head.repo.full_name` null — a
 * deleted or inaccessible fork, or a payload shape that never carries it):
 * no proof of head-repo ownership, no queue work. This mirrors the
 * `/dispatch-fix` command gate (#1622, wired in #1634), which refuses the
 * same two cases outright. GitHub logins are case-insensitive, so the
 * comparison is.
 *
 * This is THE shared predicate for every producer and consumer of
 * `PrFixQueueItem` (#1638): pr-followup ingestion re-exports it (its call-
 * site wiring lands in that issue's own PR, not in #1638), the direct enqueue
 * writer applies it to forge-proven coordinates, and the reconcile drain
 * applies it to rows from not-yet-gated producers. It stays dependency-free
 * so the queue package never grows an import edge back into the ingestion
 * module.
 */
export function isHeadRepoOfBaseRepo(
  headRepoFullName: string | null | undefined,
  baseRepoFullName: string | null | undefined,
): boolean {
  if (!headRepoFullName || !baseRepoFullName) return false;
  return headRepoFullName.toLowerCase() === baseRepoFullName.toLowerCase();
}
