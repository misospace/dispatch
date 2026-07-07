import { addIssueLabel, removeIssueLabel } from "@/lib/github";

/**
 * Swap out all of an issue's `status/*` labels on GitHub for a single target
 * status label.
 *
 * "Set an issue's GitHub status label" used to be hand-rolled across five API
 * routes with divergent duplicate-label handling — most only removed the
 * *first* status label they found, so an issue carrying two status labels
 * (a data-quality edge case, but a real one) could end up with a stale label
 * still attached on GitHub while the Prisma cache moved on. This helper
 * removes every existing `status/*` label — not just the first — before
 * adding the target, so GitHub and the cache can't diverge.
 *
 * Scope is deliberately narrow: this only touches `status/*` labels. Callers
 * own everything else — `agent/*` label bookkeeping, Prisma cache mirroring,
 * and audit logging.
 *
 * @returns the caller's non-status labels with `targetStatus` appended. This
 *   is the label set callers should mirror into the Prisma cache.
 */
export async function transitionIssueStatus(
  repoFullName: string,
  issueNumber: number,
  currentLabels: string[],
  targetStatus: string,
): Promise<string[]> {
  const existingStatusLabels = currentLabels.filter((l) => l.startsWith("status/"));
  const nonStatusLabels = currentLabels.filter((l) => !l.startsWith("status/"));

  // Remove ALL existing status labels before adding the new one. Skip
  // removing the target label itself (already on GitHub or will be added).
  for (const oldLabel of existingStatusLabels) {
    if (oldLabel !== targetStatus) {
      await removeIssueLabel(repoFullName, issueNumber, oldLabel);
    }
  }

  // Add the target label if it wasn't already present among the existing
  // status labels.
  if (!existingStatusLabels.includes(targetStatus)) {
    await addIssueLabel(repoFullName, issueNumber, targetStatus);
  }

  return [...nonStatusLabels, targetStatus];
}
