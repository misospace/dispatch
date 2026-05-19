import { GitHubIssue } from "@/types";

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

export async function syncIssuesForRepos(
  repos: SyncRepo[],
  fetchIssues: (repoFullName: string) => Promise<GitHubIssue[]>,
  store: IssueStore
): Promise<SyncResponse> {
  const results: SyncResult[] = [];
  let syncedCount = 0;

  for (const repo of repos) {
    try {
      const githubIssues = await fetchIssues(repo.fullName);
      let repoSyncedCount = 0;

      for (const ghIssue of githubIssues) {
        const issueData = githubIssueToSyncedIssueData(ghIssue);
        const existingIssue = await store.findIssue(repo.id, ghIssue.number);

        if (existingIssue) {
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
    const message = error instanceof Error ? error.message : "Unknown refresh error";
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
