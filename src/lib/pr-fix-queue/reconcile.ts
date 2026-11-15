import { fetchRepositoryMetadata } from "../github-code-search";
import { fetchPullRequestPresence } from "../github-prs";
import { type PrFixQueueClient } from "./client";
import { normalizeQueueRepo } from "./shared";

/** The queue dispositions that still hold dispatchable work; a reap pass
 *  only ever considers rows in these states. */
const ACTIVE_REAP_STATUSES = ["QUEUED", "BLOCKED", "PARKED", "WAITING_EXTERNAL"] as const;

/**
 * The terminal reap write shared by every pr-fix-queue reap (#1253):
 * generation-AND-status pinned, so a concurrent requeue/settlement that
 * bumped the generation or moved the status in the read→write gap wins and
 * this reap no-ops (count 0, no history row) instead of clobbering it.
 * Returns the update count.
 */
async function markPrFixItemStale(
  client: PrFixQueueClient,
  item: { id: string; status: string; generation: number; lane: string },
  note: string,
): Promise<number> {
  return client.$transaction(async (tx) => {
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
          note,
        },
      });
    }
    return result.count;
  });
}

/**
 * Mark queued pr-fix items as stale when the upstream PR is merged or closed.
 *
 * This is a deterministic cleanup that catches the failure mode where
 * pr-followup/sync enqueues items without checking the upstream PR's state,
 * leaving merged/closed PRs in the worker queue. The data source is whatever
 * caller passes in — the issues/reconcile route already builds a
 * `mergedOrClosedPrsByRepo` map per tracked repo, so we just consume it.
 *
 * A hard-deleted PR is absent from every listing, so it never lands in the
 * caller's map and this reap can never see its rows — that case belongs to
 * `reconcileDeletedPrFixItems`, which probes the per-PR endpoint directly.
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
        status: { in: [...ACTIVE_REAP_STATUSES] },
      },
    });
    checked += staleCandidates.length;
    for (const item of staleCandidates) {
      try {
        const state = prStateByRepo.get(repo)?.get(item.pr) ?? "merged";
        const count = await markPrFixItemStale(
          client,
          item,
          `Upstream PR state=${state} at reconcile time`,
        );
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

  const active = await client.prFixQueueItem.findMany({ where: { status: { in: [...ACTIVE_REAP_STATUSES] } } });
  const byRepo = new Map<string, any[]>();
  for (const item of active) byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item]);

  for (const [repo, items] of byRepo) {
    checked += items.length;
    if (!(await isArchived(repo))) continue;
    for (const item of items) {
      try {
        // #1253: generation-AND-status pinned terminal reap — same fencing as
        // reconcileStalePrFixItems above; a concurrent requeue wins.
        const count = await markPrFixItemStale(
          client,
          item,
          "Upstream repo archived at reconcile time (#1106)",
        );
        if (count === 1) markedStale++;
      } catch (err) {
        errored++;
      }
    }
  }

  return { checked, markedStale, errored };
}

/**
 * Tri-state per-PR existence fact (#1641): "deleted" is a confirmed fact,
 * "present" and "unknown" must never authorize a reap.
 */
export type PrFixPrPresence = "present" | "deleted" | "unknown";

/**
 * Probe whether the upstream PR of a queue row still exists.
 *
 * A hard-deleted PR answers 404 on the per-PR endpoint and appears in no
 * listing, so no list-driven reap can see it. But 404 is also the shape of
 * an unreadable repo (deleted/renamed/private-to-another-token), so the
 * confirmation requires both facts: the per-PR fetch answered 404 AND the
 * repo itself is readable through the same capability. Anything else —
 * present, transport failure, rate limit, unreadable repo — stays "unknown"
 * and defers, keeping the archived-reap fail-open shape: an unconfirmed
 * fact never reaps.
 */
export async function probePrFixPrPresence(repo: string, pr: number): Promise<PrFixPrPresence> {
  const presence = await fetchPullRequestPresence(repo, pr);
  if (presence !== "deleted") return presence;
  try {
    await fetchRepositoryMetadata(repo);
  } catch {
    return "unknown";
  }
  return "deleted";
}

/** Consecutive unknown/failed probes that stop probing a repo's remaining
 *  rows for one deleted-PR reap pass. Counted per repo: unknowns are mostly
 *  repo-shaped (unreadable/deleted repo), and a global streak would let a
 *  few permanently-unknown rows starve every later row on every pass. */
const DELETED_REAP_REPO_STREAK_LIMIT = 3;

/**
 * Mark active pr-fix-queue items STALE when their upstream PR is confirmed
 * deleted (#1641). Driven by the items themselves, like the archived-repo
 * reap — the merged/closed reap consults per-repo PR listings, and a deleted
 * PR vanished from every listing, so its row lingered in
 * QUEUED/BLOCKED/PARKED/WAITING_EXTERNAL forever while every null per-PR
 * probe correctly refused to act on the unknown. The per-PR probe supplies
 * the missing fact; only a confirmed "deleted" reaps, through the same
 * generation-AND-status-pinned terminal write. One per-PR probe per active
 * item (no batch endpoint exists); a probe that throws counts as errored
 * and defers. After `DELETED_REAP_REPO_STREAK_LIMIT` consecutive unknown or
 * failed probes for one repo (outage/rate-limit turning each probe into
 * retried timeouts, or an unreadable repo that answers that way forever),
 * that repo's remaining rows defer to a later pass, so a flaky forge
 * bounds the fan-out at a few probes per repo per pass without letting a
 * few permanently-unknown rows starve confirmed deletions behind them. A
 * reap-WRITE failure is not a probe unknown: it counts as errored only.
 */
export async function reconcileDeletedPrFixItems(
  client: PrFixQueueClient,
  probePresence: (repo: string, pr: number) => Promise<PrFixPrPresence> = probePrFixPrPresence,
): Promise<{ checked: number; markedStale: number; errored: number }> {
  let checked = 0;
  let markedStale = 0;
  let errored = 0;
  const unknownStreakByRepo = new Map<string, number>();

  const active = await client.prFixQueueItem.findMany({ where: { status: { in: [...ACTIVE_REAP_STATUSES] } } });
  for (const item of active) {
    const streak = unknownStreakByRepo.get(item.repo) ?? 0;
    if (streak >= DELETED_REAP_REPO_STREAK_LIMIT) continue; // this repo tripped the breaker this pass
    checked++;
    let presence: PrFixPrPresence;
    try {
      presence = await probePresence(item.repo, item.pr);
    } catch (err) {
      errored++;
      unknownStreakByRepo.set(item.repo, streak + 1);
      if (streak + 1 >= DELETED_REAP_REPO_STREAK_LIMIT) {
        console.warn(`[pr-fix-queue] deleted-PR reap deferring remaining items for ${item.repo} after ${streak + 1} consecutive unknown/failed probes (#1641)`);
      }
      continue;
    }
    if (presence === "deleted") {
      unknownStreakByRepo.set(item.repo, 0);
      try {
        const count = await markPrFixItemStale(
          client,
          item,
          "Upstream PR deleted (404 at the per-PR endpoint, repo reachable) at reconcile time (#1641)",
        );
        if (count === 1) markedStale++;
      } catch (err) {
        // The forge answered — a local write failure defers this row as
        // errored without feeding the probe-unknown breaker.
        errored++;
      }
      continue;
    }
    if (presence === "present") {
      unknownStreakByRepo.set(item.repo, 0);
      continue;
    }
    unknownStreakByRepo.set(item.repo, streak + 1);
    if (streak + 1 >= DELETED_REAP_REPO_STREAK_LIMIT) {
      console.warn(`[pr-fix-queue] deleted-PR reap deferring remaining items for ${item.repo} after ${streak + 1} consecutive unknown/failed probes (#1641)`);
    }
  }

  return { checked, markedStale, errored };
}
