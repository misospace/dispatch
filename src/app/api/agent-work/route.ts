import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope, enforceWorkerBound } from "@/lib/worker-identity";
import { releaseLeaseByAgentAndIssue, releaseAllLeasesByAgent, releaseAgentWorkByAgentAndIssue } from "@/lib/lease";
import { AGENT_WORK_LEASE_DURATION_MS } from "@/lib/agent-work";
import { supersedeOwnershipReleaseIntent } from "@/lib/ownership-reconciliation";
import { enforceRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

interface AgentWorkItem {
  id: string;
  agentName: string;
  issueId: string | null;
  runId: string | null;
  state: string;
  checkpoint: string;
  branch: string | null;
  prUrl: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date;
  summary: string | null;
  blockerReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  issueNumber: number | null;
  issueTitle: string | null;
  repoFullName: string | null;
}

/**
 * Normalize an operator-supplied issue id (#1399).
 *
 * `AgentWork.issueId`, `Lease.issueId`, `AuditLog.issueId` and
 * `OwnershipReleaseIntent.issueId` are foreign keys to `Issue.id`, so a row
 * only ever carries the normalized id. The operator path keyed every lookup
 * on the raw request value, so a padded id matched no row: the release freed
 * nothing, and the reconciler's release intent was looked up on an id no row
 * carries. Normalizing the input makes it agree with the stored id, like the
 * worker paths do for their own `issueId` (#1328 checkpoint, #1331 finish).
 * A whitespace-only value is absent, matching those paths.
 */
function normalizeIssueId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toItem(w: any): AgentWorkItem {
  return {
    id: w.id,
    agentName: w.agentName,
    issueId: w.issueId,
    runId: w.runId,
    state: w.state,
    checkpoint: w.checkpoint,
    branch: w.branch,
    prUrl: w.prUrl,
    leaseExpiresAt: w.leaseExpiresAt,
    lastHeartbeatAt: w.lastHeartbeatAt,
    summary: w.summary,
    blockerReason: w.blockerReason,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    issueNumber: w.issue?.number ?? null,
    issueTitle: w.issue?.title ?? null,
    repoFullName: w.issue?.repository?.fullName ?? null,
  };
}

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const { searchParams } = new URL(request.url);
  const stateFilter = searchParams.get("state");
  const agentNameFilter = searchParams.get("agent");
  const includeStale = searchParams.get("include_stale") !== "false";

  // #1129: a bound worker may only list its own agent's work — the `?agent=`
  // filter can never widen its scope. An unbound legacy worker token is
  // refused here.
  const boundWorkerAgent =
    auth.authorized && auth.type === "bearer" ? auth.agentName : undefined;
  const unboundError = await enforceWorkerBound(auth);
  if (unboundError) return unboundError;
  if (boundWorkerAgent && agentNameFilter && agentNameFilter !== boundWorkerAgent) {
    const scopeError = await enforceWorkerAgentScope(auth, agentNameFilter);
    if (scopeError) return scopeError;
  }
  const effectiveAgentFilter = boundWorkerAgent ?? agentNameFilter;

  try {
    const where: Record<string, unknown> = {};

    if (stateFilter) {
      where.state = stateFilter;
    } else {
      where.OR = [
        { state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
        ...(includeStale ? [{ state: "STALE" }] : []),
      ];
    }

    if (effectiveAgentFilter) {
      where.agentName = effectiveAgentFilter;
    }

    const activeItems = await prisma.agentWork.findMany({
      where,
      orderBy: { lastHeartbeatAt: "desc" },
      include: {
        issue: {
          select: { number: true, title: true, repository: { select: { fullName: true } } },
        },
      },
    });

    const items: AgentWorkItem[] = activeItems.map(toItem);

    const now = new Date();
    // #1129: a bound worker's stale-lease view is scoped to its own agent too;
    // otherwise the listing would leak every other agent's leases.
    const leaseWhere: Record<string, unknown> = { expiredAt: { lte: now } };
    if (effectiveAgentFilter) leaseWhere.agentName = effectiveAgentFilter;
    const expiredLeases = await prisma.lease.findMany({
      where: leaseWhere,
      orderBy: { expiredAt: "asc" },
      take: 50,
      include: {
        issue: {
          select: { number: true, title: true, repository: { select: { fullName: true } } },
        },
      },
    });

    const staleLeases = expiredLeases.map((l: any) => ({
      id: `lease-${l.id}`,
      agentName: l.agentName,
      issueId: l.issueId,
      runId: null,
      state: "STALE",
      checkpoint: l.checkpoint,
      branch: l.branch,
      prUrl: l.prUrl,
      leaseExpiresAt: l.expiredAt,
      lastHeartbeatAt: l.renewedAt ?? l.createdAt,
      summary: null,
      blockerReason: "Lease expired",
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      issueNumber: l.issue?.number ?? null,
      issueTitle: l.issue?.title ?? null,
      repoFullName: l.issue?.repository?.fullName ?? null,
    }));

    return NextResponse.json({ activeWork: items, staleLeases });
  } catch (error) {
    return handleApiError("fetch agent work", error);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`agent-work:${auth.throttleKey}`, { limit: 30, windowMs: 10_000 });
  if (limited) return limited;

  try {
    const body = await request.json();
    const action = body.action as string;

    if (action === "release") {
      return await releaseAgentWork(body);
    } else if (action === "reassign") {
      return await reassignAgentWork(body);
    } else {
      return errorResponse("Unknown action", 400);
    }
  } catch (error) {
    console.error("Failed to process agent work action:", error);
    return errorResponse("Failed to process request", 500);
  }
}

async function releaseAgentWork(body: Record<string, unknown>) {
  const workId = typeof body.workId === "string" ? body.workId : null;
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : null;
  const agentName = typeof body.agentName === "string" ? body.agentName : null;
  // #1399: normalize the operator-supplied issue id so a padded value
  // matches the normalized id stored on the row.
  const issueId = normalizeIssueId(body.issueId);
  const releaseAll = body.releaseAll === true;
  const reason = typeof body.reason === "string" ? body.reason : "Released by operator";

  // Original release path by workId or leaseId (backward compatible)
  if (workId || leaseId) {
    try {
      let work = null;

      if (workId) {
        const existing = await prisma.agentWork.findUnique({ where: { id: workId } });
        if (!existing) {
          return errorResponse("Work item not found", 404);
        }
        // #1254: an operator release supersedes a pending reconciler release
        // intent (audited) instead of racing its Phase-B delete.
        if (existing.issueId) {
          await supersedeOwnershipReleaseIntent({ issueId: existing.issueId, actor: "operator", reason: "operator agent-work release" });
        }
        if (existing.state === "DONE" || existing.state === "RELEASED") {
          return errorResponse("Work is already completed or released", 400);
        }

        work = await prisma.$transaction(async (tx) => {
          const updated = await tx.agentWork.update({
            where: { id: workId },
            data: { state: "RELEASED", leaseExpiresAt: new Date() },
            include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
          });
          await tx.agentWorkHistory.create({
            data: { workId, action: "released", summary: reason },
          });
          return updated;
        });

        await prisma.auditLog.create({
          data: {
            actor: "operator",
            action: "agent_work_released",
            repoFullName: work.issue?.repository?.fullName ?? "",
            issueNumber: work.issue?.number,
            issueId: work.issueId,
            success: true,
            notes: `Released work for agent ${work.agentName}: ${reason}`,
          },
        });
      }

    if (leaseId) {
        const lease = await prisma.lease.findUnique({ where: { id: leaseId }, include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } } });
        if (!lease) {
          return errorResponse("Lease not found", 404);
        }

        // #1254: operator release supersedes a pending reconciler intent.
        await supersedeOwnershipReleaseIntent({ issueId: lease.issueId, actor: "operator", reason: "operator lease release" });
        await prisma.lease.delete({ where: { id: leaseId } });

        await prisma.auditLog.create({
          data: {
            actor: "operator",
            action: "lease_released",
            repoFullName: lease.issue?.repository?.fullName ?? "",
            issueNumber: lease.issue?.number,
            issueId: lease.issueId,
            success: true,
            notes: `Released lease for agent ${lease.agentName}: ${reason}`,
          },
        });
      }

      return NextResponse.json({ success: true, reason });
    } catch (error) {
      console.error("Failed to release agent work:", error);
      await prisma.auditLog.create({
        data: {
          actor: "operator",
          action: "agent_work_release_failed",
          repoFullName: "",
          success: false,
          errorMessage: String(error),
        },
      });
      return errorResponse("Failed to release agent work", 500);
    }
  }

  // New release path by agentName + issueId (operator recovery for orphaned work)
  if (!agentName) {
    return errorResponse("Missing workId, leaseId, or agentName", 400);
  }

  try {
    let releasedLeases = 0;
    let releasedWork = 0;
    let repoFullName = "";
    let issueNumber: number | null = null;

    if (issueId) {
      // #1254: operator release supersedes a pending reconciler intent.
      await supersedeOwnershipReleaseIntent({ issueId, actor: "operator", reason: "operator agent-work release" });
      // Release by agentName + issueId
      const [leasesReleased, workReleased] = await Promise.all([
        releaseLeaseByAgentAndIssue(agentName, issueId),
        releaseAgentWorkByAgentAndIssue(agentName, issueId),
      ]);
      releasedLeases = leasesReleased;
      releasedWork = workReleased;

      // Get issue details for audit log
      const issue = await prisma.issue.findUnique({
        where: { id: issueId },
        select: { number: true, repository: { select: { fullName: true } } },
      });
      if (issue) {
        repoFullName = issue.repository.fullName;
        issueNumber = issue.number;
      }
    } else if (releaseAll) {
      // Release all active work for an agent
      const [leasesReleased, workItems] = await Promise.all([
        releaseAllLeasesByAgent(agentName),
        prisma.agentWork.findMany({
          where: { agentName, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
          select: { id: true, issueId: true },
        }),
      ]);
      releasedLeases = leasesReleased;

      // Release each work item and collect repo info from the first one
      if (workItems.length > 0) {
        const now = new Date();
        await prisma.$transaction(
          workItems.map((w: any) =>
            prisma.agentWork.update({
              where: { id: w.id },
              data: { state: "RELEASED", leaseExpiresAt: now },
            })
          )
        );
        await prisma.$transaction(
          workItems.map((w: any) =>
            prisma.agentWorkHistory.create({
              data: { workId: w.id, action: "released_by_operator", summary: `Released all work for agent ${agentName}: ${reason}` },
            })
          )
        );
        releasedWork = workItems.length;

        // Get repo info from the first issue that has one
        const firstIssue = await prisma.agentWork.findFirst({
          where: { id: workItems[0].id },
          include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
        });
        if (firstIssue?.issue) {
          repoFullName = firstIssue.issue.repository.fullName;
          issueNumber = firstIssue.issue.number;
        }
      }
    } else {
      return errorResponse("Missing required field: issueId, or set releaseAll: true", 400);
    }

    await prisma.auditLog.create({
      data: {
        actor: "operator",
        action: "orphan_work_released",
        repoFullName,
        issueNumber: issueNumber ?? undefined,
        issueId: issueId ?? undefined,
        success: true,
        notes: `Released ${releasedLeases} lease(s) and ${releasedWork} work item(s) for agent ${agentName}: ${reason}`,
      },
    });

    return NextResponse.json({
      success: true,
      reason,
      releasedLeases,
      releasedWork,
    });
  } catch (error) {
    console.error("Failed to release agent work:", error);
    await prisma.auditLog.create({
      data: {
        actor: "operator",
        action: "orphan_work_release_failed",
        repoFullName: "",
        success: false,
        errorMessage: String(error),
      },
    });
    return errorResponse("Failed to release agent work", 500);
  }
}

async function reassignAgentWork(body: Record<string, unknown>) {
  const workId = typeof body.workId === "string" ? body.workId : null;
  const newAgentName = typeof body.newAgentName === "string" ? body.newAgentName : null;
  const reason = typeof body.reason === "string" ? body.reason : "Reassigned by operator";

  if (!workId) {
    return errorResponse("Missing workId", 400);
  }
  if (!newAgentName) {
    return errorResponse("Missing newAgentName", 400);
  }

  try {
    const existing = await prisma.agentWork.findUnique({
      where: { id: workId },
      include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
    });

    if (!existing) {
      return errorResponse("Work item not found", 404);
    }

    // One instant for the whole handover: the old owner's lease expires now,
    // and the new owner's claim starts from the same instant.
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + AGENT_WORK_LEASE_DURATION_MS);

    const work = await prisma.$transaction(async (tx) => {
      // Release old agent's work
      await tx.agentWork.update({
        where: { id: workId },
        data: { state: "RELEASED", leaseExpiresAt: now },
      });
      await tx.agentWorkHistory.create({
        data: { workId, action: "reassigned", summary: `${reason} -> ${newAgentName}` },
      });

      // Release all existing active work for the new agent (single work per agent)
      const newAgentActive = await tx.agentWork.findMany({
        where: { agentName: newAgentName, state: { in: ["CLAIMED", "IN_PROGRESS"] } },
      });
      for (const active of newAgentActive) {
        await tx.agentWork.update({
          where: { id: active.id },
          data: { state: "RELEASED", leaseExpiresAt: now },
        });
        await tx.agentWorkHistory.create({
          data: { workId: active.id, action: "released_by_reassignment" },
        });
      }

      return tx.agentWork.update({
        where: { id: workId },
        // #1391: settle the marker the sweep's mark leaves when it parks a
        // row for its retry arm (`state: "STALE"`,
        // `staleClaimReleasePending: true`). Reassigning rewrites the row to
        // `CLAIMED` for the new owner, so carrying the marker over would
        // strand the owed release on a live-shaped row: the sweep's reclaim
        // arms require the marker cleared and its retry arm requires
        // `state: "STALE"`, which this write no longer satisfies — no
        // component could advance it. The operator's reassignment supersedes the sweep's
        // decision on the row, so the rewrite settles it here; the sweep
        // stays the single owner of retiring an owed release elsewhere.
        //
        // PR #1393 review: the rewrite must also leave the row with a LIVE
        // lease. The RELEASED write above stamps `leaseExpiresAt` with `now`,
        // so a rewrite that left the field alone would carry an expiry that
        // is already in the past into the `CLAIMED` shape — a shape no claim
        // path produces. The sweep's reclaim arm
        // (`src/lib/stale-work.ts:161`) fires on
        // `lastHeartbeatAt < cutoff OR leaseExpiresAt < cutoff`, so an expiry
        // that is not ahead of the heartbeat lets the EXPIRY arm fire at the
        // same instant as the heartbeat arm instead of strictly after it.
        // The handover is a fresh claim, so it carries the claim path's lease
        // horizon (`AGENT_WORK_LEASE_DURATION_MS`, the same value
        // `startAgentWork`/`checkpointAgentWork` stamp): the expiry stays
        // ahead of the heartbeat, the reclaim stays governed by the heartbeat
        // window — exactly like a row from `startAgentWork` — and the field
        // never shrinks under the new owner.
        data: {
          agentName: newAgentName,
          state: "CLAIMED",
          lastHeartbeatAt: now,
          leaseExpiresAt,
          staleClaimReleasePending: false,
        },
        include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
      });
    });

    await prisma.auditLog.create({
      data: {
        actor: "operator",
        action: "agent_work_reassigned",
        repoFullName: work.issue?.repository?.fullName ?? "",
        issueNumber: work.issue?.number,
        issueId: work.issueId,
        success: true,
        notes: `Reassigned work from ${existing.agentName} to ${newAgentName}: ${reason}`,
      },
    });

    return NextResponse.json({ success: true, work });
  } catch (error) {
    console.error("Failed to reassign agent work:", error);
    await prisma.auditLog.create({
      data: {
        actor: "operator",
        action: "agent_work_reassign_failed",
        repoFullName: "",
        success: false,
        errorMessage: String(error),
      },
    });
    return errorResponse("Failed to reassign agent work", 500);
  }
}
