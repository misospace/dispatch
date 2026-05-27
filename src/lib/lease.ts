// ─── Lease helpers for resumable agent work ──────────────────────────────────
//
// Issue: misospace/dispatch#166
//
// These utilities manage agent work leases — durable checkpoints that let
// cron workers and harnesses resume interrupted work without overlapping
// another agent's claimed work.

import { prisma } from "@/lib/prisma";
import type { CheckpointValue, ResumeContext, ResumeContextWithLease } from "./next-action";
import { buildResumeContext, isValidCheckpoint } from "./next-action";

// ─── Lease TTL defaults ─────────────────────────────────────────────────────
// How long a lease is valid after its last renewal (in milliseconds).
// 30 minutes covers typical cron intervals (15 min) with headroom.

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Calculate the expiry timestamp for a lease with the given TTL.
 */
export function calculateLeaseExpiry(ttlMs: number = DEFAULT_LEASE_TTL_MS): Date {
  return new Date(Date.now() + ttlMs);
}

// ─── Lease creation / renewal ────────────────────────────────────────────────

/**
 * Create or renew a lease for an agent on a specific issue.
 *
 * If an active (non-expired) lease exists for the same agent+issue, it is
 * renewed (expiredAt pushed forward, renewedAt set). Otherwise a new lease
 * is created.
 */
export async function upsertLease(params: {
  agentName: string;
  issueId: string;
  checkpoint?: CheckpointValue;
  branch?: string;
  prUrl?: string;
  ttlMs?: number;
}): Promise<{ created: boolean; lease: any }> {
  const now = new Date();
  const checkpoint = params.checkpoint ?? "issue_claimed";
  const expiredAt = calculateLeaseExpiry(params.ttlMs);

  // Check for an existing lease for this agent+issue
  const existing = await prisma.lease.findUnique({
    where: { agentName_issueId: { agentName: params.agentName, issueId: params.issueId } },
  });

  if (existing) {
    // Renew: push expiry forward and record renewal timestamp
    await prisma.lease.update({
      where: { id: existing.id },
      data: { expiredAt, renewedAt: now, checkpoint, branch: params.branch, prUrl: params.prUrl },
    });
    return { created: false, lease: await prisma.lease.findUniqueOrThrow({ where: { id: existing.id } }) };
  }

  // Create new lease (checkpoint is required in the schema)
  const lease = await prisma.lease.create({
    data: {
      agentName: params.agentName,
      issueId: params.issueId,
      expiredAt,
      checkpoint,
      branch: params.branch,
      prUrl: params.prUrl,
    },
  });
  return { created: true, lease };
}

// ─── Lease expiry helpers ────────────────────────────────────────────────────

/**
 * Check whether a lease is expired relative to the given reference time.
 */
export function isLeaseExpired(lease: { expiredAt: Date }, now: Date = new Date()): boolean {
  return lease.expiredAt <= now;
}

/**
 * Find all active (non-expired) leases for the given issue.
 * Returns an empty array if no active leases exist.
 */
export async function findActiveLeasesForIssue(issueId: string): Promise<any[]> {
  const now = new Date();
  return prisma.lease.findMany({
    where: { issueId, expiredAt: { gt: now } },
  });
}

/**
 * Find all expired leases for the given issue (useful for stale recovery).
 */
export async function findExpiredLeasesForIssue(issueId: string): Promise<any[]> {
  const now = new Date();
  return prisma.lease.findMany({
    where: { issueId, expiredAt: { lte: now } },
  });
}

/**
 * Release (delete) a specific lease by ID. Returns the deleted lease or null.
 */
export async function releaseLease(leaseId: string): Promise<any | null> {
  try {
    return await prisma.lease.delete({ where: { id: leaseId } });
  } catch {
    return null;
  }
}

/**
 * Release all expired leases for a given issue. Returns count of released leases.
 */
export async function releaseExpiredLeases(issueId: string): Promise<number> {
  const now = new Date();
  const expired = await prisma.lease.findMany({
    where: { issueId, expiredAt: { lte: now } },
    select: { id: true },
  });
  if (expired.length === 0) return 0;

  await prisma.lease.deleteMany({
    where: { id: { in: expired.map((l: any) => l.id) } },
  });
  return expired.length;
}

// ─── Active work resolution ──────────────────────────────────────────────────

/**
 * Resolve active work for an agent.
 *
 * Returns a ResumeContext with checkpoint, branch, PR URL, and nextAction
 * if the agent has an active (non-expired) lease on any issue.
 * Returns null if no active lease exists or the referenced issue is orphaned.
 *
 * Orphan detection: if the lease references an Issue that no longer exists in
 * Dispatch's database, the lease is released and null is returned so the agent
 * can pick up new work instead of being blocked by a ghost assignment.
 */
export async function resolveActiveWork(agentName: string): Promise<ResumeContextWithLease | null> {
  const now = new Date();

  // Find the agent's non-expired lease (most recently renewed first)
  const lease = await prisma.lease.findFirst({
    where: { agentName, expiredAt: { gt: now } },
    orderBy: { renewedAt: "desc" },
    include: { issue: { include: { repository: true } } },
  });

  if (!lease) return null;

  // Defensive check: skip expired leases (should already be filtered by query)
  if (isLeaseExpired(lease)) {
    await releaseLease(lease.id);
    return null;
  }

  // Validate checkpoint before building context
  if (!isValidCheckpoint(lease.checkpoint)) {
    await releaseLease(lease.id);
    await prisma.auditLog.create({
      data: {
        actor: lease.agentName,
        action: "orphan_lease_released",
        repoFullName: "",
        issueId: lease.issueId ?? undefined,
        success: true,
        notes: `Released lease with corrupted checkpoint for agent ${lease.agentName}: ${lease.checkpoint}`,
      },
    });
    return null;
  }

  // Orphan detection: verify the referenced issue exists in Dispatch.
  // If the issue has been deleted or never synced, release the lease so the
  // agent is not permanently blocked by a ghost assignment.
  const issueExists = await prisma.issue.findUnique({
    where: { id: lease.issueId },
    select: { id: true },
  });

  if (!issueExists) {
    await releaseLease(lease.id);
    await prisma.auditLog.create({
      data: {
        actor: lease.agentName,
        action: "orphan_lease_released",
        repoFullName: "",
        issueId: lease.issueId ?? undefined,
        success: true,
        notes: `Released orphaned lease for agent ${lease.agentName} — referenced issue ${lease.issueId} not found in Dispatch`,
      },
    });
    return null;
  }

  return {
    ...buildResumeContext({
      issueId: lease.issueId,
      repoFullName: lease.issue.repository.fullName,
      issueNumber: lease.issue.number,
      agentName: lease.agentName,
      checkpoint: lease.checkpoint as CheckpointValue,
      branch: lease.branch ?? undefined,
      prUrl: lease.prUrl ?? undefined,
    }),
    leaseId: lease.id,
    lane: lease.issue.currentLane ?? "normal",
    status: lease.issue.state,
    labels: lease.issue.labels,
  };
}

/**
 * Find all issues that have active leases from other agents (excluding the given agent).
 */
export async function findLeasedIssueIds(agentName: string): Promise<string[]> {
  const now = new Date();
  const leases = await prisma.lease.findMany({
    where: {
      agentName: { not: agentName },
      expiredAt: { gt: now },
    },
    select: { issueId: true },
  });
  return leases.map((l: any) => l.issueId);
}

/**
 * Release (delete) all active leases for a given agent on a specific issue.
 * Used by the operator release endpoint and orphan cleanup.
 */
export async function releaseLeaseByAgentAndIssue(agentName: string, issueId: string): Promise<number> {
  const now = new Date();
  const result = await prisma.lease.deleteMany({
    where: { agentName, issueId, expiredAt: { gt: now } },
  });
  return result.count;
}

/**
 * Release (delete) all active leases for a given agent (any issue).
 * Used by operator release endpoint with agentName only.
 */
export async function releaseAllLeasesByAgent(agentName: string): Promise<number> {
  const now = new Date();
  const result = await prisma.lease.deleteMany({
    where: { agentName, expiredAt: { gt: now } },
  });
  return result.count;
}

/**
 * Release AgentWork records for a given agent on a specific issue.
 * Marks them as RELEASED and creates history entries.
 */
export async function releaseAgentWorkByAgentAndIssue(agentName: string, issueId: string): Promise<number> {
  const now = new Date();
  const active = await prisma.agentWork.findMany({
    where: { agentName, issueId, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
    select: { id: true },
  });

  if (active.length === 0) return 0;

  await prisma.$transaction(
    active.map((w: any) =>
      prisma.agentWork.update({
        where: { id: w.id },
        data: { state: "RELEASED", leaseExpiresAt: now },
      })
    )
  );

  await prisma.$transaction(
    active.map((w: any) =>
      prisma.agentWorkHistory.create({
        data: { workId: w.id, action: "released_by_operator", summary: "Released by operator via agentName+issueId" },
      })
    )
  );

  return active.length;
}
