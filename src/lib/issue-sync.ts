import { ACTIVE_STATUS_LABELS, GitHubIssue } from "@/types";
import { isIssueExcludedByLabels } from "@/lib/issue-filters";
import { prisma } from "@/lib/prisma";
import { fetchIssues } from "@/lib/github";

export interface SyncRepo {
  id: string;
  fullName: string;
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
}

export interface IssueStore {
  findIssue(repositoryId: string, number: number): Promise<{ id: string; labels: string[] } | null>;
  updateIssue(id: string, data: SyncedIssueData): Promise<void>;
  createIssue(repositoryId: string, data: SyncedIssueData): Promise<void>;
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
  };
}

/**
 * Preserve agent/* labels from the existing Prisma record when syncing from GitHub.
 * This prevents race conditions where the claim endpoint adds an agent/* label to
 * Prisma and GitHub, but a concurrent sync overwrites it with stale data.
 */
export function mergeLabels(ghLabels: string[], existingAgentLabels: string[]): string[] {
  const ghLabelSet = new Set(ghLabels);
  // Only add agent labels that aren't already on GitHub (avoids duplicates)
  const preserved = existingAgentLabels.filter((l) => l.startsWith("agent/") && !ghLabelSet.has(l));
  return [...ghLabels, ...preserved];
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
        if (isIssueExcludedByLabels(ghIssue.labels.map((l) => l.name), excludedLabels)) {
          continue;
        }

        const issueData = githubIssueToSyncedIssueData(ghIssue);

        // Closed ⇒ status/done (deterministic, every sync).
        const statusFix = closedIssueStatusFix(issueData.labels, issueData.state);
        issueData.labels = statusFix.labels;

        const existingIssue = await store.findIssue(repo.id, ghIssue.number);

        if (existingIssue) {
          // Preserve agent/* labels from the cached record in case GitHub hasn't
          // propagated a concurrent claim yet (see mergeLabels).
          if (existingIssue.labels.length > 0) {
            issueData.labels = mergeLabels(issueData.labels, existingIssue.labels);
          }
          await store.updateIssue(existingIssue.id, issueData);
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
    updateIssue(id: string, data: { labels: string[]; state: string; closedAt: Date | null }): Promise<void>;
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
              await store.updateIssue(cached.id, {
                labels: cached.labels,
                state: "closed",
                closedAt: ghIssue.closed_at ? new Date(ghIssue.closed_at) : new Date(),
              });

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

              await store.updateIssue(cached.id, {
                labels: newLabels,
                state: "closed",
                closedAt: ghIssue.closed_at ? new Date(ghIssue.closed_at) : new Date(),
              });

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
 * route, heartbeat). Narrows to `since = anchor - SYNC_OVERLAP_BUFFER_MS` when
 * the repo has a trustworthy prior anchor (i.e. already has cached issues);
 * otherwise does the full fetch as before. See getRepoSyncAnchor for why
 * "has cached issues" is the validity guard.
 */
export const fetchAllStateIssues = async (repo: SyncRepo): Promise<GitHubIssue[]> => {
  const anchor = await getRepoSyncAnchor(repo.id);
  const since = anchor ? new Date(anchor.getTime() - SYNC_OVERLAP_BUFFER_MS) : undefined;
  return fetchIssues(repo.fullName, { includeClosed: true, since });
};

/**
 * Prisma-backed IssueStore for syncIssuesForRepos. findIssue returns the
 * cached labels so the sync core can merge agent/* labels without a second
 * lookup per issue.
 */
export function makePrismaIssueStore(): IssueStore {
  return {
    findIssue(repositoryId: string, number: number) {
      return prisma.issue.findUnique({
        where: { repositoryId_number: { repositoryId, number } },
        select: { id: true, labels: true },
      });
    },
    async updateIssue(id: string, data: SyncedIssueData) {
      await prisma.issue.update({ where: { id }, data });
    },
    async createIssue(repositoryId: string, data: SyncedIssueData) {
      await prisma.issue.create({ data: { ...data, repositoryId } });
    },
  };
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
