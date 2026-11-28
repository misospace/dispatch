import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { fetchPullRequests, fetchClosedPullRequests, fetchIssues, fetchIssue, fetchReopenAfter, fetchLinkedPrHealthInput, getGitHubToken } from "@/lib/github";
import { getSyncRepos } from "@/lib/config";
import {
  extractFixingIssueNumbers,
  reconcileIssue,
  loadReopenEvidence,
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
import { isBacklogLane, assertValidLaneForWrite } from "@/lib/lane-config";
import { reconcileAnnotationReemitMs } from "@/lib/ownership-reconciliation";
import { computeLinkedPrHealth, toPersistedLinkedPrHealth, type LinkedPrHealth } from "@/lib/linked-pr-health";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { reconcileStalePrFixItems, reconcileDeletedPrFixItems } from "@/lib/pr-fix-queue";
import { enforceRateLimit } from "@/lib/rate-limit";
import { acquireLock, releaseLock, type AcquiredLock, type LockConflict } from "@/lib/sync-lock";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/** In-flight ceiling for the #1727 reopen-confirmation timeline reads. */
const REOPEN_CONFIRM_CONCURRENCY = 4;

/**
 * Run independent reads with at most `limit` in flight. A task's own failure
 * handling stays inside its `run`; the pool only bounds parallelism.
 */
async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        await run(items[next++]);
      }
    }),
  );
}

/**
 * Best-effort deleted-PR reap (#1641): a transient forge failure is reported,
 * never fatal — the response keeps `success` about the issues this route
 * reconciled. Shared by both exit paths, including the no-tracked-repos
 * early return (#1651): the reap is item-driven and needs no tracked-repo
 * list, so rows whose PR was deleted upstream must be reaped even when the
 * instance tracks no repository.
 */
async function runDeletedPrFixReap(): Promise<{ checked: number; markedStale: number; errored: number }> {
  try {
    return await reconcileDeletedPrFixItems(prisma);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pr-fix-queue] deleted-PR reap failed: ${message}`);
    return { checked: 0, markedStale: 0, errored: 1 };
  }
}

/**
 * Merge instant for close-authority ordering. A lexicographic compare of the
 * raw `merged_at` strings is chronological only while GitHub keeps its exact
 * second-precision UTC shape, so compare parsed times; an unparseable value
 * sorts below every dated merge instead of outranking one by punctuation.
 */
function mergeTimeMs(pr: { merged_at?: string | null }): number {
  const ms = pr.merged_at ? Date.parse(pr.merged_at) : NaN;
  return Number.isNaN(ms) ? -1 : ms;
}

/**
 * Record a #1727 withheld close. The close authority stays in the fetched
 * window and the issue stays open, so a deliberately-reopened issue would
 * otherwise earn an identical skip row every pass. Mirrors the #1363
 * annotation dedupe: an annotation identical to the issue's latest skip is
 * suppressed until the shared re-emit window elapses, then re-emitted once
 * as a fresh confirmation; a changed reason is always written. A failed
 * lookup falls through to the write — the skip stays best-effort-logged,
 * never skipped. With a cached issue row the lookup keys on `issueId` so it
 * rides the #1363 composite index and the row links to the issue; only an
 * unsynced issue falls back to repo+number.
 */
async function recordCloseSkippedAudit(input: {
  repoFullName: string;
  issueId: string | null;
  issueNumber: number;
  labels: string[];
  reason: string;
}): Promise<void> {
  try {
    const latest = await prisma.auditLog.findFirst({
      where: {
        actor: "reconciler",
        action: "reconcile_close_skipped",
        ...(input.issueId ? { issueId: input.issueId } : { repoFullName: input.repoFullName, issueNumber: input.issueNumber }),
      },
      orderBy: { createdAt: "desc" },
      select: { notes: true, createdAt: true },
    });
    if (
      latest &&
      latest.notes === input.reason &&
      Date.now() - latest.createdAt.getTime() < reconcileAnnotationReemitMs()
    ) {
      return;
    }
  } catch {
    // Dedupe is an optimization; never let its lookup mask the annotation.
  }

  await prisma.auditLog.create({
    data: {
      actor: "reconciler",
      action: "reconcile_close_skipped",
      repoFullName: input.repoFullName,
      issueId: input.issueId,
      issueNumber: input.issueNumber,
      beforeLabels: input.labels,
      afterLabels: input.labels,
      success: true,
      notes: input.reason,
    },
  });
}

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
 * 1. Detects merged PRs that close issues → closes them on GitHub, unless a
 *    recorded reopen observation postdates the merge (#1727)
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

  const limited = enforceRateLimit(`reconcile:${auth.throttleKey}`, RATE_LIMIT);
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
      // #1651: the deleted-PR reap reads queue rows and names each row's own
      // repository directly, so it never needed the tracked-repo list. Run it
      // before this early return, or an instance tracking no repository (or
      // a `repo` filter matching nothing) leaves rows whose PR was deleted
      // upstream dispatchable forever. Like the pr-followup empty path, the
      // reap sits behind a credential check: without one, every presence
      // probe answers `unknown` before it reaches the forge, each due row
      // still counts as considered and gets stamped, and the pass rotates the
      // 1-hour re-verify window on clean-looking zero-error counts without
      // reaping anything. The 404 stays the answer for "no repos"; it now
      // also reports what the reap did (#1652 review).
      let deletedResult = { checked: 0, markedStale: 0, errored: 0 };
      let reapSkipped: string | undefined;
      try {
        await getGitHubToken();
      } catch {
        reapSkipped = "no-github-credential";
      }
      if (!reapSkipped) {
        deletedResult = await runDeletedPrFixReap();
      }
      if (deletedResult.errored > 0) {
        console.warn(`[pr-fix-queue] deleted-PR reap errored on ${deletedResult.errored} item(s) (#1641)`);
      }
      return NextResponse.json({
        error: "No tracked repos found",
        prFixQueueDeletedChecked: deletedResult.checked,
        prFixQueueDeletedMarked: deletedResult.markedStale,
        prFixQueueDeletedErrored: deletedResult.errored,
        ...(reapSkipped ? { prFixQueueDeletedReapSkipped: reapSkipped } : {}),
      }, { status: 404 });
    }

    let totalIssuesReconciled = 0;
    let totalPrFixStaleChecked = 0;
    let totalPrFixStaleMarked = 0;
    let totalMergedPrsFound = 0;
    let totalOpenPrsChecked = 0;
    let totalIssuesClosed = 0;
    let totalClosesSkipped = 0;
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

        // Extract close authority and correlation evidence from merged PRs.
        // They are deliberately separate (#1727):
        // - `mergedCloseAuthority` holds only PRs whose *body* carries the
        //   "Fixes/Closes/Resolves #NNN" keywords workers write, and it is
        //   the sole input to the close decision. A branch name that matches
        //   an issue number is correlation, not completion evidence, and no
        //   longer feeds the close map.
        // - `mergedPrLinkEvidence` keeps *every* merged PR per issue with its
        //   link provenance (#1203): merge evidence records one event per
        //   linked PR — body-keyword or branch-name — whether or not the
        //   issue is closed, decoupled from any close.
        // The authority map keeps the newest merge per issue: the #1727
        // reopen check compares the issue's reopen observation against the
        // merge, and it is the freshest keyword merge — not the first one the
        // window happened to yield — that carries the current completion
        // claim. PR titles are never consulted as evidence (#1203): a
        // title-only match neither closes an issue nor records a merge for it.
        const mergedCloseAuthority = new Map<number, typeof allPrs[number]>();
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
          // 1. Body close keywords: the only close authority.
          for (const num of extractFixingIssueNumbers(pr.body ?? null)) {
            const incumbent = mergedCloseAuthority.get(num);
            if (!incumbent || mergeTimeMs(pr) > mergeTimeMs(incumbent)) {
              mergedCloseAuthority.set(num, pr);
            }
            recordLinkEvidence(num, pr, "body-keyword");
          }
          // 2. Branch name pattern: correlation only (#1727). It records link
          // evidence for the merged PR but never authorizes a close, even
          // when the branch number collides with an issue in no other way.
          const branch = pr.head?.ref ?? "";
          const match = branch.match(/issue[-_/]?(\d+)/i);
          if (match) {
            const issueNum = parseInt(match[1], 10);
            if (!isNaN(issueNum)) recordLinkEvidence(issueNum, pr, "branch-name");
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

        // #1727: load the reopen evidence for the issues the close authority
        // names before any close decision. Two observations prove a merge's
        // close was overridden: a sync-recorded `issue_reopened` lifecycle
        // event, and the cache row's own `closedAt` when sync has not seen
        // the reopen yet (GitHub nulls `closed_at` on reopen, so the cache
        // holds a close newer than the merge until sync catches up). The
        // cached-close signal cannot date a reopen of an issue that closed
        // before the merge — that one waits for sync's `issue_reopened`
        // event, bounded by the sync interval. A candidate with no cache row
        // at all (never synced, or pruned after its close and reopened since)
        // has no local history: it gets the same bounded timeline
        // confirmation as an in-doubt stamp, and an unreadable read holds the
        // close instead of letting the bare merge authority through
        // (#1730 review).
        const openIssueNumbers = new Set(
          issues.filter((i) => i.state === "open").map((i) => i.number),
        );
        const closeAuthorityIssueRows = new Map<number, (typeof existingIssues)[number]>();
        const uncachedCloseCandidates: number[] = [];
        for (const issueNum of mergedCloseAuthority.keys()) {
          const row = existingIssueByNumber.get(issueNum);
          if (row) closeAuthorityIssueRows.set(issueNum, row);
          else if (openIssueNumbers.has(issueNum)) uncachedCloseCandidates.push(issueNum);
        }
        let reopenEvidence = new Map<number, Date>();
        let reopenEvidenceError: string | null = null;
        // Candidates whose reopen history cannot be read at all — held like
        // the failed-lookup case below, per issue.
        const reopenUnreadable = new Set<number>();
        if (closeAuthorityIssueRows.size > 0 || uncachedCloseCandidates.length > 0) {
          if (closeAuthorityIssueRows.size > 0) {
            const idsByNumber = new Map<number, string>();
            for (const [issueNum, row] of closeAuthorityIssueRows) idsByNumber.set(issueNum, row.id);
            try {
              reopenEvidence = await loadReopenEvidence(prisma, idsByNumber);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              reopenEvidenceError = message;
              console.warn(
                `${repo.fullName}: reopen evidence lookup failed (${message}); closes are held until a pass can read it`,
              );
            }
          }
          // A sync-recorded `issue_reopened` stamps `occurredAt` with the
          // issue's `updated_at` at observation: an upper bound, and a comment
          // or label edit after a fresh merge can inflate it past that merge
          // and withhold a legitimate close for good. Before honoring such a
          // withhold, confirm the reopen against the issue timeline, where
          // the `reopened` activity carries its real time (#1727 review). The
          // cached-`closedAt` signal needs no confirmation: a recorded close
          // newer than the merge proves the later reopen exactly.
          //
          // Only an inflated event that no cached close already explains needs
          // a read, and the reads are independent, so they run through a small
          // pool: a repo whose window holds many keyword merges shortens without
          // opening one GitHub request per candidate at once.
          const needsConfirmation: Array<{ issueNum: number; mergedAtMs: number; uncached: boolean }> = [];
          for (const [issueNum] of closeAuthorityIssueRows) {
            const eventDate = reopenEvidence.get(issueNum);
            const mergedAtRaw = mergedCloseAuthority.get(issueNum)?.merged_at;
            const mergedAtMs = mergedAtRaw ? Date.parse(mergedAtRaw) : NaN;
            // No merge time means no `since` bound to read: leave the upper
            // bound in place and let `reconcileIssue` fail closed on it.
            if (!eventDate || Number.isNaN(mergedAtMs) || eventDate.getTime() <= mergedAtMs) continue;
            if ((closeAuthorityIssueRows.get(issueNum)?.closedAt?.getTime() ?? 0) > mergedAtMs) continue;
            needsConfirmation.push({ issueNum, mergedAtMs, uncached: false });
          }
          for (const issueNum of uncachedCloseCandidates) {
            const mergedAtRaw = mergedCloseAuthority.get(issueNum)?.merged_at;
            const mergedAtMs = mergedAtRaw ? Date.parse(mergedAtRaw) : NaN;
            // No merge time and no local history: nothing can show the close
            // would not override a maintainer.
            if (Number.isNaN(mergedAtMs)) {
              reopenUnreadable.add(issueNum);
              continue;
            }
            needsConfirmation.push({ issueNum, mergedAtMs, uncached: true });
          }
          await mapBounded(needsConfirmation, REOPEN_CONFIRM_CONCURRENCY, async ({ issueNum, mergedAtMs, uncached }) => {
            try {
              const confirmed = await fetchReopenAfter(repo.fullName, issueNum, new Date(mergedAtMs));
              if (confirmed) reopenEvidence.set(issueNum, confirmed);
              // A clean timeline refutes a cached event's inflated upper
              // bound; for an uncached candidate there is nothing to refute,
              // and the close proceeds.
              else if (!uncached) reopenEvidence.delete(issueNum);
            } catch (error) {
              // Fail closed: an unreadable or over-bound timeline cannot prove
              // the reopen predates the merge. With a cached row the upper
              // bound stands; without one the candidate is marked unreadable
              // and its close is held.
              const message = error instanceof Error ? error.message : String(error);
              console.warn(
                `${repo.fullName}: reopen confirmation for #${issueNum} unavailable (${message}); close stays held`,
              );
              if (uncached) reopenUnreadable.add(issueNum);
            }
          });
          for (const [issueNum, row] of closeAuthorityIssueRows) {
            if (row.closedAt && (!reopenEvidence.has(issueNum) || row.closedAt > reopenEvidence.get(issueNum)!)) {
              reopenEvidence.set(issueNum, row.closedAt);
            }
          }
        }

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
            mergedCloseAuthority,
            openPrToIssue,
            linkedPrHealthByIssue,
            reopenEvidence,
          );

          // #1727: a withheld close means no close write and no merge-driven
          // label churn, and the merge still earns its `pr_merged` evidence
          // below — correlation stays decoupled from the close. Two sources
          // withhold. (1) The reopen gate inside `reconcileIssue`: a reopen the
          // pass cannot place before the merge. The issue's own status handling
          // still runs, because the maintainer's reopen says the work is
          // unfinished — open-PR health labels, and the in-review-with-no-PR
          // release to ready. (2) A failed reopen-evidence read: without the
          // stream there is no proof a close would not override a maintainer,
          // and no evidence either, so it withholds the close and writes no
          // label. A close held for one pass is retried by the next (waiting
          // costs freshness, never correctness).
          let closeSkippedReason = result.closeSkippedReason ?? null;
          // Stable note: the raw error is logged, never embedded, so a
          // flapping fault with varying messages cannot defeat the
          // annotation dedupe for the duration of an outage.
          if (
            !closeSkippedReason &&
            reopenEvidenceError &&
            mergedCloseAuthority.has(issue.number) &&
            result.actions.some((a) => a.type === "close_issue")
          ) {
            closeSkippedReason = "reopen evidence unavailable; holding close for a later pass";
          }
          // A candidate with no local history whose timeline read failed is
          // held per issue: no evidence either way, so no close, no labels.
          if (
            !closeSkippedReason &&
            reopenUnreadable.has(issue.number) &&
            result.actions.some((a) => a.type === "close_issue")
          ) {
            closeSkippedReason = "reopen evidence unavailable; holding close for a later pass";
          }
          // The gate above is only as fresh as the pass-start snapshot, so
          // re-read the live issue immediately before the close write
          // (#1727 review): an upstream close makes ours redundant, and a
          // failed read means we would be writing blind. This read costs one
          // request per issue actually being closed and deliberately stays
          // adjacent to the write rather than joining the parallel evidence
          // pass above, where it would shrink nothing. The residual window
          // between this read and the PATCH is documented in
          // docs/issue-lifecycle-events.md.

          if (
            !closeSkippedReason &&
            result.actions.some((a) => a.type === "close_issue")
          ) {
            try {
              const live = await fetchIssue(repo.fullName, issue.number);
              if (live.state !== "open") {
                closeSkippedReason = "issue already closed upstream; no close needed";
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`${repo.fullName}: live issue recheck before close failed (${message}); close is held`);
              closeSkippedReason = "live issue recheck failed; holding close for a later pass";
            }
          }
          const actions = closeSkippedReason
            ? result.actions.filter((a) => a.type !== "close_issue")
            : result.actions;
          if (closeSkippedReason) {
            totalClosesSkipped++;
            await recordCloseSkippedAudit({
              repoFullName: repo.fullName,
              issueId: existingIssue?.id ?? null,
              issueNumber: issue.number,
              labels: currentLabels,
              reason: closeSkippedReason,
            });
          }

          // Execute actions against GitHub
          if (actions.length > 0) {
            const executed = await executeActions(
              actions.map((a) => ({ ...a, repoFullName: repo.fullName })),
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
                  mergedCloseAuthority.get(exec.action.issueNumber) ??
                  openPrToIssue.get(exec.action.issueNumber) ??
                  null,
                mergedPrs: mergedPrLinkEvidence.get(exec.action.issueNumber) ?? null,
                executed: exec,
                client: prisma,
              });
            }
          }

          // Classify lane using heuristics — first-time set, or stale-backlog reclassification.
          // Each write also records an IssueLane history row in the same
          // transaction (#1598): lane history is the source consumers read
          // (GET /api/issues/[issueId]/lane reads the latest IssueLane row,
          // not the column), so a currentLane write without a history row is
          // invisible to them. Same shape as the lane route's writer.
          if (existingIssue && !existingIssue.currentLane) {
            // First-time classification: lane was never set.
            const classification = classifyLaneByHeuristics(
              issue.title,
              issue.body,
              currentLabels,
            );
            const persistedLane = assertValidLaneForWrite(classification.lane)!;
            await prisma.$transaction([
              prisma.issueLane.create({
                data: {
                  issueId: existingIssue.id,
                  lane: persistedLane,
                  confidence: classification.confidence,
                  reason: classification.reason,
                  model: "heuristic",
                },
              }),
              prisma.issue.update({
                where: { repositoryId_number: { repositoryId: repo.id, number: issue.number } },
                data: { currentLane: persistedLane },
              }),
            ]);
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
              // The reclassification delegates to the same heuristic
              // classifier, so its confidence/reason describe the signals
              // behind the decision; when the classifier itself still says
              // backlog, `shouldReclassifyStaleBacklog` fell back to the
              // default claimable lane and the note records that.
              const classification = classifyLaneByHeuristics(
                issue.title,
                issue.body,
                currentLabels,
              );
              const reason = reclassify === classification.lane
                ? classification.reason
                : `${classification.reason}; stale backlog lane fell back to the default claimable lane`;
              const persistedLane = assertValidLaneForWrite(reclassify)!;
              await prisma.$transaction([
                prisma.issueLane.create({
                  data: {
                    issueId: existingIssue.id,
                    lane: persistedLane,
                    confidence: classification.confidence,
                    reason,
                    model: "reconcile",
                  },
                }),
                prisma.issue.update({
                  where: { repositoryId_number: { repositoryId: repo.id, number: issue.number } },
                  data: { currentLane: persistedLane },
                }),
              ]);
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

    // #1641: a hard-deleted PR vanished from every PR listing, so the
    // merged/closed reap above can never see its row and it lingered in the
    // queue forever. This pass probes the per-PR endpoint for the rows it
    // reaches; a 404 at a readable repo whose PR listing does not show the PR
    // reaps the row through the same generation-AND-status-pinned terminal
    // write. It is bounded (rows read + per-PR probes) and rotates through
    // the queue, so running it from
    // both reconcile entry points cannot double-probe the same rows: a row
    // the other pass considered is not due again until its re-verify bound
    // elapses. Two routes that run at the SAME time can still overlap by one
    // pass, because each stamps the rows it considered only at the end of
    // its pass. Queue-wide, so it runs once — not per repo.
    const deletedResult = await runDeletedPrFixReap();
    if (deletedResult.errored > 0) {
      // Reported, not fatal: a transient forge failure is not an issue
      // reconciliation failure, and the response keeps `success` about the
      // issues it reconciled.
      console.warn(`[pr-fix-queue] deleted-PR reap errored on ${deletedResult.errored} item(s) (#1641)`);
    }

    return NextResponse.json({
      success: errors.length === 0,
      reposProcessed: repos.length,
      issuesReconciled: totalIssuesReconciled,
      mergedPrsFound: totalMergedPrsFound,
      openPrsChecked: totalOpenPrsChecked,
      issuesClosed: totalIssuesClosed,
      closesSkipped: totalClosesSkipped,
      labelsChanged: totalLabelsChanged,
      lanesClassified: totalLaneClassified,
      prFixQueueStaleChecked: totalPrFixStaleChecked,
      prFixQueueStaleMarked: totalPrFixStaleMarked,
      prFixQueueDeletedChecked: deletedResult.checked,
      prFixQueueDeletedMarked: deletedResult.markedStale,
      prFixQueueDeletedErrored: deletedResult.errored,
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
