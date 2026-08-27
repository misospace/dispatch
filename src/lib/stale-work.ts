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

export interface StaleWorkClient {
  agentWork: {
    findMany: (args: any) => Promise<any[]>;
  };
  issue: {
    update: (args: any) => Promise<unknown>;
  };
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

/**
 * Reclaim expired AgentWork rows. GitHub is updated before the local row is
 * marked STALE, so an interrupted run leaves the row eligible for retry.
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
      state: { in: [...ACTIVE_WORK_STATES] },
      OR: [
        { lastHeartbeatAt: { lt: cutoff } },
        { leaseExpiresAt: { lt: cutoff } },
      ],
    },
    orderBy: { lastHeartbeatAt: "asc" },
    take: batchSize,
    include: {
      issue: {
        select: {
          id: true,
          number: true,
          labels: true,
          state: true,
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
      if (work.issue) {
        await releaseIssueClaim({
          prisma: client as IssueClaimClient,
          issue: work.issue,
          repoFullName: work.issue.repository.fullName,
          issueNumber: work.issue.number,
          agentName: work.agentName,
          options: { allowMissingAgent: true, preserveStatus: true },
        });
      }

      const marked = await client.$transaction(async (tx) => {
        const result = await tx.agentWork.updateMany({
          where: {
            id: work.id,
            state: { in: [...ACTIVE_WORK_STATES] },
            OR: [
              { lastHeartbeatAt: { lt: cutoff } },
              { leaseExpiresAt: { lt: cutoff } },
            ],
          },
          data: { state: "STALE", leaseExpiresAt: now },
        });
        if (result.count !== 1) return false;

        if (work.issueId) {
          await tx.lease.deleteMany({
            where: { agentName: work.agentName, issueId: work.issueId },
          });
        }
        await tx.agentWorkHistory.create({
          data: { workId: work.id, action: "stale" },
        });
        return true;
      });

      if (!marked) {
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
