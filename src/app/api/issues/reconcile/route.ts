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
  type ReconciliationAction,
} from "@/lib/issue-reconciliation";
import {
  lifecycleDedupeKey,
  lifecycleStatusLabel,
  recordLifecycleEvent,
  recordPrMergedEvent,
  recordStatusTransition,
  type LifecycleEventClient,
  type PrMergeObservation,
} from "@/lib/issue-lifecycle";
import { isBacklogLane } from "@/lib/lane-config";
import { computeLinkedPrHealth, toPersistedLinkedPrHealth, type LinkedPrHealth } from "@/lib/linked-pr-health";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { reconcileStalePrFixItems } from "@/lib/pr-fix-queue";
import { enforceRateLimit } from "@/lib/rate-limit";
import { acquireLock, releaseLock, type AcquiredLock, type LockConflict } from "@/lib/sync-lock";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/**
 * Record the lifecycle evidence for one executed reconciliation action.
 *
 * The reconciler reacts to what it observed on GitHub, so its events carry
 * the observation's own identity rather than Dispatch's clock: a merged PR is
 * identified by the PR's number and `merged_at`, and a status swap by the PR
 * that caused it plus the labels it moved between. A later reconcile pass
 * that re-derives the same conclusion upserts the row that already exists
 * instead of recording a second merge.
 *
 * Failures are logged, never thrown: the reconcile pass has already done its
 * GitHub work and recorded its audit row by this point, so an evidence-row
 * problem must not abort the remaining issues.
 */
export async function recordReconciledAction(input: {
  repo: { id: string; fullName: string };
  issueNumber: number;
  existingIssue: { id: string } | undefined;
  /** The PR whose state drove the action, when the action came from one. */
  mergedPr: { number: number; merged_at?: string | null } | null;
  /**
   * Every merged PR correlated to this issue (#1203), richest observation
   * first. An issue may legitimately carry several linked PRs; each one
   * records its own `pr_merged` event with its authoritative merge time and
   * link provenance. Absent, the single `mergedPr` is recorded as before.
   */
  mergedPrs?: readonly PrMergeObservation[] | null;
  executed: {
    action: ReconciliationAction;
    success: boolean;
    error?: string;
    beforeLabels: string[];
    afterLabels: string[];
  };
  client: LifecycleEventClient;
}): Promise<void> {
  const { repo, issueNumber, existingIssue, executed, client } = input;
  if (!existingIssue || !executed.success) return;

  const identity = lifecycleDedupeKey("reconciler", repo.fullName, issueNumber);
  const mergedPr = input.mergedPr;
  const prIdentity = mergedPr
    ? lifecycleDedupeKey(mergedPr.number, mergedPr.merged_at ?? "unknown")
    : null;

  try {
    if (executed.action.type === "close_issue") {
      // A merge is recorded separately from the close it causes: "the PR
      // merged" and "someone closed the issue" are different facts, and a
      // worker reporting success must never be able to assert either.
      // Every linked merged PR records its own event (#1203); the canonical
      // dedupe identity is shared with the pre-#1203 single-PR shape, so a
      // re-observed merge lands on the row that already exists.
      // Evidence list first; when the caller supplies no evidence list, the
      // PR that actually drove the close is still recorded — the correlation
      // is the observed action itself, so it carries
      // `reconcile-close-trigger` provenance rather than pretending a text
      // match. PR titles are never consulted as evidence (#1203), so this
      // fallback can only name a PR the caller already proved a link for.
      const observations: PrMergeObservation[] = [...(input.mergedPrs ?? [])];
      if (mergedPr && !observations.some((obs) => obs.prNumber === mergedPr.number)) {
        observations.push({
          prNumber: mergedPr.number,
          mergedAt: mergedPr.merged_at ?? null,
          linkSource: "reconcile-close-trigger",
        });
      }
      const mergeObservations: readonly PrMergeObservation[] = observations;
      for (const pr of mergeObservations) {
        await recordPrMergedEvent(client, {
          issueId: existingIssue.id,
          repoFullName: repo.fullName,
          issueNumber,
          source: "reconciler",
          actor: "reconciler",
          fromStatus: lifecycleStatusLabel(executed.beforeLabels),
          toStatus: lifecycleStatusLabel(executed.afterLabels),
          pr,
        });
      }

      await recordLifecycleEvent(client, {
        issueId: existingIssue.id,
        repoFullName: repo.fullName,
        issueNumber,
        kind: "issue_closed",
        source: "reconciler",
        actor: "reconciler",
        fromStatus: lifecycleStatusLabel(executed.beforeLabels),
        toStatus: lifecycleStatusLabel(executed.afterLabels),
        dedupeKey: lifecycleDedupeKey(identity, "issue_closed", prIdentity ?? "reconciler-close"),
        metadata: prIdentity ? { pullRequestNumber: mergedPr!.number } : null,
      });
      return;
    }

    if (executed.action.type === "set_status") {
      await recordStatusTransition(client, {
        issueId: existingIssue.id,
        repoFullName: repo.fullName,
        issueNumber,
        kind: "status_changed",
        source: "reconciler",
        actor: "reconciler",
        before: executed.beforeLabels,
        after: executed.afterLabels,
        // Without a PR to key on, the label pair itself is the identity: the
        // same swap re-derived on a later pass is the same conclusion.
        dedupeKey: prIdentity
          ? lifecycleDedupeKey(identity, "status_changed", prIdentity)
          : lifecycleDedupeKey(identity, "status_changed", executed.beforeLabels.join(","), executed.afterLabels.join(",")),
        metadata: prIdentity ? { pullRequestNumber: mergedPr!.number } : null,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`reconciler lifecycle evidence for ${repo.fullName}#${issueNumber} was not recorded: ${message}`);
  }
}

/**
 * Client shape the merge-evidence pass needs: the lifecycle write client plus the
 * issue-row loader it batch-reads through. Structurally satisfied by the
 * Prisma client, the same way `LifecycleEventClient` is.
 */
type ReconcileLifecycleClient = LifecycleEventClient & {
  issue: {
    findMany(args: {
      where: { repositoryId: string; number: { in: number[] } };
    }): Promise<Array<{ id: string; number: number }>>;
  };
};

/**
 * Record merge evidence for every linked merged PR in the fetched window,
 * decoupled from the action loop (#1203).
 *
 * `pr_merged` recording must not depend on a close executing, succeeding, or
 * on the issue still being open: a linked PR that merged after its issue
 * closed, while the issue sat outside the open-issue fetch window, or while
 * its close action failed, is still an authoritative merge and the timeline
 * would lose it. This pass re-derives the link from the already-fetched
 * merged-PR window (`fetchPullRequests` / `fetchClosedPullRequests`, maxItems
 * 100): no extra GitHub calls. It batch-loads the cached issue rows for every
 * linked number and records through the shared `recordPrMergedEvent` path
 * with no close or status writes (merges only: the merge must not invent a
 * transition). Rows the close path already wrote carry the same canonical
 * dedupe key, so they converge — a replaying reconcile produces exactly one
 * event per PR. Bounded by the fetched window; merges outside it remain the
 * operator-only backfill's territory.
 *
 * Failures are logged, never thrown, like `recordReconciledAction`: the pass
 * has already done its GitHub work, so an evidence-row problem must not abort
 * the remaining repos.
 */
export async function recordLinkedMergeEvidence(input: {
  repo: { id: string; fullName: string };
  /** Every merged PR per linked issue, richest observation first (#1203). */
  mergedPrLinkEvidence: ReadonlyMap<number, readonly PrMergeObservation[]>;
  client: ReconcileLifecycleClient;
}): Promise<void> {
  if (input.mergedPrLinkEvidence.size === 0) return;

  try {
    const existingIssues = await input.client.issue.findMany({
      where: { repositoryId: input.repo.id, number: { in: [...input.mergedPrLinkEvidence.keys()] } },
    });
    const cachedNumbers = new Set(existingIssues.map((row) => row.number));
    for (const issueNumber of input.mergedPrLinkEvidence.keys()) {
      if (!cachedNumbers.has(issueNumber)) {
        console.warn(
          `reconciler merge-evidence pass found no cached issue row for ${input.repo.fullName}#${issueNumber}; its linked merge evidence was not recorded`,
        );
      }
    }
    for (const existingIssue of existingIssues) {
      const observations = input.mergedPrLinkEvidence.get(existingIssue.number) ?? [];
      for (const pr of observations) {
        // Per-observation containment, like `recordReconciledAction`: one
        // failed row must not drop the remaining evidence in this repo.
        try {
          await recordPrMergedEvent(input.client, {
            issueId: existingIssue.id,
            repoFullName: input.repo.fullName,
            issueNumber: existingIssue.number,
            source: "reconciler",
            actor: "reconciler",
            pr,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `reconciler merge-evidence lifecycle evidence for ${input.repo.fullName}#${existingIssue.number} was not recorded: ${message}`,
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`reconciler merge-evidence lookup for ${input.repo.fullName} failed: ${message}`);
  }
}

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
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`reconcile:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  let lock: AcquiredLock | LockConflict | undefined;
  try {
    lock = await acquireLock("reconcile");
    if (!lock?.locked) {
      return NextResponse.json({ error: "Issue reconciliation is already running", locked: true }, { status: 409 });
    }

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

        // Extract issue numbers from merged PRs: scan PR bodies for the
        // "Fixes #NNN", "Closes #NNN", "Resolves #NNN" keywords workers write,
        // then collect branch name patterns.
        // `mergedFixingIssues` stays first-PR-wins because it drives the close
        // decision. `mergedPrLinkEvidence` keeps *every* merged PR per issue
        // with its link provenance (#1203): merge evidence records one event
        // per linked PR. Branch-name evidence is collected independently of
        // the close-decision map — a PR whose own number collides with an
        // issue number already in that map still records its branch link.
        // The branch claim still feeds the close decision, so the collision
        // case widens the reconciler's close reach: the branch-linked issue
        // number is closed by the same branch heuristic, under the same
        // first-PR-wins-per-issue-number rule. Only explicit correlations
        // qualify — a body Fixes/Closes/Resolves keyword or a branch-name
        // pattern. PR titles are deliberately not consulted (#1203,
        // review-required): a title-only match is neither close evidence nor
        // link evidence, so a merged PR that only names an issue in its title
        // neither closes it nor records a merge for it.
        const mergedFixingIssues = new Map<number, typeof allPrs[number]>();
        const mergedPrLinkEvidence = new Map<number, PrMergeObservation[]>();
        const recordLinkEvidence = (num: number, pr: (typeof allPrs)[number], linkSource: string) => {
          const existing = mergedPrLinkEvidence.get(num);
          if (existing?.some((obs) => obs.prNumber === pr.number)) return;
          const observation: PrMergeObservation = {
            prNumber: pr.number,
            prUrl: pr.html_url ?? pr.url ?? null,
            mergedAt: pr.merged_at ?? null,
            mergeCommitSha: pr.merge_commit_sha ?? null,
            headSha: pr.head?.sha ?? null,
            linkSource,
          };
          if (existing) existing.push(observation);
          else mergedPrLinkEvidence.set(num, [observation]);
        };
        for (const [, pr] of mergedPrsMap) {
          // 1. Check PR body for keyword references (Fixes #, Closes #, Resolves #)
          for (const num of extractFixingIssueNumbers(pr.body ?? null)) {
            if (!mergedFixingIssues.has(num)) {
              mergedFixingIssues.set(num, pr);
            }
            recordLinkEvidence(num, pr, "body-keyword");
          }
          // 2. Branch name pattern — collected for every merged PR, not only
          // for one whose own number is free in the close-decision map: the
          // link evidence a branch name carries is independent of which PR
          // the close decision picked for an issue number. The claim still
          // feeds the close decision, so in the collision case the
          // branch-linked issue is closed by the same branch heuristic.
          const branch = pr.head?.ref ?? "";
          const match = branch.match(/issue[-_/]?(\d+)/i);
          if (match) {
            const issueNum = parseInt(match[1], 10);
            if (!isNaN(issueNum)) {
              if (!mergedFixingIssues.has(issueNum)) {
                mergedFixingIssues.set(issueNum, pr);
              }
              recordLinkEvidence(issueNum, pr, "branch-name");
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
          // Resolved before the action loop so a reconciled action can be
          // attributed to the cached issue row, and reused below for lane and
          // linked-PR bookkeeping.
          const existingIssue = existingIssueByNumber.get(issue.number);
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

              await recordReconciledAction({
                repo,
                issueNumber: exec.action.issueNumber,
                existingIssue,
                mergedPr:
                  mergedFixingIssues.get(exec.action.issueNumber) ??
                  openPrToIssue.get(exec.action.issueNumber) ??
                  null,
                mergedPrs: mergedPrLinkEvidence.get(exec.action.issueNumber) ?? null,
                executed: exec,
                client: prisma,
              });
            }
          }

          // Classify lane using heuristics — first-time set, or stale-backlog reclassification.
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

        // (#1203) Merge evidence is decoupled from the action loop: a linked
        // merge records whether the issue is open or closed and whether the
        // close action executed. Rows the close path already wrote carry the
        // same dedupe keys and converge; this pass catches every other case.
        await recordLinkedMergeEvidence({
          repo,
          mergedPrLinkEvidence,
          client: prisma,
        });

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
  } finally {
    if (lock && lock.locked) {
      await releaseLock(lock.runId);
    }
  }
}

/**
 * GET endpoint to check reconciliation status and last run time.
 */
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
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
