import { prisma } from "@/lib/prisma";
import { releaseIssueClaim, type IssueClaimClient } from "@/lib/issue-claim";

export const DEFAULT_STALE_WORK_MAX_AGE_MS = 5 * 60 * 1000;
export const DEFAULT_STALE_WORK_BATCH_SIZE = 50;
const ACTIVE_WORK_STATES = ["CLAIMED", "IN_PROGRESS", "BLOCKED"] as const;

export interface StaleWorkReport {
  examined: number;
  released: number;
  skipped: number;
  errors: Array<{ workId: string; error: string }>;
}

interface StaleWorkTransactionClient {
  agentWork: {
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
 * Reclaim expired AgentWork rows. A row is first moved to STALE with a
 * retryable marker in the database, then its GitHub claim is released. If the
 * process dies between those steps, the next sweep retries the marked row.
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
    skipped: 0,
    errors: [],
  };

  for (const work of candidates) {
    try {
      // Claim the stale transition before external I/O. A heartbeat that
      // commits first makes the conditional update miss; a heartbeat after
      // this point sees a terminal STALE row and cannot revive it midway.
      const marked = await client.$transaction(async (tx) => {
        if (work.state === "STALE") {
          const result = await tx.agentWork.updateMany({
            where: { id: work.id, state: "STALE", staleClaimReleasePending: true },
            data: { leaseExpiresAt: now },
          });
          if (result.count !== 1) return false;
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
            data: {
              state: "STALE",
              leaseExpiresAt: now,
              staleClaimReleasePending: true,
            },
          });
          if (result.count !== 1) return false;

          await tx.agentWorkHistory.create({
            data: { workId: work.id, action: "stale" },
          });
        }

        // Releasing the lease in the same transaction as the stale marker
        // keeps the database-side queue blockers consistent across retries.
        if (work.issueId) {
          await tx.lease.deleteMany({
            where: { agentName: work.agentName, issueId: work.issueId },
          });
        }
        return true;
      });

      if (!marked) {
        report.skipped++;
        continue;
      }

      if (work.issue) {
        await releaseIssueClaim({
          prisma: client,
          issue: work.issue,
          repoFullName: work.issue.repository.fullName,
          issueNumber: work.issue.number,
          agentName: work.agentName,
          options: { allowMissingAgent: true, preserveStatus: true },
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
