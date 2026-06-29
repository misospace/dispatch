import { GitHubIssue } from "@/types";
import { isIssueExcludedByLabels } from "@/lib/issue-filters";

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
  findIssue(repositoryId: string, number: number): Promise<{ id: string } | null>;
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
  issueData?: SingleIssueData;
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

export interface SingleIssueData {
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

export function githubIssueToSingleIssueData(ghIssue: GitHubIssue): SingleIssueData {
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
    lastSyncedAt: new Date(),
    state: ghIssue.state,
  };
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

export async function syncIssuesForRepos(
  repos: SyncRepo[],
  fetchIssues: (repoFullName: string) => Promise<GitHubIssue[]>,
  store: IssueStore,
  excludedLabels: string[] = [],
): Promise<SyncResponse> {
  const results: SyncResult[] = [];
  let syncedCount = 0;

  for (const repo of repos) {
    try {
      const githubIssues = await fetchIssues(repo.fullName);
      let repoSyncedCount = 0;

      for (const ghIssue of githubIssues) {
        if (isIssueExcludedByLabels(ghIssue.labels.map((l) => l.name), excludedLabels)) {
          continue;
        }

        const issueData = githubIssueToSyncedIssueData(ghIssue);
        const existingIssue = await store.findIssue(repo.id, ghIssue.number);

        if (existingIssue) {
          // Preserve agent/* labels from Prisma in case GitHub hasn't propagated yet
          // This is handled by the caller's updateIssue callback via the extended store
          await store.updateIssue(existingIssue.id, issueData);
        } else {
          await store.createIssue(repo.id, issueData);
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
const RECONCILABLE_STATUS_LABELS = ["status/backlog", "status/ready", "status/in-progress", "status/in-review"] as const;

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

export async function refreshSingleIssue(
  repoFullName: string,
  issueNumber: number,
  fetchIssueFn: (repoFullName: string, issueNumber: number) => Promise<GitHubIssue>,
): Promise<RefreshIssueResult> {
  try {
    const ghIssue = await fetchIssueFn(repoFullName, issueNumber);
    const issueData = githubIssueToSingleIssueData(ghIssue);

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
