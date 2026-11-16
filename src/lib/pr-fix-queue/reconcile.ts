import { fetchRepositoryMetadata } from "../github-code-search";
import {
  fetchPullRequestListingEvidence,
  fetchPullRequestPresence,
  type PullRequestListingEvidence,
} from "../github-prs";
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
 * The listing read the confirmation consults: the PR numbers the repo's PR
 * listing shows. Null means the listing could not be read at all.
 */
export type PrFixListingLookup = (repo: string) => Promise<PullRequestListingEvidence | null>;

/**
 * Per-PR listing reads one deleted-PR reap pass may issue (bounds forge
 * reads). A listing read only runs for a row whose per-PR endpoint already
 * answered 404, so a healthy queue never reaches this bound. A row outside
 * the budget defers and the rotation brings it back in a later pass.
 */
const DELETED_REAP_MAX_LISTING_READS = 10;

/**
 * Probe whether the upstream PR of a queue row still exists.
 *
 * A hard-deleted PR answers 404 on the per-PR endpoint and appears in no
 * listing, so no list-driven reap can see it. But 404 is also the shape of
 * an unreadable repo (deleted/renamed/private-to-another-token) and of a
 * PR that still exists behind a stale answer, so the confirmation requires
 * three independent facts:
 *
 *  1. the per-PR fetch answered 404;
 *  2. the repo itself is readable through the same capability — otherwise
 *     the 404 above is the shape of an unreadable repo as well;
 *  3. the repo's PR listing does NOT show the PR (#1641). A listing that
 *     still shows it contradicts the deletion: the PR exists and the per-PR
 *     answer was spurious, and reaping on that shape would retire live work.
 *
 * Anything else — present, transport failure, rate limit, unreadable repo,
 * an unreadable listing, a listing too large to prove absence, or a listing
 * that still shows the PR — stays "unknown" or "present" and defers,
 * keeping the archived-reap fail-open shape: an unconfirmed fact never
 * reaps.
 *
 * The listing read is direct (it names the repo, not the tracked-repo set),
 * so a row whose repository is no longer tracked is still eligible.
 */
export async function probePrFixPrPresence(
  repo: string,
  pr: number,
  listPrs: PrFixListingLookup = fetchPullRequestListingEvidence,
): Promise<PrFixPrPresence> {
  const presence = await fetchPullRequestPresence(repo, pr);
  if (presence !== "deleted") return presence;
  try {
    await fetchRepositoryMetadata(repo);
  } catch (error) {
    // An unreadable repo proves nothing about the PR: the 404 above is the
    // shape of an unreadable repo as well. Log it — a silent swallow here
    // makes a forge outage indistinguishable from a healthy deferral.
    console.warn(
      `[pr-fix-queue] presence probe for ${repo}#${pr} could not confirm the repo is readable; treating the PR as unknown:`,
      error instanceof Error ? error.message : error,
    );
    return "unknown";
  }
  // Third fact (#1641): the PR must be absent from the repo's PR listings.
  const listing = await listPrs(repo);
  if (!listing) {
    console.warn(
      `[pr-fix-queue] presence probe for ${repo}#${pr} could not read the repo's PR listing; treating the PR as unknown`,
    );
    return "unknown";
  }
  if (!listing.complete) {
    // The listing was cut short by the record bound, so a missing number is
    // merely unseen: absence is unproven and the row must defer.
    console.warn(
      `[pr-fix-queue] presence probe for ${repo}#${pr} read a truncated PR listing; absence is unproven, treating the PR as unknown`,
    );
    return "unknown";
  }
  if (listing.numbers.has(pr)) {
    // The listing contradicts the 404 — the PR is still listed, so it exists
    // and the per-PR answer was spurious. Never reap on that shape.
    console.warn(
      `[pr-fix-queue] presence probe for ${repo}#${pr} answered 404 but the repo's PR listing still shows it; treating the PR as present`,
    );
    return "present";
  }
  return "deleted";
}

/**
 * Per-pass presence probe. The listing read is memoized per repository, so a
 * pass that probes many rows of one repository pays for ONE listing read, not
 * one per row. The memo lives for one pass only: a later pass re-reads the
 * listing, so a stale listing can never pin a confirmation forever.
 *
 * The memo is also the pass's listing-read budget: a pass reads at most
 * `maxListingReads` repositories' listings. A row whose repository falls
 * outside the budget defers, and the rotation brings it back in a later
 * pass, so the bound costs latency, never a reap.
 */
export function createPrFixPrPresenceProbe(
  maxListingReads = DELETED_REAP_MAX_LISTING_READS,
): (repo: string, pr: number) => Promise<PrFixPrPresence> {
  const listings = new Map<string, Promise<PullRequestListingEvidence | null>>();
  let budgetWarned = false;
  const listPrs: PrFixListingLookup = (repo) => {
    const pending = listings.get(repo);
    if (pending) return pending;
    if (listings.size >= maxListingReads) {
      if (!budgetWarned) {
        budgetWarned = true;
        console.warn(
          `[pr-fix-queue] deleted-PR reap reached its listing-read budget (${maxListingReads}); the remaining rows defer until a later pass`,
        );
      }
      return Promise.resolve(null);
    }
    const read = fetchPullRequestListingEvidence(repo);
    listings.set(repo, read);
    return read;
  };
  return (repo, pr) => probePrFixPrPresence(repo, pr, listPrs);
}

/** Rows the deleted-PR reap reads per pass (bounds DB materialization). */
const DELETED_REAP_PAGE_SIZE = 100;

/** Per-PR probes one deleted-PR reap pass may issue (bounds forge reads). */
const DELETED_REAP_MAX_PROBES = 50;

/**
 * Re-verify bound: how long a row the reap CONSIDERED stays out of the due
 * set. Bounds how often one row is re-probed; the rotation (not this bound)
 * is what guarantees every row is eventually reached.
 */
const DELETED_REAP_REVERIFY_MS = 60 * 60 * 1000;

/** Per-pass knobs; defaults are the shipped bounds. */
export interface DeletedPrFixReapOptions {
  /** Maximum per-PR probes this pass may issue. */
  maxProbes?: number;
  /** Maximum queue rows this pass reads. */
  pageSize?: number;
  /** How long a considered row stays out of the due set (ms). */
  reverifyMs?: number;
  /** Clock injection for deterministic tests. */
  now?: Date;
}

/**
 * Mark active pr-fix-queue items STALE when their upstream PR is confirmed
 * deleted (#1641). Driven by the items themselves, like the archived-repo
 * reap — the merged/closed reap consults per-repo PR listings, and a deleted
 * PR vanished from every listing, so its row lingered in
 * QUEUED/BLOCKED/PARKED/WAITING_EXTERNAL forever while every null per-PR
 * probe correctly refused to act on the unknown. The probe supplies the
 * missing facts: only a confirmed "deleted" reaps, through the same
 * generation-AND-status-pinned terminal write.
 *
 * A confirmation needs three independent facts (#1641): the per-PR endpoint
 * answers 404, the repo reads through the same credential, and the repo's PR
 * listing does not show the PR. The third fact is what keeps a spurious 404
 * (a renamed repo, a token that cannot see the PR, a transient answer) from
 * retiring a live row. The listing read is memoized per repository for the
 * length of one pass, and it only runs for a row that already answered 404 —
 * a healthy queue of present PRs pays no listing traffic at all.
 *
 * Bounds and fairness (review): an unbounded pass turned a healthy queue of
 * ordinary PRESENT PRs into one GitHub request per row on every sync, and a
 * per-repo "three unknowns and stop" breaker let three permanently-unknown
 * rows hide a confirmed deletion behind them in the SAME repo forever. Both
 * are gone. This pass instead:
 *
 * - reads at most `pageSize` rows and issues at most `maxProbes` per-PR
 *   probes — a hard bound on the pass's forge traffic;
 * - orders the rows least-recently-considered first (explicit
 *   `nulls: "first"` — PostgreSQL ranks NULL LAST by default, so the default
 *   ASC order would sort the never-considered rows to the END and pin the
 *   most recently considered rows at the head), with `id` as the deterministic
 *   tiebreak;
 * - stamps EVERY row it considered — probed present, unknown, or failed — in
 *   one bulk write at the end of the pass. The stamp is a rotation marker,
 *   not a proof: an unknown row leaves the head instead of pinning it, so a
 *   wall of permanently-unknown rows cannot hide a confirmed deletion behind
 *   it, and repeated passes ADVANCE through the backlog;
 * - leaves rows the probe bound cut off unstamped, so they lead the next
 *   pass — the rotation never restarts at the same head.
 *
 * A confirmed deletion reaps through the same generation-AND-status-pinned
 * terminal write every other reap uses; a probe that throws counts as
 * errored and defers.
 */
export async function reconcileDeletedPrFixItems(
  client: PrFixQueueClient,
  probePresence: (repo: string, pr: number) => Promise<PrFixPrPresence> = createPrFixPrPresenceProbe(),
  options: DeletedPrFixReapOptions = {},
): Promise<{ checked: number; markedStale: number; errored: number }> {
  const maxProbes = options.maxProbes ?? DELETED_REAP_MAX_PROBES;
  const pageSize = options.pageSize ?? DELETED_REAP_PAGE_SIZE;
  const reverifyMs = options.reverifyMs ?? DELETED_REAP_REVERIFY_MS;
  const now = options.now ?? new Date();
  const reverifyCutoff = new Date(now.getTime() - reverifyMs);

  let checked = 0;
  let markedStale = 0;
  let errored = 0;
  const considered: string[] = [];

  const due = await client.prFixQueueItem.findMany({
    where: {
      status: { in: [...ACTIVE_REAP_STATUSES] },
      // A row the reap considered inside the re-verify window is not due
      // again yet; a row it never considered (NULL) is due immediately.
      OR: [{ prPresenceCheckedAt: null }, { prPresenceCheckedAt: { lte: reverifyCutoff } }],
    },
    orderBy: [{ prPresenceCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: pageSize,
  });

  for (const item of due) {
    if (checked >= maxProbes) break; // forge-read bound reached
    considered.push(item.id);
    checked++;
    let presence: PrFixPrPresence;
    try {
      presence = await probePresence(item.repo, item.pr);
    } catch (err) {
      errored++;
      continue; // considered → stamped below → the rotation advances past it
    }
    if (presence !== "deleted") continue;
    try {
      const count = await markPrFixItemStale(
        client,
        item,
        "Upstream PR deleted (404 at the per-PR endpoint, repo reachable, absent from the PR listings) at reconcile time (#1641)",
      );
      if (count === 1) markedStale++;
    } catch (err) {
      // The forge answered — a local write failure defers this row as
      // errored. The row is still stamped below, so the rotation advances.
      errored++;
    }
  }

  // Rotate the scan head: stamp EVERY row this pass considered — probed
  // present, unknown, or failed. Rows the probe bound cut off before the
  // pass reached them stay unstamped and therefore lead the next pass.
  // Scoped to the active statuses so a row this pass reaped (now STALE) is
  // not stamped. One bulk write per pass; writing through the Prisma client
  // also advances `updatedAt` (@updatedAt), which stays informational.
  if (considered.length > 0) {
    try {
      await client.prFixQueueItem.updateMany({
        where: { id: { in: considered }, status: { in: [...ACTIVE_REAP_STATUSES] } },
        data: { prPresenceCheckedAt: now },
      });
    } catch (err) {
      // A failed rotation stamp only costs the pass its ordering: the rows
      // stay due and are considered again next pass. It is still counted as
      // errored — a rotation that cannot advance is the pre-review defect,
      // and it must not pass as a clean pass.
      errored++;
      console.warn(
        "[pr-fix-queue] deleted-PR reap could not stamp the considered rows; the rotation restarts at the same head this pass:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { checked, markedStale, errored };
}

