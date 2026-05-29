import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchPullRequests, fetchIssues, fetchPullRequestHealthSignals } from "@/lib/github";
import { getSyncRepos } from "@/lib/config";
import {
  extractFixingIssueNumbers,
  prBranchMatchesIssue,
  reconcileIssue,
  classifyLaneByHeuristics,
  executeActions,
} from "@/lib/issue-reconciliation";
import { authorizeRequest } from "@/lib/auth";

/**
 * Reconcile issue state against PR state for all tracked repos.
 * 
 * This endpoint replaces the grooming logic that previously lived in
 * Saffron's project_groom.py scripts. It:
 * 1. Detects merged PRs that fix issues → closes them on GitHub
 * 2. Detects open PRs and checks their health → applies labels via GitHub API
 * 3. Classifies lanes using heuristics when model calls are unavailable
 * 
 * Dispatch calls this periodically (e.g., every 5 minutes) to keep issue
 * state current without relying on GitHub ProjectV2 columns.
 */
export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const repoFilter = typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).repo as string | undefined
      : undefined;

    // Get tracked repos
    const syncRepos = await getSyncRepos();
    const repos = repoFilter
      ? syncRepos.filter((r) => r.fullName === repoFilter)
      : syncRepos;

    if (repos.length === 0) {
      return NextResponse.json({ error: "No tracked repos found" }, { status: 404 });
    }

    let totalIssuesReconciled = 0;
    let totalMergedPrsFound = 0;
    let totalOpenPrsChecked = 0;
    let totalIssuesClosed = 0;
    let totalLabelsChanged = 0;
    let totalLaneClassified = 0;
    const errors: string[] = [];

    for (const repo of repos) {
      try {
        // Fetch all PRs (open and merged) for this repo
        const allPrs = await fetchPullRequests(repo.fullName, 100);
        
        const openPrsMap = new Map<number, typeof allPrs[number]>();
        const mergedPrsMap = new Map<number, typeof allPrs[number]>();

        // Separate open and merged PRs
        for (const pr of allPrs) {
          if (pr.merged_at) {
            mergedPrsMap.set(pr.number, pr);
          } else if (pr.state === "open") {
            openPrsMap.set(pr.number, pr);
          }
        }

        totalMergedPrsFound += mergedPrsMap.size;
        totalOpenPrsChecked += openPrsMap.size;

        // Extract issue numbers from merged PR bodies (if available via branch names)
        const mergedFixingIssues = new Map<number, typeof allPrs[number]>();
        for (const [, pr] of mergedPrsMap) {
          // Use branch name as proxy for issue reference
          const branch = pr.head?.ref ?? "";
          const match = branch.match(/issue[-_/]?(\d+)/i);
          if (match) {
            const issueNum = parseInt(match[1], 10);
            if (!isNaN(issueNum)) {
              mergedFixingIssues.set(issueNum, pr);
            }
          }
        }

        // Map open PRs to issues by branch name pattern
        const openPrToIssue = new Map<number, typeof allPrs[number]>();
        for (const [, pr] of openPrsMap) {
          const branch = pr.head?.ref ?? "";
          const match = branch.match(/issue[-_/]?(\d+)/i);
          if (match) {
            const issueNum = parseInt(match[1], 10);
            if (!isNaN(issueNum)) {
              openPrToIssue.set(issueNum, pr);
            }
          }
        }

        // The PR list endpoint omits reviewDecision and mergeStateStatus, so
        // enrich each issue-linked open PR with a per-PR health fetch. Without
        // this, checkPrHealth always sees null signals and reports "healthy".
        for (const pr of openPrToIssue.values()) {
          const signals = await fetchPullRequestHealthSignals(repo.fullName, pr.number);
          pr.reviewDecision = signals.reviewDecision;
          pr.mergeStateStatus = signals.mergeStateStatus;
        }

        // Fetch all issues for this repo
        const issues = await fetchIssues(repo.fullName);

        // Reconcile each issue
        for (const issue of issues) {
          if (issue.state !== "open") continue;

          const currentLabels = issue.labels.map((l) => l.name);
          const result = reconcileIssue(
            {
              number: issue.number,
              title: issue.title,
              body: issue.body,
              labels: currentLabels,
              state: issue.state,
            },
            mergedFixingIssues,
            openPrToIssue,
          );

          // Execute actions against GitHub
          if (result.actions.length > 0) {
            const executed = await executeActions(
              result.actions.map((a) => ({ ...a, repoFullName: repo.fullName })),
              currentLabels,
            );

            // Log each executed action to audit with real label deltas
            for (const exec of executed) {
              const labelsChanged = exec.action.type === "close_issue"
                ? exec.beforeLabels.length > 0
                : exec.beforeLabels.join(",") !== exec.afterLabels.join(",");

              if (labelsChanged) {
                totalLabelsChanged++;
              }

              await prisma.auditLog.create({
                data: {
                  actor: "reconciler",
                  action: `reconcile_${exec.action.type}`,
                  repoFullName: repo.fullName,
                  issueNumber: exec.action.issueNumber,
                  beforeLabels: exec.beforeLabels,
                  afterLabels: exec.afterLabels,
                  success: exec.success,
                  errorMessage: exec.error,
                  notes: exec.action.reason,
                },
              });

              if (exec.action.type === "close_issue" && exec.success) {
                totalIssuesClosed++;
              }
            }
          }

          // Classify lane using heuristics if not already set
          const existingIssue = await prisma.issue.findUnique({
            where: { repositoryId_number: { repositoryId: repo.id, number: issue.number } },
          });

          if (existingIssue && !existingIssue.currentLane) {
            const classification = classifyLaneByHeuristics(
              issue.title,
              issue.body,
              currentLabels,
            );
            await prisma.issue.update({
              where: { repositoryId_number: { repositoryId: repo.id, number: issue.number } },
              data: { currentLane: classification.lane },
            });
            totalLaneClassified++;
          }

          totalIssuesReconciled++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Reconciliation failed for ${repo.fullName}:`, error);
        errors.push(`${repo.fullName}: ${message}`);
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      reposProcessed: repos.length,
      issuesReconciled: totalIssuesReconciled,
      mergedPrsFound: totalMergedPrsFound,
      openPrsChecked: totalOpenPrsChecked,
      issuesClosed: totalIssuesClosed,
      labelsChanged: totalLabelsChanged,
      lanesClassified: totalLaneClassified,
      errors,
    });
  } catch (error) {
    console.error("Reconciliation failed:", error);
    return NextResponse.json({ error: "Reconciliation failed" }, { status: 500 });
  }
}

/**
 * GET endpoint to check reconciliation status and last run time.
 */
export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Get recent reconciliation audit logs
    const recentLogs = await prisma.auditLog.findMany({
      where: {
        actor: "reconciler",
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return NextResponse.json({
      lastRuns: recentLogs.map((log) => ({
        repo: log.repoFullName,
        issueNumber: log.issueNumber,
        action: log.action,
        reason: log.notes,
        success: log.success,
        beforeLabels: log.beforeLabels,
        afterLabels: log.afterLabels,
        timestamp: log.createdAt,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch reconciliation status:", error);
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
