import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { fetchPullRequests, fetchClosedPullRequests, fetchIssues, fetchLinkedPrHealthInput } from "@/lib/github";
import { getSyncRepos } from "@/lib/config";
import {
  extractFixingIssueNumbers,
  reconcileIssue,
  classifyLaneByHeuristics,
  shouldReclassifyStaleBacklog,
  executeActions,
} from "@/lib/issue-reconciliation";
import { isBacklogLane } from "@/lib/lane-config";
import { computeLinkedPrHealth, toPersistedLinkedPrHealth, type LinkedPrHealth } from "@/lib/linked-pr-health";
import { authorizeRequest } from "@/lib/auth";
import { reconcileStalePrFixItems } from "@/lib/pr-fix-queue";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

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
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`reconcile:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
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
      return errorResponse("No tracked repos found", 404);
    }

    let totalIssuesReconciled = 0;
    let totalPrFixStaleChecked = 0;
    let totalPrFixStaleMarked = 0;
    let totalMergedPrsFound = 0;
    let totalOpenPrsChecked = 0;
    let totalIssuesClosed = 0;
    let totalLabelsChanged = 0;
    let totalLaneClassified = 0;
    const errors: string[] = [];

    for (const repo of repos) {
      try {
        // Fetch open PRs (current board/health state) and recently-closed PRs
        // (to detect merged PRs that should close their fixing issue). The
        // open-only list never carries merged_at, so merged PRs come from the
        // closed fetch.
        const [openPrsList, closedPrsList] = await Promise.all([
          fetchPullRequests(repo.fullName, 100),
          fetchClosedPullRequests(repo.fullName, 100),
        ]);
        const allPrs = [...openPrsList, ...closedPrsList];

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

        // Extract issue numbers from merged PRs: scan body keywords first, then
        // fall back to branch name patterns so we catch "Fixes #NNN", "Closes #NNN",
        // "Resolves #NNN" references that workers write in PR bodies.
        const mergedFixingIssues = new Map<number, typeof allPrs[number]>();
        for (const [, pr] of mergedPrsMap) {
          // 1. Check PR body for keyword references (Fixes #, Closes #, Resolves #)
          const bodyNumbers = extractFixingIssueNumbers(pr.body ?? pr.title ?? null);
          for (const num of bodyNumbers) {
            if (!mergedFixingIssues.has(num)) {
              mergedFixingIssues.set(num, pr);
            }
          }
          // 2. Fallback: check branch name pattern
          if (!mergedFixingIssues.has(pr.number)) {
            const branch = pr.head?.ref ?? "";
            const match = branch.match(/issue[-_/]?(\d+)/i);
            if (match) {
              const issueNum = parseInt(match[1], 10);
              if (!isNaN(issueNum)) {
                if (!mergedFixingIssues.has(issueNum)) {
                  mergedFixingIssues.set(issueNum, pr);
                }
              }
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

        // The PR list endpoint omits reviewDecision/mergeStateStatus/checks, so
        // fetch a full health input per issue-linked open PR. This both feeds
        // reconcileIssue's needs_work judgment (via checkPrHealth, which adapts
        // the canonical computeLinkedPrHealth actionability signal) and produces
        // the linked-PR-health snapshot we persist on the issue below.
        // The PRs are independent, so fetch their health inputs in parallel.
        const linkedPrHealthByIssue = new Map<number, LinkedPrHealth | null>(
          await Promise.all(
            Array.from(openPrToIssue, async ([issueNum, pr]): Promise<[number, LinkedPrHealth | null]> => {
              const input = await fetchLinkedPrHealthInput(repo.fullName, pr);
              pr.reviewDecision = input.reviewDecision;
              pr.mergeStateStatus = input.mergeStateStatus;
              return [issueNum, computeLinkedPrHealth(input)];
            }),
          ),
        );

        // Fetch all issues for this repo
        const issues = await fetchIssues(repo.fullName);

        // Batch-load the existing issue rows once instead of a findUnique per issue.
        const existingIssues = await prisma.issue.findMany({
          where: { repositoryId: repo.id, number: { in: issues.map((i) => i.number) } },
        });
        const existingIssueByNumber = new Map(existingIssues.map((i) => [i.number, i]));

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
            linkedPrHealthByIssue,
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

          // Classify lane using heuristics — first-time set, or stale-backlog reclassification.
          const existingIssue = existingIssueByNumber.get(issue.number);

          if (existingIssue && !existingIssue.currentLane) {
            // First-time classification: lane was never set.
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
          } else if (existingIssue && existingIssue.currentLane && isBacklogLane(existingIssue.currentLane)) {
            // Stale-backlog reclassification: the issue has an active status label
            // but is stuck in the backlog lane. Reclassify to normal or escalated.
            const reclassify = shouldReclassifyStaleBacklog(
              existingIssue.currentLane,
              issue.title,
              issue.body,
              currentLabels,
            );
            if (reclassify) {
              await prisma.issue.update({
                where: { repositoryId_number: { repositoryId: repo.id, number: issue.number } },
                data: { currentLane: reclassify },
              });
              totalLaneClassified++;
            }
          }

          // Persist linked PR health. Write when the issue has a linked open PR;
          // otherwise clear any stale snapshot left from a PR that has since
          // closed or merged. Skip the write when there's nothing to clear.
          if (existingIssue) {
            const hasLinkedPr = openPrToIssue.has(issue.number);
            if (hasLinkedPr) {
              await prisma.issue.update({
                where: { repositoryId_number: { repositoryId: repo.id, number: issue.number } },
                data: toPersistedLinkedPrHealth(linkedPrHealthByIssue.get(issue.number) ?? null),
              });
            } else if (existingIssue.linkedPrNumber !== null) {
              await prisma.issue.update({
                where: { repositoryId_number: { repositoryId: repo.id, number: issue.number } },
                data: toPersistedLinkedPrHealth(null),
              });
            }
          }

          totalIssuesReconciled++;
        }

        // Reconcile pr-fix-queue items: mark stale when the upstream PR is
        // merged or closed. Uses the mergedPrsMap already built above. No
        // model judgment, deterministic.
        const mergedOrClosedPrs = new Set<number>();
        const prStates = new Map<number, "merged" | "closed">();
        for (const pr of mergedPrsMap.values()) {
          mergedOrClosedPrs.add(pr.number);
          prStates.set(pr.number, "merged");
        }
        for (const pr of closedPrsList) {
          if (pr.merged_at) continue; // already counted
          mergedOrClosedPrs.add(pr.number);
          prStates.set(pr.number, "closed");
        }
        const staleResult = await reconcileStalePrFixItems(
          prisma,
          new Map([[repo.fullName, mergedOrClosedPrs]]),
          new Map([[repo.fullName, prStates]]),
        );
        totalPrFixStaleChecked += staleResult.checked;
        totalPrFixStaleMarked += staleResult.markedStale;
        if (staleResult.errored > 0) {
          errors.push(`${repo.fullName}: pr-fix-queue reconcile errored on ${staleResult.errored} item(s)`);
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
      prFixQueueStaleChecked: totalPrFixStaleChecked,
      prFixQueueStaleMarked: totalPrFixStaleMarked,
      errors,
    });
  } catch (error) {
    console.error("Reconciliation failed:", error);
    return errorResponse("Reconciliation failed", 500);
  }
}

/**
 * GET endpoint to check reconciliation status and last run time.
 */
export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
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
    return errorResponse("Failed to fetch status", 500);
  }
}
