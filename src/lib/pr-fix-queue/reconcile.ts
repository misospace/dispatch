import { fetchRepositoryMetadata } from "../github-code-search";
import { type PrFixQueueClient } from "./client";
import { normalizeQueueRepo } from "./shared";

/**
 * Mark queued pr-fix items as stale when the upstream PR is merged or closed.
 *
 * This is a deterministic cleanup that catches the failure mode where
 * pr-followup/sync enqueues items without checking the upstream PR's state,
 * leaving merged/closed PRs in the worker queue. The data source is whatever
 * caller passes in — the issues/reconcile route already builds a
 * `mergedOrClosedPrsByRepo` map per tracked repo, so we just consume it.
 *
 * Returns counts for logging/audit. No model judgment.
 */
export async function reconcileStalePrFixItems(
  client: PrFixQueueClient,
  mergedOrClosedPrsByRepo: Map<string, Set<number>>,
  prStateByRepo: Map<string, Map<number, "merged" | "closed">>,
): Promise<{ checked: number; markedStale: number; errored: number }> {
  let checked = 0;
  let markedStale = 0;
  let errored = 0;

  for (const [repo, prNumbers] of mergedOrClosedPrsByRepo) {
    if (prNumbers.size === 0) continue;
    const staleCandidates = await client.prFixQueueItem.findMany({
      where: {
        // The queue stores the folded repo identity (#1145), so this lookup
        // must fold the caller's key too (#1372): callers pass the cached
        // repo casing ("Org/Repo" from repo.fullName / repoFullNames), which
        // matches no row and silently skips the reap. The prStateByRepo
        // lookup below keeps the caller's original key — both input maps are
        // keyed identically per caller.
        repo: normalizeQueueRepo(repo),
        pr: { in: Array.from(prNumbers) },
        status: { in: ["QUEUED", "BLOCKED", "PARKED", "WAITING_EXTERNAL"] },
      },
    });
    checked += staleCandidates.length;
    for (const item of staleCandidates) {
      try {
        const state = prStateByRepo.get(repo)?.get(item.pr) ?? "merged";
        // #1253: the terminal reap write is generation-AND-status pinned — a
        // concurrent requeue/settlement that bumped the generation or moved
        // the status in the read→write gap wins, and this reap no-ops
        // (count 0, no history row) instead of clobbering it.
        const count = await client.$transaction(async (tx) => {
          const result = await tx.prFixQueueItem.updateMany({
            where: { id: item.id, status: item.status, generation: item.generation },
            data: { status: "STALE", attemptEvidenceWatermark: null, staleDisposition: false },
          });
          if (result.count === 1) {
            await tx.prFixHistory.create({
              data: {
                itemId: item.id,
                action: "mark",
                status: "STALE",
                lane: item.lane,
                note: `Upstream PR state=${state} at reconcile time`,
              },
            });
          }
          return result.count;
        });
        if (count === 1) markedStale++;
      } catch (err) {
        errored++;
      }
    }
  }

  return { checked, markedStale, errored };
}

/**
 * Whether a repo is archived, for the archived-repo guards (#1106). Fails open
 * (false) when GitHub can't answer: refusing or reaping on a lookup failure
 * would strand work that is fine.
 */
export async function isPrFixRepoArchived(repo: string): Promise<boolean> {
  try {
    return (await fetchRepositoryMetadata(repo)).archived === true;
  } catch (error) {
    console.warn(`[pr-fix-queue] archived check failed for ${repo}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Mark QUEUED/BLOCKED pr-fix items STALE when their repo is archived (#1106).
 * Nothing can push to an archived repo, so a dispatched worker can only fail;
 * observed on misospace/llmkube-images#436. Works from the items themselves,
 * not the tracked-repo list, so a repo dropped from tracking still gets
 * reaped. One lookup per distinct repo with active items.
 */
export async function reconcileArchivedRepoPrFixItems(
  client: PrFixQueueClient,
  isArchived: (repo: string) => Promise<boolean> = isPrFixRepoArchived,
): Promise<{ checked: number; markedStale: number; errored: number }> {
  let checked = 0;
  let markedStale = 0;
  let errored = 0;

  const active = await client.prFixQueueItem.findMany({ where: { status: { in: ["QUEUED", "BLOCKED", "PARKED", "WAITING_EXTERNAL"] } } });
  const byRepo = new Map<string, any[]>();
  for (const item of active) byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item]);

  for (const [repo, items] of byRepo) {
    checked += items.length;
    if (!(await isArchived(repo))) continue;
    for (const item of items) {
      try {
        // #1253: generation-AND-status pinned terminal reap — same fencing as
        // reconcileStalePrFixItems above; a concurrent requeue wins.
        const count = await client.$transaction(async (tx) => {
          const result = await tx.prFixQueueItem.updateMany({
            where: { id: item.id, status: item.status, generation: item.generation },
            data: { status: "STALE", attemptEvidenceWatermark: null, staleDisposition: false },
          });
          if (result.count === 1) {
            await tx.prFixHistory.create({
              data: {
                itemId: item.id,
                action: "mark",
                status: "STALE",
                lane: item.lane,
                note: "Upstream repo archived at reconcile time (#1106)",
              },
            });
          }
          return result.count;
        });
        if (count === 1) markedStale++;
      } catch (err) {
        errored++;
      }
    }
  }

  return { checked, markedStale, errored };
}
