/**
 * Read-only "Needs Attention" collector (#1541).
 *
 * Loads the authoritative rows behind the projection in
 * `@/lib/needs-attention` from Dispatch's Postgres cache — only findMany
 * selects, never a write, never a forge call. Deriving the view must not
 * mutate queue state: attention is a presentation stage, and the underlying
 * records (PR-fix marks, execution states, ownership intents, no-PR parks)
 * stay the sole source of truth.
 */
import { prisma } from "@/lib/prisma";
import {
  computeNeedsAttention,
  type NeedsAttentionSnapshot,
} from "@/lib/needs-attention";

export async function collectNeedsAttentionSnapshot(
  now = new Date(),
): Promise<NeedsAttentionSnapshot> {
  const [prFixRows, executionRows, intentRows, noPrRows] = await Promise.all([
    prisma.prFixQueueItem.findMany({
      // Only the two statuses a human can unblock are candidates; QUEUED/
      // WAITING_EXTERNAL etc. are bounded automated states and are filtered
      // again (defensively) by the pure derivation.
      where: { status: { in: ["BLOCKED", "PARKED"] } },
      select: {
        id: true,
        repo: true,
        pr: true,
        issue: true,
        url: true,
        title: true,
        status: true,
        lane: true,
        type: true,
        outcome: true,
        decisionDetail: true,
        queuedAt: true,
      },
    }),
    prisma.agentExecution.findMany({
      where: { executionState: "AWAITING_REVIEW", endedAt: null },
      select: {
        id: true,
        agentName: true,
        executionState: true,
        endedAt: true,
        startedAt: true,
        lastObservedAt: true,
        workRefUrl: true,
        pullRequestNumber: true,
        summary: true,
      },
    }),
    // §8.7 fail-closed parks (#1254): pending intents whose bounded forge
    // retries are exhausted (`parkedAt` set) wait for the operator.
    prisma.ownershipReleaseIntent.findMany({
      where: { phase: "pending", parkedAt: { not: null } },
      select: {
        id: true,
        agentName: true,
        agentLabel: true,
        phase: true,
        parkedAt: true,
        issue: {
          select: {
            number: true,
            title: true,
            url: true,
            repository: { select: { fullName: true } },
          },
        },
      },
    }),
    // Live no-PR-conclusion parks (#1506): one per issue, cleared only by an
    // operator or an issue content edit.
    prisma.noPrConclusion.findMany({
      select: {
        id: true,
        agentName: true,
        outcome: true,
        summary: true,
        createdAt: true,
        issue: {
          select: {
            number: true,
            title: true,
            url: true,
            repository: { select: { fullName: true } },
          },
        },
      },
    }),
  ]);

  return computeNeedsAttention({
    now,
    prFixItems: prFixRows.map((row) => ({
      id: row.id,
      repo: row.repo,
      pr: row.pr,
      issue: row.issue,
      url: row.url,
      title: row.title,
      status: row.status,
      lane: row.lane,
      type: row.type,
      outcome: row.outcome,
      decisionDetail: row.decisionDetail,
      queuedAt: row.queuedAt,
    })),
    agentExecutions: executionRows.map((row) => ({
      id: row.id,
      agentName: row.agentName,
      executionState: row.executionState,
      endedAt: row.endedAt,
      startedAt: row.startedAt,
      lastObservedAt: row.lastObservedAt,
      workRefUrl: row.workRefUrl,
      pullRequestNumber: row.pullRequestNumber,
      summary: row.summary,
    })),
    ownershipIntents: intentRows.map((row) => ({
      id: row.id,
      agentName: row.agentName,
      agentLabel: row.agentLabel,
      phase: row.phase,
      parkedAt: row.parkedAt,
      issue: row.issue
        ? {
            number: row.issue.number,
            repoFullName: row.issue.repository.fullName,
            title: row.issue.title,
            url: row.issue.url,
          }
        : null,
    })),
    noPrConclusions: noPrRows.map((row) => ({
      id: row.id,
      agentName: row.agentName,
      outcome: row.outcome,
      summary: row.summary,
      createdAt: row.createdAt,
      issue: row.issue
        ? {
            number: row.issue.number,
            repoFullName: row.issue.repository.fullName,
            title: row.issue.title,
            url: row.issue.url,
          }
        : null,
    })),
  });
}
