/**
 * Shared heartbeat orchestration helpers for Dispatch.
 *
 * Provides best-effort sync and reconciliation logic that can be reused by
 * the agent-agnostic heartbeat endpoint and any future orchestrator.
 */

import { prisma } from "@/lib/prisma";
import { fetchIssues, syncStatusLabels } from "@/lib/github";
import { getSyncRepos, parseExcludedLabels } from "@/lib/config";
import {
  syncIssuesForRepos,
  mergeLabels,
  reconcileClosedIssues,
  type SyncedIssueData,
  type ClosedIssueReconcileResponse,
} from "@/lib/issue-sync";

// ---------------------------------------------------------------------------
// Sync orchestration
// ---------------------------------------------------------------------------

export interface SyncStepResult {
  synced: number;
  reposProcessed: number;
  warnings: string[];
  errors: string[];
  touchedIssueUrls: string[];
}

/**
 * Run issue sync best-effort and return aggregated results.
 *
 * Individual repo failures become warnings; a completely empty repo list
 * (or total failure to fetch repos) becomes an error so callers can
 * distinguish "nothing to do" from "something went wrong".
 */
export async function runSyncBestEffort(
  opts?: { excludedLabels?: string[] },
): Promise<SyncStepResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const touchedIssueUrls: string[] = [];
  let syncedCount = 0;
  let reposProcessed = 0;

  try {
    const repos = await getSyncRepos();

    if (repos.length === 0) {
      errors.push("No tracked repositories found — sync skipped");
      return { synced: 0, reposProcessed: 0, warnings, errors, touchedIssueUrls };
    }

    const excludedLabels = opts?.excludedLabels ?? parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS);

    const result = await syncIssuesForRepos(repos, fetchIssues, {
      findIssue(repositoryId: string, number: number) {
        return prisma.issue.findUnique({
          where: { repositoryId_number: { repositoryId, number } },
        });
      },
      async updateIssue(id: string, data: SyncedIssueData) {
        const existing = await prisma.issue.findUnique({
          where: { id },
          select: { labels: true },
        });

        if (existing && existing.labels.length > 0) {
          data.labels = mergeLabels(data.labels, existing.labels);
        }

        await prisma.issue.update({ where: { id }, data });
      },
      async createIssue(repositoryId: string, data: SyncedIssueData) {
        await prisma.issue.create({ data: { ...data, repositoryId } });
      },
    }, excludedLabels, syncStatusLabels);

    syncedCount = result.syncedCount;
    reposProcessed = result.repos;

    for (const r of result.results) {
      if (r.error) {
        warnings.push(`Sync warning for ${r.repo}: ${r.error}`);
      } else {
        // Collect touched issue URLs from successful repos
        // We don't have per-issue URLs here, so we note the repo was synced
        touchedIssueUrls.push(`repo:${r.repo}`);
      }
    }

    if (!result.success) {
      errors.push("Sync completed with one or more repo failures");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    errors.push(`Sync failed: ${message}`);
  }

  return { synced: syncedCount, reposProcessed, warnings, errors, touchedIssueUrls };
}

// ---------------------------------------------------------------------------
// Reconciliation orchestration
// ---------------------------------------------------------------------------

export interface ReconcileStepResult {
  issuesReconciled: number;
  issuesChecked: number;
  reposProcessed: number;
  warnings: string[];
  errors: string[];
}

/**
 * Run closed-issue reconciliation best-effort and return aggregated results.
 *
 * Individual repo failures become warnings; a completely empty repo list
 * becomes an error.
 */
export async function runReconcileBestEffort(): Promise<ReconcileStepResult> {
  const warnings: string[] = [];
  const errors: string[] = [];

  try {
    const repos = await getSyncRepos();

    if (repos.length === 0) {
      errors.push("No tracked repositories found — reconcile skipped");
      return { issuesReconciled: 0, issuesChecked: 0, reposProcessed: 0, warnings, errors };
    }

    const result = await reconcileClosedIssues(
      repos,
      async (repoFullName: string, issueNumber: number) => {
        // Fetch the latest issue state from GitHub for reconciliation
        const issues = await fetchIssues(repoFullName, { includeClosed: true });
        const found = issues.find((i) => i.number === issueNumber);
        if (!found) {
          throw new Error(`Issue #${issueNumber} not found in ${repoFullName}`);
        }
        return found;
      },
      {
        findActiveCachedIssues(repositoryId: string) {
          // FIX: Use labels.hasSome instead of currentLane (currentLane stores lane IDs
          // like "normal"/"frontier", not status labels). Also include issues with
          // status/done that still have state="open" (stale cache — label was applied
          // but state field wasn't updated yet).
          return prisma.issue.findMany({
            where: {
              repositoryId,
              OR: [
                // Issues with active status labels (may be stale if GitHub closed them)
                {
                  state: { in: ["open", "closed"] as const },
                  labels: {
                    hasSome: ["status/ready", "status/in-progress", "status/in-review"],
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
        },
        async updateIssue(id: string, data: { labels: string[]; state: string; closedAt?: Date | null }) {
          await prisma.issue.update({ where: { id }, data });
        },
      },
    );

    for (const r of result.results) {
      if (r.error && !r.reconciled) {
        warnings.push(`Reconcile warning for ${r.repo}#${r.issueNumber}: ${r.error}`);
      }
    }

    if (!result.success) {
      errors.push("Reconciliation completed with one or more failures");
    }
    return {
      issuesReconciled: result.issuesReconciled,
      issuesChecked: result.issuesChecked,
      reposProcessed: result.reposProcessed,
      warnings,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown reconcile error";
    errors.push(`Reconciliation failed: ${message}`);
  }

  return { issuesReconciled: 0, issuesChecked: 0, reposProcessed: 0, warnings, errors };
}
