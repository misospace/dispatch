import { prisma } from "@/lib/prisma";
import { releaseIssueClaim, type IssueClaimClient } from "@/lib/issue-claim";
import { lifecycleDedupeKey } from "@/lib/issue-lifecycle";

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

interface StaleWorkTransactionClient {
  agentWork: {
    findFirst: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  lease: {
    deleteMany: (args: any) => Promise<unknown>;
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
    deleteMany: (args: any) => Promise<unknown>;
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
 * `retained` means the row was reclaimed but its claim was NOT released,
 * because a live sibling row still owns that claim.
 */
interface StaleWorkOutcome {
  marked: boolean;
  retained: boolean;
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
 * The release is claim-incarnation safe: a row is only released when no live
 * sibling row for the same (agent, issue) still owns the claim. An older stale
 * row therefore never releases a lease and an `agent/*` label that a freshly
 * renewed worker still holds.
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

  for (const work of candidates) {
    try {
      // Claim the stale transition before external I/O. A heartbeat that
      // commits first makes the conditional update miss; a heartbeat after
      // this point sees a terminal STALE row and cannot revive it midway.
      const outcome = await client.$transaction(async (tx): Promise<StaleWorkOutcome> => {
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
          return { marked: true, retained: true, liveSiblingId: liveSibling.id };
        }

        // Releasing the lease in the same transaction as the stale marker
        // keeps the database-side queue blockers consistent across retries.
        if (work.issueId) {
          await tx.lease.deleteMany({
            where: { agentName: work.agentName, issueId: work.issueId },
          });
        }
        return { marked: true, retained: false, liveSiblingId: null };
      });

      if (!outcome?.marked) {
        report.skipped++;
        continue;
      }

      if (outcome.retained) {
        // The row was reclaimed, but the claim it could have released belongs
        // to a live sibling. Recorded as a retention, not a release: the
        // labels are unchanged because nothing was released.
        report.claimRetained++;
        const issueRef = [work.issueId, work.issue?.number != null ? `#${work.issue.number}` : null]
          .filter((part): part is string => Boolean(part))
          .join(" ");
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
            notes: `Retained the claim of stale AgentWork ${work.id} (agent ${work.agentName}, issue ${issueRef}): live AgentWork ${outcome.liveSiblingId} still owns the claim`,
          },
        });
        continue;
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
        continue;
      }

      report.released++;
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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
