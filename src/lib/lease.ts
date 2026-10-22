// ─── Lease helpers for resumable agent work ──────────────────────────────────
//
// Issue: misospace/dispatch#166
//
// These utilities manage agent work leases — durable checkpoints that let
// cron workers and harnesses resume interrupted work without overlapping
// another agent's claimed work.

import { withIssueMutationGuard } from "./issue-mutation-guard";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { newClaimToken } from "@/lib/capacity-handoff";
import type { CheckpointValue, ResumeContext, ResumeContextWithLease } from "./next-action";
import { buildResumeContext, isValidCheckpoint } from "./next-action";

// ─── Lease TTL defaults ─────────────────────────────────────────────────────
// How long a lease is valid after its last renewal (in milliseconds).
// 30 minutes covers typical cron intervals (15 min) with headroom.

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Expected issue-mutation contention, not a lease-store failure. */
export class IssueMutationBusyError extends Error {
  constructor() {
    super("Issue mutation pending; lease cannot be renewed or reissued");
    this.name = "IssueMutationBusyError";
  }
}

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
  /** Internal: the claim route already holds the issue mutation guard. */
  mutationGuardHeld?: boolean;
}): Promise<{ created: boolean; lease: any }> {
  if (!params.mutationGuardHeld) {
    const result = await withIssueMutationGuard({ issueId: params.issueId, operation: "lease", agentName: params.agentName }, async () => ({
      complete: true, value: await upsertLease({ ...params, mutationGuardHeld: true }),
    }));
    if (result.status === "busy") throw new IssueMutationBusyError();
    return result.value;
  }
  const now = new Date();
  const checkpoint = params.checkpoint ?? "issue_claimed";
  const expiredAt = calculateLeaseExpiry(params.ttlMs);

  // Check for an existing lease for this agent+issue
  const existing = await prisma.lease.findUnique({
    where: { agentName_issueId: { agentName: params.agentName, issueId: params.issueId } },
  });

  if (existing) {
    // Renew: push expiry forward and record renewal timestamp.
    // #1251: a claim-path lease write is a fresh assertion of ACTIVE
    // ownership, so it must not inherit a previous terminal disposition or
    // external-wait marker from the same row (the claim route reuses a
    // live-but-disposed row instead of creating a new one). Terminal
    // evidence for the retired attempt lives in the lifecycle stream; the
    // lease row describes the CURRENT attempt only.
    //
    // #1256 fencing: reactivating a DISPOSED row is a NEW attempt, not a
    // renewal of the old one. Any disposition on the row means the previous
    // incarnation ended there (worker-ownership refuses register / renew /
    // disposition against a disposed row), so the write clears the terminal
    // fields AND rotates the claim token to a fresh one, atomically with the
    // clear. Keeping the retired token would re-validate the old
    // incarnation's receipt against the new active attempt: it could then
    // register / renew / dispose — or release through capacity-handoff —
    // work it no longer owns. The retired attempt's ownership provenance is
    // reset for the same reason: registration and renewal evidence belong to
    // the attempt that recorded them, and the row now describes the new one.
    //
    // A row with NO disposition is an ordinary renewal / heartbeat of the
    // SAME attempt (a live worker's own row): it keeps its claim token and
    // its registration + renewal evidence untouched, because a heartbeating
    // worker must not lose its receipt or have its liveness erased.
    const reactivating = Boolean(existing.disposition);
    const lease = await prisma.lease.update({
      where: { id: existing.id },
      data: {
        expiredAt,
        renewedAt: now,
        checkpoint,
        branch: params.branch,
        prUrl: params.prUrl,
        disposition: null,
        dispositionNote: null,
        successorRef: null,
        dispositionOccurredAt: null,
        dispositionObservedAt: null,
        retryAfter: null,
        waitReason: null,
        ...(reactivating
          ? {
              // Fresh attempt: new fencing token, no inherited provenance.
              claimToken: newClaimToken(),
              runRef: null,
              registeredAt: null,
              registrationOccurredAt: null,
              renewCount: 0,
              lastRenewalObservedAt: null,
              lastRenewalOccurredAt: null,
            }
          : {}),
      },
    });
    return { created: false, lease };
  }

  // Create new lease (checkpoint is required in the schema).
  // Two callers can race here when no lease exists yet: both pass the
  // findUnique null check, and one create wins the
  // @@unique([agentName, issueId]) constraint. The loser hits a P2002
  // unique violation — re-read and return the lease the winner created
  // instead of surfacing a 500 to the caller.
  //
  // #1256: creation mints the opaque claim token that fences later
  // capacity-handoff releases to THIS exact claim. Renewals deliberately keep
  // the token (a heartbeating worker must not lose its receipt); a released or
  // expired lease that is re-claimed is a NEW row with a NEW token, so old
  // tokens are inert against new claims.
  try {
    const lease = await prisma.lease.create({
      data: {
        agentName: params.agentName,
        issueId: params.issueId,
        expiredAt,
        checkpoint,
        branch: params.branch,
        prUrl: params.prUrl,
        claimToken: newClaimToken(),
      },
    });
    return { created: true, lease };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await prisma.lease.findUnique({
        where: { agentName_issueId: { agentName: params.agentName, issueId: params.issueId } },
      });
      if (winner) return { created: false, lease: winner };
    }
    throw err;
  }
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
 *
 * A lease carrying a `retryAfter` still in the future is a RUNNING park (#1316):
 * the wait deadline was recorded on purpose, so this abandoned-lease cleanup
 * must not destroy the park's claim receipt and `EXTERNAL_WAIT` evidence
 * (#1334) while the park is still running. The marker is written by both a
 * `blocked` ownership disposition and a renewal's `externalWait`, and both get
 * the same protection. The lease follows the normal cleanup once `retryAfter`
 * itself elapses; the stale-work sweep additionally deletes it through the
 * fenced delete when the parked row's own park deadline expires. Deliberately,
 * the claim-epoch fence fields (`claimToken`/`expiredAt`, #1317) are never
 * moved here: the skip is evaluated per call, not parked forward.
 */
export async function releaseExpiredLeases(issueId: string): Promise<number> {
  const now = new Date();
  const expired = await prisma.lease.findMany({
    where: {
      issueId,
      expiredAt: { lte: now },
      // Skip a park that is still running: `retryAfter IS NULL` (no wait
      // marker — SQL 3VL: a NULL `retryAfter` makes `retryAfter <= now`
      // UNKNOWN, never TRUE) or a `retryAfter` already in the past.
      OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
    },
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
    // #1256: the issued claim token, so a resuming worker keeps the receipt
    // that fences its capacity-handoff release to this exact claim.
    claimToken: lease.claimToken ?? undefined,
    lane: lease.issue.currentLane ?? "default",
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
