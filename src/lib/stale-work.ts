import { prisma } from "@/lib/prisma";
import { releaseIssueClaim, type IssueClaimClient } from "@/lib/issue-claim";
import { lifecycleDedupeKey } from "@/lib/issue-lifecycle";
import { withIssueMutationGuard } from "@/lib/issue-mutation-guard";

export const DEFAULT_STALE_WORK_MAX_AGE_MS = 5 * 60 * 1000;
export const DEFAULT_STALE_WORK_BATCH_SIZE = 50;
const ACTIVE_WORK_STATES = ["CLAIMED", "IN_PROGRESS", "BLOCKED"] as const;

export interface StaleWorkReport {
  examined: number;
  released: number;
  /**
   * Rows reclaimed whose claim release was WITHHELD because a live sibling
   * `AgentWork` row for the same (agent, issue) still owns the claim.
   * Such a row is counted here only — never as `released`, never as `skipped`.
   */
  claimRetained: number;
  skipped: number;
  errors: Array<{ workId: string; error: string }>;
}

/**
 * The lease fields the sweep fences its delete on — the claim epoch.
 *
 * `claimToken` is minted per attempt (#1256): a released/pruned lease that is
 * claimed again gets a new row with a new token, so a token equality match can
 * never delete a NEWER attempt's receipt. `expiredAt` is moved by every renew
 * and by every (re-)claim, and `lastRenewalObservedAt` is moved by every
 * accepted ownership renewal (#1251). Together they identify "this exact claim
 * as of the snapshot read": any renew or re-claim that commits between the
 * snapshot and the delete changes at least one of them, and the fenced
 * `deleteMany` then matches nothing instead of destroying the live claim. A
 * fresh claim (a row created after the snapshot) is caught by the post-delete
 * existence recheck instead — no delete is attempted at all when the snapshot
 * saw no row. A terminal `disposition` write changes NONE of these fields, so
 * a worker cleanly disposing its claim never makes the sweep back off.
 */
interface ClaimEpochSnapshot {
  claimToken: string | null;
  expiredAt: Date;
  lastRenewalObservedAt: Date | null;
}

interface StaleWorkTransactionClient {
  agentWork: {
    findFirst: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  lease: {
    findFirst: (args: any) => Promise<ClaimEpochSnapshot | null>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  agentWorkHistory: {
    create: (args: any) => Promise<unknown>;
  };
}

export interface StaleWorkClient {
  agentWork: {
    findMany: (args: any) => Promise<any[]>;
  };
  issue: IssueClaimClient["issue"];
  lease: {
    findFirst: StaleWorkTransactionClient["lease"]["findFirst"];
    deleteMany: StaleWorkTransactionClient["lease"]["deleteMany"];
  };
  agentWorkHistory: {
    create: (args: any) => Promise<unknown>;
  };
  auditLog: {
    create: (args: any) => Promise<unknown>;
  };
  $transaction: <T>(fn: (tx: StaleWorkTransactionClient) => Promise<T>) => Promise<T>;
}

/**
 * What the mark transaction decided for one candidate row.
 *
 * `retained` means the row was reclaimed but its claim was NOT released:
 * - `live_sibling` — a live sibling `AgentWork` row still owns the claim.
 * - `claim_epoch_moved` — the lease's claim epoch changed between the sweep's
 *   snapshot read and its fenced delete (a renewal, a re-claim or a fresh
 *   claim committed inside the decision window), so the sweep backs off and
 *   leaves the lease, the label and the claim untouched.
 */
interface StaleWorkOutcome {
  marked: boolean;
  retained: boolean;
  retention?: "live_sibling" | "claim_epoch_moved";
  liveSiblingId?: string | null;
}

/**
 * Find a live sibling `AgentWork` row for the same (agent, issue) pair — a row
 * that still keeps the claim alive.
 *
 * The predicate is the sweeper's OWN staleness test inverted, but expressed
 * POSITIVELY. The sweeper reclaims a row when
 * `lastHeartbeatAt < cutoff OR leaseExpiresAt < cutoff`, so a row is live when
 * `lastHeartbeatAt >= cutoff AND (leaseExpiresAt >= cutoff OR leaseExpiresAt IS
 * NULL)`.
 *
 * Spelling it positively is not cosmetic: `leaseExpiresAt` is NULLABLE, and SQL
 * three-valued logic makes `NULL >= cutoff` UNKNOWN rather than false. A
 * negated form of the sweeper's own clause would therefore make a row with a
 * fresh heartbeat and a NULL expiry invisible — but such a row is NOT stale
 * under the sweeper's own `OR` predicate (the NULL arm is neither `< cutoff`),
 * so it must count as live here.
 *
 * The row being processed is excluded (`id: { not: work.id }`). That exclusion
 * is defence in depth, not the load-bearing part: the predicate above is the
 * exact complement of the sweeper's own candidate clause, so a candidate row
 * can never be live. The exclusion keeps the lookup correct even if the
 * candidate clause is ever widened.
 */
async function findLiveSiblingWork(
  tx: StaleWorkTransactionClient,
  work: { id: string; agentName: string; issueId: string | null },
  cutoff: Date,
): Promise<{ id: string } | null> {
  return tx.agentWork.findFirst({
    where: {
      agentName: work.agentName,
      issueId: work.issueId,
      id: { not: work.id },
      state: { in: [...ACTIVE_WORK_STATES] },
      lastHeartbeatAt: { gte: cutoff },
      OR: [{ leaseExpiresAt: { gte: cutoff } }, { leaseExpiresAt: null }],
    },
    select: { id: true },
  });
}

/**
 * Reclaim expired AgentWork rows. A row is first moved to STALE with a
 * retryable marker in the database, then its GitHub claim is released. If the
 * process dies between those steps, the next sweep retries the marked row.
 *
 * The release is claim-incarnation safe on two levels:
 *
 * 1. **Serialized fence.** Every release of an issue-scoped claim runs inside
 *    the same per-issue `IssueMutationGuard` fence (#1259) that claim, lease,
 *    ownership renewal and capacity release take. The lookup, the mark, the
 *    lease delete and the external GitHub label release all happen while the
 *    fence is held, so no writer can commit "between the check and the delete"
 *    — the TOCTOU the sibling lookup alone cannot close. A busy fence skips
 *    the row for this sweep (nothing is lost: the retry marker is only ever
 *    set inside the fenced window, and STALE+pending rows are sweep
 *    candidates again). A guard demoted to non-executing by a failed release
 *    is resumed by the next sweep of the same (issue, agent) — safe because
 *    every step is a conditional update or a deduped release. A guard left
 *    `executing` by a crashed process is never taken over automatically: it
 *    stays fail-closed (like a crashed claim guard) pending operator
 *    intervention.
 * 2. **Claim-epoch fence.** The lease delete is a compare-and-delete against
 *    a snapshot of `{claimToken, expiredAt, lastRenewalObservedAt}` taken
 *    BEFORE the sibling lookup, re-checked after the delete for any lease left
 *    on the pair. If any renew, re-claim or fresh claim commits between the
 *    snapshot and the delete, the fence no longer matches (or a new row shows
 *    up) and the sweep backs off: the row is still reclaimed (STALE) but the
 *    claim, lease and label are reported retained, never released. This is
 *    the belt to the fence's braces — it also covers any future writer that
 *    forgets the mutation guard.
 */
export async function sweepStaleWork(
  client: StaleWorkClient = prisma as unknown as StaleWorkClient,
  maxAgeMs = DEFAULT_STALE_WORK_MAX_AGE_MS,
  batchSize = DEFAULT_STALE_WORK_BATCH_SIZE,
): Promise<StaleWorkReport> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const candidates = await client.agentWork.findMany({
    where: {
      OR: [
        {
          state: { in: [...ACTIVE_WORK_STATES] },
          staleClaimReleasePending: false,
          OR: [
            { lastHeartbeatAt: { lt: cutoff } },
            { leaseExpiresAt: { lt: cutoff } },
          ],
        },
        { state: "STALE", staleClaimReleasePending: true },
      ],
    },
    orderBy: { lastHeartbeatAt: "asc" },
    take: batchSize,
    include: {
      issue: {
        select: {
          id: true,
          number: true,
          state: true,
          labels: true,
          blockedReason: true,
          linkedPrNumber: true,
          repository: { select: { fullName: true } },
        },
      },
    },
  });

  const report: StaleWorkReport = {
    examined: candidates.length,
    released: 0,
    claimRetained: 0,
    skipped: 0,
    errors: [],
  };

  // One candidate's full reclaim pipeline: mark STALE, delete the claim's
  // lease (fenced on its epoch), release the GitHub claim, finalize the row.
  // For issue-scoped claims the whole pipeline runs inside the per-issue
  // mutation fence held by the caller.
  const reclaimStaleRow = async (work: any): Promise<void> => {
    // Claim the stale transition before external I/O. A heartbeat that
    // commits first makes the conditional update miss; a heartbeat after
    // this point sees a terminal STALE row and cannot revive it midway.
    const outcome = await client.$transaction(async (tx): Promise<StaleWorkOutcome> => {
      // Claim-epoch snapshot, taken BEFORE the sibling lookup: every write the
      // fenced delete below can no longer match is a write that committed
      // inside the decision window (snapshot → delete), i.e. exactly the
      // renewal / re-claim the lookup raced against.
      const epoch = work.issueId
        ? await tx.lease.findFirst({
            where: { agentName: work.agentName, issueId: work.issueId },
            select: { claimToken: true, expiredAt: true, lastRenewalObservedAt: true },
          })
        : null;

      // Claim-incarnation guard. A live sibling row for the same (agent,
      // issue) still owns the claim, so this row's reclaim must not release
      // it. A row without an issue owns no claim at all (no lease, no
      // label), so there is nothing a sibling could be keeping alive.
      const liveSibling = work.issueId
        ? await findLiveSiblingWork(tx, work, cutoff)
        : null;

      if (work.state === "STALE") {
        const result = await tx.agentWork.updateMany({
          where: { id: work.id, state: "STALE", staleClaimReleasePending: true },
          // The retry marker is cleared in both cases: with a live sibling
          // the release is no longer owed, and without one the release is
          // about to happen below.
          data: liveSibling
            ? { leaseExpiresAt: now, staleClaimReleasePending: false }
            : { leaseExpiresAt: now },
        });
        if (result.count !== 1) return { marked: false, retained: false };
      } else {
        const result = await tx.agentWork.updateMany({
          where: {
            id: work.id,
            state: { in: [...ACTIVE_WORK_STATES] },
            staleClaimReleasePending: false,
            OR: [
              { lastHeartbeatAt: { lt: cutoff } },
              { leaseExpiresAt: { lt: cutoff } },
            ],
          },
          // A live sibling owns the claim, so no release is owed for this
          // row: the marker stays down and the retry loop stops.
          data: liveSibling
            ? { state: "STALE", leaseExpiresAt: now, staleClaimReleasePending: false }
            : { state: "STALE", leaseExpiresAt: now, staleClaimReleasePending: true },
        });
        if (result.count !== 1) return { marked: false, retained: false };

        await tx.agentWorkHistory.create({
          data: { workId: work.id, action: "stale" },
        });
      }

      if (liveSibling) {
        // The claim stays with the live sibling: no lease delete, no
        // release, so the `agent/<name>` label survives untouched.
        return { marked: true, retained: true, retention: "live_sibling", liveSiblingId: liveSibling.id };
      }

      // Releasing the lease in the same transaction as the stale marker
      // keeps the database-side queue blockers consistent across retries.
      // The delete is CAS-fenced on the epoch snapshot: a lease that was
      // renewed or re-claimed after the snapshot no longer matches and stays
      // untouched. With NO snapshot row there is nothing legitimate to
      // delete at all, so no delete is even attempted — a fresh claim created
      // inside the window can only be a row that postdates the snapshot, and
      // the existence recheck below catches it (no clock comparison needed).
      if (work.issueId) {
        let epochMoved = false;
        if (epoch) {
          const deleted = await tx.lease.deleteMany({
            where: {
              agentName: work.agentName,
              issueId: work.issueId,
              claimToken: epoch.claimToken,
              expiredAt: epoch.expiredAt,
              lastRenewalObservedAt: epoch.lastRenewalObservedAt,
            },
          });
          if ((deleted?.count ?? 0) !== 1) epochMoved = true;
        }
        // A lease on the pair at the end of the window that the sweep did not
        // consume — a fresh claim that raced in during the window, or behind
        // a successful delete — means the claim epoch moved.
        const remaining = await tx.lease.findFirst({
          where: { agentName: work.agentName, issueId: work.issueId },
          select: { claimToken: true },
        });
        if (remaining) epochMoved = true;
        if (epochMoved) {
          // A renewal, re-claim or fresh claim won the window. Back off — the
          // row stays reclaimed, but the lease, the label and the claim are
          // left alone, and the retry marker goes down so the next sweep does
          // not chase it. The next sweep re-decides against CURRENT state:
          // the fresh claim is then visible to the sibling lookup as well.
          const reverted = await tx.agentWork.updateMany({
            where: { id: work.id, state: "STALE" },
            data: { leaseExpiresAt: now, staleClaimReleasePending: false },
          });
          if (reverted.count !== 1) return { marked: false, retained: false };
          return { marked: true, retained: true, retention: "claim_epoch_moved" };
        }
      }
      return { marked: true, retained: false, liveSiblingId: null };
    });

    if (!outcome?.marked) {
      report.skipped++;
      return;
    }

    if (outcome.retained) {
      // The row was reclaimed, but the claim it could have released is live:
      // a sibling row still owns it, or the claim epoch moved under the
      // sweep. Recorded as a retention, not a release: the labels are
      // unchanged because nothing was released.
      report.claimRetained++;
      const issueRef = [work.issueId, work.issue?.number != null ? `#${work.issue.number}` : null]
        .filter((part): part is string => Boolean(part))
        .join(" ");
      const reason =
        outcome.retention === "claim_epoch_moved"
          ? "the claim epoch moved (renewal, re-claim or fresh claim committed inside the sweep's decision window)"
          : `live AgentWork ${outcome.liveSiblingId} still owns the claim`;
      // The retention decision is already committed and the row is no longer
      // a sweep candidate, so a failure here must NOT escape: it would leave
      // the mutation guard demoted with nothing left to resume it (resume is
      // only reachable from a candidate), freezing every claim-path write on
      // the issue. Surface the audit failure in the report instead.
      try {
        await client.auditLog.create({
          data: {
            actor: "system",
            action: "stale_agentwork_claim_retained",
            repoFullName: work.issue?.repository?.fullName ?? "",
            issueNumber: work.issue?.number ?? undefined,
            issueId: work.issueId ?? undefined,
            beforeLabels: work.issue?.labels ?? [],
            afterLabels: work.issue?.labels ?? [],
            success: true,
            notes: `Retained the claim of stale AgentWork ${work.id} (agent ${work.agentName}, issue ${issueRef}): ${reason}`,
          },
        });
      } catch (error) {
        report.errors.push({
          workId: work.id,
          error: `claim-retention audit failed (retention itself committed): ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (work.issue) {
      // The release is attributed to the sweep, not to the abandoned agent:
      // nobody chose to let this claim go, and a claim-to-merge read must be
      // able to tell a recovered stall apart from a worker's own unclaim
      // (#1202).
      await releaseIssueClaim({
        prisma: client,
        issue: work.issue,
        repoFullName: work.issue.repository.fullName,
        issueNumber: work.issue.number,
        agentName: work.agentName,
        options: {
          allowMissingAgent: true,
          preserveStatus: true,
          source: "stale-recovery",
          actor: "system",
          // This AgentWork row is this claim epoch, and it is stable across a
          // retry of the same sweep (the retry re-marks the same STALE row).
          // Keying the release on it means the release and the
          // already-released repair a retry has to take are one
          // `claim_released`, not two. A reclaimed issue gets a new row and
          // therefore a new key, so a genuine second release still counts.
          releaseKey: lifecycleDedupeKey("agent-work", work.id),
        },
      });
    }

    const finalized = await client.$transaction(async (tx) => {
      const result = await tx.agentWork.updateMany({
        where: { id: work.id, state: "STALE", staleClaimReleasePending: true },
        data: { staleClaimReleasePending: false },
      });
      return result.count === 1;
    });

    if (!finalized) {
      report.skipped++;
      return;
    }

    report.released++;
    // Same posture as the retention audit: the release is committed and the
    // row is finalized, so this audit must not escape and strand the guard
    // with no resumable candidate behind it.
    try {
      await client.auditLog.create({
        data: {
          actor: "system",
          action: "stale_agentwork_released",
          repoFullName: work.issue?.repository?.fullName ?? "",
          issueNumber: work.issue?.number ?? undefined,
          issueId: work.issueId ?? undefined,
          beforeLabels: work.issue?.labels ?? [],
          afterLabels: work.issue
            ? work.issue.labels.filter((label: string) => label !== `agent/${work.agentName}`)
            : [],
          success: true,
          notes: `Released stale AgentWork ${work.id} for agent ${work.agentName}`,
        },
      });
    } catch (error) {
      report.errors.push({
        workId: work.id,
        error: `release audit failed (release itself committed): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  for (const work of candidates) {
    try {
      if (work.issueId) {
        // Issue-scoped claim: run the whole decision-and-release pipeline
        // inside the per-issue mutation fence that claim, lease, ownership
        // renewal and capacity release take (#1259). Without it the sibling
        // lookup is a TOCTOU check: a renewal or fresh claim could commit
        // between the lookup and the delete, and the sweep would destroy a
        // live claim's lease and label. Busy means another claim-path writer
        // holds the issue: skip this row for this sweep — nothing is lost,
        // because a pending release is only ever owed from inside a fenced
        // window that completed far enough to owe one.
        const guarded = await withIssueMutationGuard(
          { issueId: work.issueId, operation: "stale-release", agentName: work.agentName },
          async () => ({ complete: true, value: await reclaimStaleRow(work) }),
        );
        if (guarded.status === "busy") report.skipped++;
      } else {
        // No issue: no lease, no label, nothing for a fence to protect.
        await reclaimStaleRow(work);
      }
    } catch (error) {
      report.errors.push({
        workId: work.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
