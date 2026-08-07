import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { fetchIssue, syncStatusLabels } from "@/lib/github";
import { getSyncRepos, getTrackedRepos, parseExcludedLabels } from "@/lib/config";
import {
  syncIssuesForRepos,
  reconcileClosedIssues,
  makePrismaIssueStore,
  findActiveCachedIssuesForReconcile,
  fetchAllStateIssues,
  SyncResponse,
  ClosedIssueReconcileResponse,
} from "@/lib/issue-sync";
import { syncAutomationRepo } from "@/lib/automation-sync";
import { authorizeRequest } from "@/lib/auth";
import { acquireLock, releaseLock } from "@/lib/sync-lock";

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // Auth check — require Bearer token matching DISPATCH_AGENT_TOKEN
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("Invalid JSON body", 400);
  }

  const options = body as Record<string, unknown>;
  const syncIssues = options.issues !== false; // default true
  const syncAutomation = options.automation === true; // default false

  // Acquire shared DB lock to prevent overlapping runs across all sync types
  const lockResult = await acquireLock("scheduled");
  if (!lockResult.locked) {
    return NextResponse.json(
      { error: "A sync is already running. Try again later.", locked: true },
      { status: 409 },
    );
  }

  const { runId } = lockResult;
  const startedAt = new Date();

  try {
    let issueSync: SyncResponse | null = null;
    let closedIssueReconcile: ClosedIssueReconcileResponse | null = null;
    let automationResult: { synced: number; failed: number } | null = null;

    // Issue sync (default enabled)
    if (syncIssues) {
      const repos = await getSyncRepos();
      const excludedLabels = parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS);
      issueSync = await syncIssuesForRepos(repos, fetchAllStateIssues, makePrismaIssueStore(), excludedLabels, syncStatusLabels);

      // Reconcile closed issues with stale active statuses
      try {
        closedIssueReconcile = await reconcileClosedIssues(repos, fetchIssue, {
          findActiveCachedIssues: findActiveCachedIssuesForReconcile,
          async updateIssue(id, data) {
            await prisma.issue.update({
              where: { id },
              data: {
                labels: data.labels,
                state: data.state,
                closedAt: data.closedAt,
              },
            });
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("Closed issue reconciliation failed:", error);
        closedIssueReconcile = {
          success: false,
          reposProcessed: 0,
          issuesChecked: 0,
          issuesReconciled: 0,
          results: [{ repo: "", issueNumber: 0, reconciled: false, action: "no_change", error: message }],
        };
      }
    }

    // Automation sync (optional, opt-in)
    if (syncAutomation) {
      const trackedRepos = await getTrackedRepos();
      const results: { repo: string; result: { success: boolean } }[] = [];

      for (const repo of trackedRepos) {
        try {
          const result = await syncAutomationRepo(repo);
          if (!result.success) {
            console.error(`Automation sync failed for ${repo}:`, result.error);
          }
          results.push({ repo, result });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          console.error(`Automation sync failed for ${repo}:`, errorMessage);
          results.push({ repo, result: { success: false } });
        }
      }

      automationResult = {
        synced: results.filter((r) => r.result.success).length,
        failed: results.filter((r) => !r.result.success).length,
      };
    }

    // Update the sync run record
    const finishedAt = new Date();
    await prisma.issueSyncRun.updateMany({
      where: { id: runId, status: "running" },
      data: {
        status: "completed",
        completedAt: finishedAt,
        reposFetched: issueSync?.repos ?? 0,
        syncedCount: issueSync?.syncedCount ?? 0,
        notes: JSON.stringify({
          issueResults: issueSync?.results,
          closedIssueReconcile: closedIssueReconcile
            ? {
                issuesReconciled: closedIssueReconcile.issuesReconciled,
                issuesChecked: closedIssueReconcile.issuesChecked,
                results: closedIssueReconcile.results,
              }
            : null,
          automationResult,
        }),
      },
    });

    await releaseLock(runId);

    // Build response
    const response: Record<string, unknown> = {
      success: true,
      startedAt,
      finishedAt,
    };

    if (syncIssues && issueSync) {
      response.issues = {
        repos: issueSync.repos,
        syncedCount: issueSync.syncedCount,
        results: issueSync.results,
      };

      if (closedIssueReconcile) {
        response.closedIssueReconcile = {
          issuesReconciled: closedIssueReconcile.issuesReconciled,
          issuesChecked: closedIssueReconcile.issuesChecked,
          results: closedIssueReconcile.results,
        };
      }
    }

    if (syncAutomation && automationResult) {
      response.automation = {
        synced: automationResult.synced,
        failed: automationResult.failed,
      };
    }

    return NextResponse.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Scheduled sync failed:", error);

    // Update the sync run record with error
    await prisma.issueSyncRun.updateMany({
      where: { id: runId, status: "running" },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage,
      },
    }).catch((error) => {
      console.error("Failed to update sync run with error state:", error);
    });

    await releaseLock(runId).catch((error) => {
      console.error("Failed to release scheduled sync lock:", error);
    });

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
