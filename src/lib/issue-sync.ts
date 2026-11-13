import { ACTIVE_STATUS_LABELS, GitHubIssue } from "@/types";
import { Prisma } from "@prisma/client";
import { isIssueExcludedByLabels } from "@/lib/issue-filters";
import { isEscalationLabel } from "@/lib/issue-lane";
import { prisma } from "@/lib/prisma";
import { fetchIssues } from "@/lib/github";
import { getEscalationLane, assertValidLaneForWrite, defaultCurrentLane, getBacklogLane, getUnconfiguredLaneInfo } from "@/lib/lane-config";
import { recordSyncedIssueEvents } from "@/lib/issue-lifecycle";

export interface SyncRepo {
  id: string;
  fullName: string;
}

/**
 * The lane a newly-ingested issue should start on.
 *
 * The implementation lives in `@/lib/lane-config` (dispatch#1588), next to the
 * lane configuration, so a write site reads the default lane from there and
 * validates it against the configured lane set at the point of persistence.
 * This re-export keeps the existing importers working.
 */
export { defaultCurrentLane };

/**
 * The lane a freshly-ingested issue should start on based on its labels.
 *
 * An issue carrying an explicit escalation label (`needs-escalation` /
 * `needs-gpt`) is routed to the escalation/frontier lane at ingest rather than
 * the default claimable lane, so a scan/CVE-class CI failure (which carries the
 * label when filed) is picked up by a higher-judgment worker immediately. Falls
 * back to the configured default lane. Mirrors the classification heuristic so
 * ingest and reclassification agree (#988).
 */
export function currentLaneForLabels(labels: string[]): string | null {
  if (isEscalationLabel(labels)) {
    return getEscalationLane()?.id ?? defaultCurrentLane();
  }
  return defaultCurrentLane();
}

export interface SyncedIssueData {
  number: number;
  title: string;
  body: string | null;
  url: string;
  labels: string[];
  assignees: string[];
  commentsCount: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  lastSyncedAt: Date;
  state: string;
  /**
   * Native GitHub blocked_by keys (canonical `owner/repo#N`). `[]` means
   * authoritatively none; `undefined` means unknown (not enriched, or the
   * dependency fetch failed) so the store update leaves the column unchanged.
   */
  nativeBlockedBy?: string[];
}

/**
 * The cached state a sync write is replacing. Passed alongside the write so a
 * store can record what the sync changed without re-reading the row it just
 * overwrote.
 */
export interface IssueSyncSnapshot {
  labels: string[];
  state?: string | null;
}

export interface IssueStore {
  /**
   * The cached row for one issue, plus `activeLeaseAgents`: the agents whose
   * Lease is still live (`expiredAt > now`) for that issue (#1623). The sync
   * core uses it to decide which cached `agent/*` labels a fresh GitHub set
   * may not drop — see mergeLabels. A store that reports no active leases
   * opts into full GitHub authority over the cached agent set.
   */
  findIssue(
    repositoryId: string,
    number: number,
  ): Promise<{ id: string; labels: string[]; state?: string; activeLeaseAgents?: string[] } | null>;
  updateIssue(id: string, data: SyncedIssueData, previous?: IssueSyncSnapshot | null): Promise<void>;
  createIssue(repositoryId: string, data: SyncedIssueData): Promise<void>;
  /**
   * Delete a cached issue row that GitHub says should not be cached anymore
   * (#1587). Returns true when the row is no longer in the cache (deleted, or
   * already gone); false when the delete was refused because a dependent row
   * holds live state (the caller logs the retention).
   *
   * A store must refuse whenever any Issue relation that holds work,
   * coordination, or policy state has a row: the schema cascades or nulls out
   * those, so an unguarded delete would silently destroy leases, runs,
   * grooming history, in-flight fences, and pending reconciliation intents.
   * Only the row's own derived history (lifecycle events, lane
   * classifications) goes with the row, and that removal must be recorded.
   * See makePrismaIssueStore.deleteIssue for the exact set.
   */
  deleteIssue(id: string): Promise<boolean>;
}

export interface SyncResult {
  repo: string;
  synced: number;
  error: string | null;
}

export interface RefreshIssueResult {
  success: boolean;
  repo: string;
  issueNumber: number;
  action: "created" | "updated";
  error: string | null;
  issueData?: SyncedIssueData;
}

export interface ReconcileClosedIssueResult {
  repo: string;
  issueNumber: number;
  reconciled: boolean;
  action: "marked_done" | "released_lease" | "state_fixed" | "no_change";
  error: string | null;
}

export interface ClosedIssueReconcileResponse {
  success: boolean;
  reposProcessed: number;
  issuesChecked: number;
  issuesReconciled: number;
  results: ReconcileClosedIssueResult[];
}

export interface SyncResponse {
  success: boolean;
  repos: number;
  syncedCount: number;
  results: SyncResult[];
}

export function githubIssueToSyncedIssueData(ghIssue: GitHubIssue, lastSyncedAt = new Date()): SyncedIssueData {
  return {
    number: ghIssue.number,
    title: ghIssue.title,
    body: ghIssue.body,
    url: ghIssue.html_url,
    labels: ghIssue.labels.map((label) => label.name),
    assignees: ghIssue.assignees.map((assignee) => assignee.login),
    commentsCount: ghIssue.comments,
    createdAt: new Date(ghIssue.created_at),
    updatedAt: new Date(ghIssue.updated_at),
    closedAt: ghIssue.closed_at ? new Date(ghIssue.closed_at) : null,
    lastSyncedAt,
    state: ghIssue.state,
    nativeBlockedBy: ghIssue.nativeBlockedBy,
  };
}

/**
 * Reconcile the cached `agent/*` set against a fresh GitHub label set (#1623).
 *
 * GitHub is authoritative: an `agent/*` label GitHub no longer carries is
 * DROPPED, so a remote removal (unassign, release sweep, manual cleanup)
 * converges on the next sync instead of being re-added forever. The old
 * unconditional union made every cached agent label immortal — stale labels
 * piled up until `resolveClaimantFromIssueFacts` saw several distinct agents
 * and reported "ambiguous", permanently refusing PR-fix hand-outs.
 *
 * The one cached agent label a sync may keep against a GitHub set that lacks
 * it is a label a live Lease still vouches for: the claim endpoint commits
 * the lease (its claim intent) BEFORE the remote label add, so a sync whose
 * GitHub fetch predates a fresh claim still preserves that claim instead of
 * stranding it. That is the race the original union protected, without the
 * permanent staleness it caused.
 */
export function mergeLabels(
  ghLabels: string[],
  existingAgentLabels: string[],
  activeLeaseAgents: string[] = [],
): string[] {
  const ghLabelSet = new Set(ghLabels);
  const leased = new Set(activeLeaseAgents.map((name) => name.trim()));
  // Only lease-backed agent labels survive a GitHub set that no longer
  // carries them; everything else follows GitHub.
  const preserved = existingAgentLabels.filter(
    (l) =>
      l.startsWith("agent/") &&
      leased.has(l.slice("agent/".length).trim()) &&
      !ghLabelSet.has(l),
  );
  return [...ghLabels, ...preserved];
}

/**
 * GitHub-authoritative issue data for one sync step: closed⇒status/done applied,
 * and the cached agent/* labels preserved on top when a cached row exists.
 * Shared by the normal update path and the refused-prune keep path (#1587),
 * which must persist identical label semantics.
 */
function syncedIssueDataFor(
  ghIssue: GitHubIssue,
  existingIssue: { labels: string[]; activeLeaseAgents?: string[] } | null,
): { issueData: SyncedIssueData; statusFix: { added: string[]; removed: string[] } } {
  const issueData = githubIssueToSyncedIssueData(ghIssue);

  // Closed ⇒ status/done (deterministic, every sync).
  const statusFix = closedIssueStatusFix(issueData.labels, issueData.state);
  issueData.labels = statusFix.labels;

  if (existingIssue && existingIssue.labels.length > 0) {
    // Reconcile the cached agent/* labels against the GitHub set: stale ones
    // are dropped, lease-backed ones survive a GitHub read that predates a
    // concurrent claim (see mergeLabels, #1623).
    issueData.labels = mergeLabels(
      issueData.labels,
      existingIssue.labels,
      existingIssue.activeLeaseAgents ?? [],
    );
  }
  return { issueData, statusFix };
}

/**
 * Enforce "closed ⇒ status/done" at sync time. A closed GitHub issue should
 * carry status/done regardless of its prior status (backlog/ready/in-progress/
 * in-review, or no status label at all). Applied on every sync so the mapping
 * is deterministic — no flicker, no dependence on a separate reconcile pass.
 *
 * Returns the corrected label set plus the status/* labels to remove and add on
 * GitHub so the remote matches too. All three are empty when the issue is open
 * or already correctly status/done.
 */
export function closedIssueStatusFix(
  labels: string[],
  state: string,
): { labels: string[]; added: string[]; removed: string[] } {
  if (state !== "closed") return { labels, added: [], removed: [] };
  const statusLabels = labels.filter((l) => l.startsWith("status/"));
  if (statusLabels.length === 1 && statusLabels[0] === "status/done") {
    return { labels, added: [], removed: [] };
  }
  const removed = statusLabels.filter((l) => l !== "status/done");
  const added = statusLabels.includes("status/done") ? [] : ["status/done"];
  const labelsOut = [...labels.filter((l) => !l.startsWith("status/")), "status/done"];
  return { labels: labelsOut, added, removed };
}

export async function syncIssuesForRepos(
  repos: SyncRepo[],
  fetchIssues: (repo: SyncRepo) => Promise<GitHubIssue[]>,
  store: IssueStore,
  excludedLabels: string[] = [],
  // Optional: push the closed⇒done status-label change to GitHub too, so the
  // remote matches the cache. Omit to fix the cache only (still deterministic).
  syncGithubLabels?: (repoFullName: string, issueNumber: number, add: string[], remove: string[]) => Promise<void>,
): Promise<SyncResponse> {
  const results: SyncResult[] = [];
  let syncedCount = 0;

  for (const repo of repos) {
    try {
      const githubIssues = await fetchIssues(repo);
      let repoSyncedCount = 0;

      for (const ghIssue of githubIssues) {
        // Resolve the cached row before the exclusion check (#1587). An issue
        // that was cached clean and later gains an excluded label on GitHub
        // used to `continue` here before the cache was consulted, so its row
        // was never revisited — a permanent zombie that every board/count
        // query kept seeing. An issue that was never cached is still skipped
        // outright below (never ingested, then deleted).
        const existingIssue = await store.findIssue(repo.id, ghIssue.number);

        if (isIssueExcludedByLabels(ghIssue.labels.map((l) => l.name), excludedLabels)) {
          if (existingIssue) {
            // GitHub is authoritative: the label says this issue is out of
            // scope for the cache. Prune it, unless real work still hangs off
            // the row (the store refuses those deletes; keep + warn instead).
            let pruned = false;
            let pruneFailed = false;
            try {
              pruned = await store.deleteIssue(existingIssue.id);
            } catch (error) {
              // The prune did not complete — a lock wait that outran the
              // transaction timeout, a transient database error. Two rules hold
              // here. One issue's failure must not skip the rest of the repo's
              // sync (the per-repo catch would abort every later issue). And
              // the kept row must not keep its stale labels, because the
              // cached labels are what the board/queue exclusion filters read.
              // So the failure falls through to the keep path, which persists
              // the excluded label on the row.
              pruneFailed = true;
              console.error(
                `prune failed for cached issue ${repo.fullName}#${ghIssue.number}:`,
                error,
              );
            }
            if (pruned) {
              console.log(
                `pruned cached issue ${repo.fullName}#${ghIssue.number}: labels now match DISPATCH_EXCLUDED_LABELS`,
              );
            } else {
              // The store kept the row because dependent work rows exist (or
              // the prune failed). The board/count and agent-queue exclusion
              // filters read the *cached* labels, so leaving them stale would
              // keep a GitHub-excluded issue visible and dispatchable
              // indefinitely. Persist the GitHub-authoritative labels — the
              // excluded label among them — through the same path a normal
              // sync uses, so every exclusion consumer sees the kept row as
              // excluded until a later sync can finally prune it.
              const { issueData } = syncedIssueDataFor(ghIssue, existingIssue);
              await store.updateIssue(existingIssue.id, issueData, {
                labels: existingIssue.labels,
                state: existingIssue.state ?? null,
              });
              console.warn(
                pruneFailed
                  ? `kept cached issue ${repo.fullName}#${ghIssue.number}: prune failed, labels match DISPATCH_EXCLUDED_LABELS`
                  : `kept cached issue ${repo.fullName}#${ghIssue.number}: labels match DISPATCH_EXCLUDED_LABELS but dependent rows exist`,
              );
            }
          }
          continue;
        }

        const { issueData, statusFix } = syncedIssueDataFor(ghIssue, existingIssue);

        if (existingIssue) {
          await store.updateIssue(existingIssue.id, issueData, {
            labels: existingIssue.labels,
            state: existingIssue.state ?? null,
          });
        } else {
          await store.createIssue(repo.id, issueData);
        }

        // Mirror the closed⇒done label change to GitHub (best-effort — the cache
        // is already correct; a relabel failure must not fail the sync). Self-
        // limiting: once GitHub is status/done, subsequent syncs are no-ops.
        if (syncGithubLabels && (statusFix.added.length > 0 || statusFix.removed.length > 0)) {
          try {
            await syncGithubLabels(repo.fullName, ghIssue.number, statusFix.added, statusFix.removed);
          } catch (error) {
            console.error(`closed→done relabel failed for ${repo.fullName}#${ghIssue.number}:`, error);
          }
        }

        repoSyncedCount++;
        syncedCount++;
      }

      results.push({ repo: repo.fullName, synced: repoSyncedCount, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sync error";
      console.error(`Issue sync failed for ${repo.fullName}:`, error);
      results.push({ repo: repo.fullName, synced: 0, error: message });
    }
  }

  // Sync-time lane sweep (#1589): after every pass over these repos, re-lane
  // cached issues whose currentLane names a retired lane to the backlog lane.
  // Called here — the one path all three sync entry points (manual, scheduled,
  // heartbeat) drive — so they cannot drift. Best-effort: a sweep failure is
  // logged and must not fail a sync whose cache writes already landed.
  try {
    const swept = await sweepRetiredLanes(repos.map((repo) => repo.id));
    if (swept > 0) {
      console.log(
        `[issue-sync] Lane sweep re-laned ${swept} issue(s) with retired lane ids to the backlog lane`,
      );
    }
  } catch (error) {
    console.error("Lane sweep failed:", error);
  }

  return {
    success: results.every((result) => result.error === null),
    repos: repos.length,
    syncedCount,
    results,
  };
}

/**
 * Status labels that make an issue eligible for closed-issue reconciliation.
 * When a GitHub issue with one of these labels is found to be closed,
 * the old status label is replaced with status/done.
 */
const RECONCILABLE_STATUS_LABELS = ["status/backlog", ...ACTIVE_STATUS_LABELS] as const;

export async function reconcileClosedIssues(
  repos: SyncRepo[],
  fetchIssueFn: (repoFullName: string, issueNumber: number) => Promise<GitHubIssue>,
  store: {
    findActiveCachedIssues(repositoryId: string): Promise<Array<{ id: string; number: number; labels: string[]; state: string }>>;
    updateIssue(
      id: string,
      data: { labels: string[]; state: string; closedAt: Date | null },
      previous?: IssueSyncSnapshot | null,
    ): Promise<void>;
  },
): Promise<ClosedIssueReconcileResponse> {
  const results: ReconcileClosedIssueResult[] = [];
  let issuesReconciled = 0;

  for (const repo of repos) {
    try {
      const cachedIssues = await store.findActiveCachedIssues(repo.id);
      let repoReconciled = 0;

      for (const cached of cachedIssues) {
        // Check if this issue needs reconciliation:
        // 1. Has a reconcilable status label (backlog/ready/in-progress/in-review)
        // 2. Already has status/done but state is still "open" (stale cache)
        const hasReconcilableStatus = RECONCILABLE_STATUS_LABELS.some((s) => cached.labels.includes(s));
        const hasDoneLabelButOpenState = cached.labels.includes("status/done") && cached.state === "open";

        if (!hasReconcilableStatus && !hasDoneLabelButOpenState) continue;

        try {
          const ghIssue = await fetchIssueFn(repo.fullName, cached.number);

          if (ghIssue.state === "closed") {
            // Case 1: Issue has status/done but stale open state — just fix the state
            if (hasDoneLabelButOpenState) {
              await store.updateIssue(
                cached.id,
                {
                  labels: cached.labels,
                  state: "closed",
                  closedAt: ghIssue.closed_at ? new Date(ghIssue.closed_at) : new Date(),
                },
                { labels: cached.labels, state: cached.state },
              );

              repoReconciled++;
              results.push({
                repo: repo.fullName,
                issueNumber: cached.number,
                reconciled: true,
                action: "state_fixed",
                error: null,
              });
            } else {
              // Case 2: Issue has an active status label — replace with status/done
              const newLabels = cached.labels
                .filter((l) => !RECONCILABLE_STATUS_LABELS.includes(l as typeof RECONCILABLE_STATUS_LABELS[number]))
                .concat(["status/done"]);

              await store.updateIssue(
                cached.id,
                {
                  labels: newLabels,
                  state: "closed",
                  closedAt: ghIssue.closed_at ? new Date(ghIssue.closed_at) : new Date(),
                },
                { labels: cached.labels, state: cached.state },
              );

              repoReconciled++;
              results.push({
                repo: repo.fullName,
                issueNumber: cached.number,
                reconciled: true,
                action: "marked_done",
                error: null,
              });

              // If the issue had in-progress status, that implies a lease was active.
              // Mark it as released for observability (actual lease release is handled separately).
              if (cached.labels.includes("status/in-progress")) {
                results[results.length - 1].action = "released_lease";
              }
            }
          } else {
            results.push({
              repo: repo.fullName,
              issueNumber: cached.number,
              reconciled: false,
              action: "no_change",
              error: null,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`Reconcile failed for ${repo.fullName}#${cached.number}:`, error);
          results.push({
            repo: repo.fullName,
            issueNumber: cached.number,
            reconciled: false,
            action: "no_change",
            error: message,
          });
        }
      }

      issuesReconciled += repoReconciled;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Closed issue reconciliation failed for ${repo.fullName}:`, error);
      results.push({
        repo: repo.fullName,
        issueNumber: 0,
        reconciled: false,
        action: "no_change",
        error: message,
      });
    }
  }

  return {
    success: results.every((r) => r.error === null || !r.reconciled),
    reposProcessed: repos.length,
    issuesChecked: results.length,
    issuesReconciled,
    results,
  };
}

// ---------------------------------------------------------------------------
// Shared Prisma/GitHub wiring
//
// The manual sync route, the scheduled sync route, and the heartbeat
// orchestrator all drive syncIssuesForRepos/reconcileClosedIssues with the
// same fetch wrapper and Prisma-backed stores. Defined once here so the three
// call sites cannot drift.
// ---------------------------------------------------------------------------

// Sync must see closed issues, or closedIssueStatusFix never runs: the
// closed=>done enforcement (#521) only applies to issues in the fetch set,
// and the default fetch is state=open. Regressed to open-only when the
// heartbeat cron (whose reconcile did its own closed fetch) was retired.
//
// Overlap window subtracted from the sync anchor before it's used as `since`.
// Covers issues that changed during the previous sync's fetch window (GitHub's
// `since` filters on updated_at, and a sync run takes nonzero time to
// complete), so a race can't drop an issue that was updated mid-sync.
export const SYNC_OVERLAP_BUFFER_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Anchor timestamp for incremental sync: the most recent Issue.lastSyncedAt
 * cached for this repo, or null when the repo has no cached issues yet.
 *
 * There's no dedicated "last successful sync" column on Repository to anchor
 * against — `getSyncRepos` upserts rows with only fullName/owner/name/enabled,
 * and Repository has no lastSyncedAt field (only Issue.lastSyncedAt and the
 * unrelated AutomationRepo.lastSyncedAt exist in the schema). Anchoring on
 * Issue.lastSyncedAt instead sidesteps the "freshly-created row has a bogus
 * now() anchor" trap by construction: that column is only ever written when
 * an issue sync actually persisted a row, so a repo with zero cached issues
 * (first sync, or all rows purged) naturally yields `null` here — never a
 * timestamp that looks valid but reflects zero synced issues.
 */
async function getRepoSyncAnchor(repositoryId: string): Promise<Date | null> {
  const result = await prisma.issue.aggregate({
    where: { repositoryId },
    _max: { lastSyncedAt: true },
  });
  return result._max.lastSyncedAt ?? null;
}

/**
 * Fetch wrapper for the shared sync path (manual sync route, scheduled sync
 * route, heartbeat).
 *
 * Open issues are always fetched in full (no `since`): they are a bounded,
 * cheap set and are all the queue cares about. Fetching them incrementally
 * stranded any open issue that was missed by the repo's initial fetch and
 * never `updated_at`-touched since — invisible to the queue forever
 * (dispatch#991). The closed-issue tail stays incremental on
 * `since = anchor - SYNC_OVERLAP_BUFFER_MS` when the repo has a trustworthy
 * prior anchor (i.e. already has cached issues); otherwise it is fetched in
 * full as before. See getRepoSyncAnchor for why "has cached issues" is the
 * validity guard.
 */
export const fetchAllStateIssues = async (repo: SyncRepo): Promise<GitHubIssue[]> => {
  const anchor = await getRepoSyncAnchor(repo.id);
  const since = anchor ? new Date(anchor.getTime() - SYNC_OVERLAP_BUFFER_MS) : undefined;
  const [openIssues, closedIssues] = await Promise.all([
    fetchIssues(repo.fullName, { state: "open", includeNativeBlockers: true }),
    fetchIssues(repo.fullName, { state: "closed", since }),
  ]);
  // Dedupe by number in case GitHub ever returns the same issue twice; the
  // open copy wins (it is the fresher, queue-relevant state).
  const byNumber = new Map<number, GitHubIssue>();
  for (const issue of [...closedIssues, ...openIssues]) {
    byNumber.set(issue.number, issue);
  }
  return [...byNumber.values()];
};

/**
 * Prisma-backed IssueStore for syncIssuesForRepos. findIssue returns the
 * cached labels so the sync core can merge agent/* labels without a second
 * lookup per issue, and the cached state so the store can record what the sync
 * changed once it lands (#1202).
 */
export function makePrismaIssueStore(): IssueStore {
  // The repo full name an issue belongs to, taken from the same findIssue the
  // core always calls immediately before updateIssue. Holding it here costs
  // no extra query per synced issue; the entry is consumed (and dropped) by the
  // update, so the map never holds more than the issue being synced.
  const repoByIssueId = new Map<string, string>();

  return {
    findIssue(repositoryId: string, number: number) {
      // The active-lease predicate matches the claimant resolver and
      // findActiveLeasesForIssue (#1623): one read of the same liveness rule,
      // so the sync's preservation set and the resolver's lease candidate
      // cannot disagree about who is live.
      const now = new Date();
      return prisma.issue
        .findUnique({
          where: { repositoryId_number: { repositoryId, number } },
          select: {
            id: true,
            labels: true,
            state: true,
            repository: { select: { fullName: true } },
            leases: { where: { expiredAt: { gt: now } }, select: { agentName: true } },
          },
        })
        .then((issue) => {
          if (!issue) return null;
          repoByIssueId.set(issue.id, issue.repository.fullName);
          const { leases, ...rest } = issue;
          return {
            ...rest,
            activeLeaseAgents: [...new Set((leases ?? []).map((lease) => lease.agentName))],
          };
        });
    },
    async updateIssue(id: string, data: SyncedIssueData, previous?: IssueSyncSnapshot | null) {
      const repoFullName = repoByIssueId.get(id);
      repoByIssueId.delete(id);

      // Evidence before the mirror (#1202). Committing the cache write first
      // and the event second would make a failed event write unrecoverable: the
      // next sync would read an already-updated cache, derive no transition and
      // never reconstruct the missing row. Recording first lets the failure
      // abort this issue's mirror instead — the sync core catches a throwing
      // updateIssue at repo level and reports that repo as errored, exactly as
      // it already does for a failed mirror write — and because the cache row
      // never moved, the next run re-derives the same transition from the same
      // before-state and upserts onto the same source-derived dedupe key: one
      // row, not a duplicate.
      if (repoFullName && previous) {
        await recordSyncedIssueEvents(prisma, {
          issueId: id,
          repoFullName,
          issueNumber: data.number,
          before: { labels: previous.labels, state: previous.state ?? null },
          after: {
            labels: data.labels,
            state: data.state,
            updatedAt: data.updatedAt,
            closedAt: data.closedAt,
          },
        });
      }

      await prisma.issue.update({ where: { id }, data });
    },
    async deleteIssue(id: string): Promise<boolean> {
      // #1587 excluded-reconcile delete. The Issue row is the cache's
      // projection of one GitHub issue, and the rows that hang off it fall
      // into three kinds. The delete treats them differently.
      //
      // 1. LIVE STATE — refused. Every Issue relation that holds work,
      //    coordination, or policy state is counted first. A row in any of
      //    them means the issue is not a bare cache row, so the prune is
      //    refused and the sync keeps it (with the excluded label persisted,
      //    so it stays invisible and undispatchable). The schema cascades or
      //    nulls out these, so an unguarded delete would silently destroy
      //    real work — or strip the link that says which issue the work
      //    belongs to: agent runs and agent work, leases, grooming runs and
      //    applications, the in-flight mutation guard, a pending groomer
      //    reply, handoff settlements, the ownership reconciler's release
      //    intents and candidates, a decomposed parent's child claims, and
      //    the no-PR / blocked-external parks.
      // 2. DERIVED HISTORY — goes with the row, and is recorded.
      //    IssueLifecycleEvent (the transitions observed for this row) and
      //    IssueLane (Dispatch's classification of it) describe the cache row
      //    itself, not work that outlives it, so they are removed with it.
      //    Guarding them would block the prune for much of the population it
      //    exists to clear: a lane classification writes an IssueLane row on
      //    its own (POST /api/issues/[issueId]/lane), so an issue that was
      //    classified and later gained an excluded label would keep its row
      //    forever. The prune counts them and records what it removed in an
      //    AuditLog row, which survives the delete (its issue link is
      //    nullable), so the loss is recorded rather than silent.
      // 3. NULLABLE LINKS — survive. AuditLog references the issue through a
      //    nullable foreign key (ON DELETE SET NULL), so its rows stay and
      //    the link is cleared. CapacityHandoff stores the issue id as a
      //    plain column with no foreign key, so its rows survive too.
      //
      // The check and the delete share one transaction behind a FOR UPDATE
      // lock on the row: inserting a dependent row (a claim creating a Lease,
      // a run recording an AgentRun) takes a FOR KEY SHARE lock on the parent
      // row in Postgres, and FOR KEY SHARE conflicts with FOR UPDATE (it does
      // NOT conflict with FOR NO KEY UPDATE), so such an insert waits behind
      // this decision and can never slip in between the count and the delete.
      // If this deletes, that insert then fails its foreign key — correct,
      // since the excluded issue is no longer dispatchable work.
      // Row-returning SELECT goes through $queryRaw ($executeRaw is for
      // statements that change rows and cannot return a result set).
      const pruned = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${id} FOR UPDATE`;

          // The row itself, read under the lock this transaction already
          // holds: the audit record needs its number, its repository, and the
          // labels the cache carried.
          const row = await tx.issue.findUnique({
            where: { id },
            select: { number: true, labels: true, repository: { select: { fullName: true } } },
          });
          // The row is already gone — it was deleted while this transaction
          // waited for the lock. The cache no longer holds it, which is the
          // goal, so the prune reports success and records nothing.
          if (!row) return true;

          const dependents = await Promise.all([
            // Work in flight, or already recorded, for this issue.
            tx.agentRun.count({ where: { issueId: id } }),
            tx.agentWork.count({ where: { issueId: id } }),
            tx.lease.count({ where: { issueId: id } }),
            tx.groomingRun.count({ where: { issueId: id } }),
            tx.groomingApplication.count({ where: { issueId: id } }),
            // Coordination state: the in-flight fenced write, a pending
            // groomer reply, a durable handoff settlement, the ownership
            // reconciler's pending release intent and candidate, and the
            // child claims a decomposed parent holds.
            tx.issueMutationGuard.count({ where: { issueId: id } }),
            tx.groomerPendingReply.count({ where: { issueId: id } }),
            tx.issueHandoffSettlement.count({ where: { issueId: id } }),
            tx.ownershipReleaseIntent.count({ where: { issueId: id } }),
            tx.ownershipReconcileCandidate.count({ where: { issueId: id } }),
            tx.groomingChildClaim.count({ where: { parentIssueId: id } }),
            // Policy parks: a terminal no-PR conclusion and a
            // blocked-external park.
            tx.noPrConclusion.count({ where: { issueId: id } }),
            tx.blockedExternalPark.count({ where: { issueId: id } }),
          ]);
          if (dependents.some((count) => count > 0)) return false;

          const [lifecycleEvents, laneClassifications] = await Promise.all([
            tx.issueLifecycleEvent.count({ where: { issueId: id } }),
            tx.issueLane.count({ where: { issueId: id } }),
          ]);

          // deleteMany (not delete): a row that vanished concurrently yields 0,
          // not a P2025 that would take the whole repo's sync down with it. A
          // vanished row already satisfies the goal — the cache no longer holds
          // it — so it reports pruned, keeping the false path (and its
          // "dependent rows exist" warning) only for real refusals.
          const deleted = await tx.issue.deleteMany({ where: { id } });
          if (deleted.count === 0) return true;

          // The durable record of the prune, written after the delete so it
          // only records a prune that actually happened. issueId stays null on
          // purpose: the row this entry describes is deleted in this same
          // transaction, so a link to it could not survive it. The
          // repository, the issue number, and the id in the notes identify
          // what was pruned.
          await tx.auditLog.create({
            data: {
              actor: "sync",
              action: "prune_excluded_issue",
              repoFullName: row.repository.fullName,
              issueNumber: row.number,
              issueId: null,
              beforeLabels: row.labels,
              afterLabels: [],
              success: true,
              notes:
                `pruned cached issue ${row.repository.fullName}#${row.number} (${id}): ` +
                `GitHub labels match DISPATCH_EXCLUDED_LABELS; removed ` +
                `${lifecycleEvents} lifecycle event(s) and ${laneClassifications} ` +
                `lane classification(s) with it`,
            },
          });
          return true;
        },
        // READ COMMITTED, pinned. The dependent-row counts must see a row
        // committed AFTER this transaction started — that is what turns the
        // concurrent insert into a refusal instead of a cascade-delete. Under
        // READ COMMITTED every statement takes a fresh snapshot, so the counts
        // read the committed state; under a stronger level (REPEATABLE READ /
        // SERIALIZABLE) the counts would read this transaction's original
        // snapshot, miss the dependent row, and the delete would destroy work
        // that committed while the decision was running. Pinning the level
        // makes the guarantee independent of the server default.
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
      // The pending-repo-name entry is dropped only once the issue itself is
      // gone. On a refusal the sync core persists the GitHub-authoritative
      // labels via updateIssue, which needs this entry to record the
      // excluded-label transition as lifecycle evidence (#1202) — clearing it
      // up front would silently skip that recording.
      if (pruned) repoByIssueId.delete(id);
      return pruned;
    },
    async createIssue(repositoryId: string, data: SyncedIssueData) {
      // Stamp the configured default claimable lane so a freshly-ingested,
      // not-yet-groomed issue lands on a lane a worker actually polls. Without
      // this it fell through to the column default, which was a hardcoded
      // "normal" — an alias, not a configured lane, in a renamed deployment —
      // and the issue was invisible to the queue until grooming re-laned it
      // (dispatch#964). Resolves per-deployment, so nothing lane-specific is
      // baked in. Escalation-labeled issues (e.g. scan/CVE CI failures) are
      // routed straight to the escalation/frontier lane (#988).
      await prisma.issue.create({
        data: { ...data, repositoryId, currentLane: assertValidLaneForWrite(currentLaneForLabels(data.labels)) },
      });
    },
  };
}

/**
 * Sync-time lane sweep (#1589).
 *
 * An issue whose `currentLane` holds a lane id that is neither configured nor
 * aliased (a retired lane) is invisible to groomer selection and to claim
 * polls, and no other path ever corrects it — the row persists in the cache
 * forever. After each sync pass, re-lane those rows to the configured
 * non-claimable backlog lane: the selector treats the backlog lane as needing
 * classification, so the groomer re-lanes the issue with current lane
 * semantics. Backlog is the only safe target — it is never claimable, so a
 * swept issue cannot be grabbed mid-flight by a poll for the retired id.
 *
 * Aliased lane ids are deliberately left alone: aliases are a read-time
 * resolution mechanism that never rewrites issue data (see lane-config).
 *
 * Provenance rides with every write, matching the lane route's transactional
 * pattern: the re-lane, the note appended to `groomingSummary`, and the
 * IssueLane history row commit together — a failed history write rolls the
 * re-lane back rather than committing a lane change without provenance, and
 * the next sync retries. `model: "lane-sweep"` distinguishes sweep rows from
 * model/heuristic classifications.
 *
 * Each issue commits in its own interactive transaction that re-reads the
 * row under write contention and re-checks `currentLane` and the freshly-read
 * `groomingSummary` in the update's WHERE clause: a groomer, reconcile, or
 * lane-API write landing between the sweep's candidate query and this
 * transaction — a lane change, or a summary-only refresh that leaves the
 * retired lane untouched — makes the conditional write miss, and the sweep
 * skips the row and retries on the next sync pass. The concurrent writer's
 * value always wins over the sweep's stale read. One residual window is
 * accepted: a groom that blocks on the sweep's row lock and re-writes the
 * summary after the sweep's update lands replaces the note (its own
 * last-writer semantics; the re-lane survives and the IssueLane history row
 * keeps the provenance).
 *
 * Returns the number of issues re-laned. A failure on one issue is logged and
 * does not abort the sweep or the sync that hosts it. Closed swept rows are
 * inert — grooming selects open issues only — but they are still swept, so no
 * cache row anywhere outlives the sync with a retired lane id.
 */
export async function sweepRetiredLanes(repositoryIds: string[]): Promise<number> {
  if (repositoryIds.length === 0) return 0;
  const backlog = getBacklogLane();
  if (!backlog) return 0; // No non-claimable lane configured — nothing safe to re-lane to.

  // One distinct query first: lane values in the cache are few, so in the
  // common (no retired lanes) case the sweep costs exactly this query.
  const laneValues = await prisma.issue.findMany({
    where: { repositoryId: { in: repositoryIds }, currentLane: { not: null } },
    select: { currentLane: true },
    distinct: ["currentLane"],
  });

  let swept = 0;
  for (const { currentLane } of laneValues) {
    const info = getUnconfiguredLaneInfo(currentLane);
    if (!info || info.isAliased) continue; // configured, aliased, or unset — not the sweep's business

    const note = `Lane sweep: retired lane "${info.rawId}" is not in the configured lane set; re-laned to backlog lane "${backlog.id}" for re-grooming.`;
    const candidates = await prisma.issue.findMany({
      where: { repositoryId: { in: repositoryIds }, currentLane: info.rawId },
      select: { id: true, number: true, repository: { select: { fullName: true } } },
    });

    for (const issue of candidates) {
      try {
        const didSweep = await prisma.$transaction(async (tx) => {
          const fresh = await tx.issue.findUnique({
            where: { id: issue.id },
            select: { currentLane: true, groomingSummary: true },
          });
          if (!fresh || fresh.currentLane !== info.rawId) return false;
          const summary = await tx.issue.updateMany({
            where: {
              id: issue.id,
              currentLane: info.rawId,
              // CAS on the summary this transaction read: a concurrent write
              // that refreshed groomingSummary without touching the lane must
              // win, so this write misses and the sweep retries next pass.
              groomingSummary: { equals: fresh.groomingSummary },
            },
            data: {
              currentLane: backlog.id,
              groomingSummary: fresh.groomingSummary?.trim()
                ? `${fresh.groomingSummary.trim()}\n${note}`
                : note,
            },
          });
          if (summary.count === 0) return false; // lane re-set concurrently — keep the fresher value
          await tx.issueLane.create({
            data: {
              issueId: issue.id,
              lane: backlog.id,
              confidence: "high",
              reason: note,
              model: "lane-sweep",
            },
          });
          return true;
        });
        if (didSweep) swept++;
      } catch (error) {
        console.error(`Lane sweep failed for ${issue.repository.fullName}#${issue.number}:`, error);
      }
    }
  }
  return swept;
}

/**
 * Candidate query for reconcileClosedIssues.
 *
 * Uses labels.hasSome instead of currentLane (currentLane stores lane IDs
 * like "normal"/"frontier", not status labels). Also includes issues with
 * status/done that still have state="open" (stale cache — label was applied
 * but the state field wasn't updated yet).
 */
export function findActiveCachedIssuesForReconcile(
  repositoryId: string,
): Promise<Array<{ id: string; number: number; labels: string[]; state: string }>> {
  return prisma.issue.findMany({
    where: {
      repositoryId,
      OR: [
        // Issues with active status labels (may be stale if GitHub closed them)
        {
          state: { in: ["open", "closed"] as const },
          labels: {
            hasSome: ACTIVE_STATUS_LABELS,
          },
        },
        // Issues with status/done that still show as open (stale state field)
        {
          state: "open",
          labels: { has: "status/done" },
        },
      ],
    },
    select: { id: true, number: true, labels: true, state: true },
  });
}

/**
 * Prisma-backed store for reconcileClosedIssues (closed-issue reconciliation),
 * shared by the scheduled sync route and the heartbeat orchestrator so both
 * record the same lifecycle evidence for the same writes.
 */
export function makePrismaReconcileIssueStore(): {
  findActiveCachedIssues: typeof findActiveCachedIssuesForReconcile;
  updateIssue(
    id: string,
    data: { labels: string[]; state: string; closedAt: Date | null },
    previous?: IssueSyncSnapshot | null,
  ): Promise<void>;
} {
  return {
    findActiveCachedIssues: findActiveCachedIssuesForReconcile,
    async updateIssue(id, data, previous) {
      // Evidence before the mirror, for the same reason as the sync store
      // above: a failed event write must leave the cache untouched so the next
      // run can re-derive the transition. The repo lookup is this store's only
      // extra read; it moves ahead of the update rather than being added for it.
      if (previous) {
        const repo = await prisma.issue.findUnique({
          where: { id },
          select: { number: true, repository: { select: { fullName: true } } },
        });
        if (repo) {
          await recordSyncedIssueEvents(prisma, {
            issueId: id,
            repoFullName: repo.repository.fullName,
            issueNumber: repo.number,
            before: { labels: previous.labels, state: previous.state ?? null },
            after: { labels: data.labels, state: data.state, closedAt: data.closedAt },
          });
        }
      }

      await prisma.issue.update({ where: { id }, data });
    },
  };
}

export async function refreshSingleIssue(
  repoFullName: string,
  issueNumber: number,
  fetchIssueFn: (repoFullName: string, issueNumber: number) => Promise<GitHubIssue>,
): Promise<RefreshIssueResult> {
  try {
    const ghIssue = await fetchIssueFn(repoFullName, issueNumber);
    const issueData = githubIssueToSyncedIssueData(ghIssue);

    return {
      success: true,
      repo: repoFullName,
      issueNumber,
      action: "created",
      error: null,
      issueData,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Issue refresh failed for ${repoFullName}#${issueNumber}:`, error);
    return {
      success: false,
      repo: repoFullName,
      issueNumber,
      action: "created",
      error: message,
    };
  }
}
