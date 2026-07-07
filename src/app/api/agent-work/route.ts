import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { releaseStaleWork } from "@/lib/agent-work";
import { releaseLeaseByAgentAndIssue, releaseAllLeasesByAgent, releaseAgentWorkByAgentAndIssue } from "@/lib/lease";

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

// Intentionally unauthenticated — consistent with other read-only endpoints
// such as GET /api/agents/[agentName]/active-work and GET /api/issues.
// The board UI and operator dashboards need to query active/stale work without
// requiring a DISPATCH_AGENT_TOKEN. POST mutations remain auth-gated below.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const stateFilter = searchParams.get("state");
  const agentNameFilter = searchParams.get("agent");
  const includeStale = searchParams.get("include_stale") !== "false";

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

    if (agentNameFilter) {
      where.agentName = agentNameFilter;
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

    const items: AgentWorkItem[] = activeItems.map((w: any) => ({
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
    }));

    if (includeStale) {
      // Stale-work sweep: marks CLAIMED/IN_PROGRESS work as STALE when heartbeat
      // or lease TTL has expired. Idempotent — once marked STALE, work no longer
      // matches the WHERE clause, so repeated calls are safe. Also creates history
      // entries for audit trail. Returns affected IDs so we can re-query.
      const potentiallyStale = await releaseStaleWork(prisma, 5 * 60 * 1000);
      if (potentiallyStale.length > 0) {
        const refreshedWhere: Record<string, unknown> = {
          OR: [
            { state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
            { state: "STALE" },
          ],
        };
        if (agentNameFilter) refreshedWhere.agentName = agentNameFilter;

        const refreshed = await prisma.agentWork.findMany({
          where: refreshedWhere,
          orderBy: { lastHeartbeatAt: "desc" },
          include: {
            issue: {
              select: { number: true, title: true, repository: { select: { fullName: true } } },
            },
          },
        });

        items.length = 0;
        for (const w of refreshed) {
          items.push({
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
          });
        }
      }
    }

    const now = new Date();
    const expiredLeases = await prisma.lease.findMany({
      where: { expiredAt: { lte: now } },
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
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const action = body.action as string;

    if (action === "release") {
      return await releaseAgentWork(body);
    } else if (action === "reassign") {
      return await reassignAgentWork(body);
    } else {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Failed to process agent work action:", error);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}

async function releaseAgentWork(body: Record<string, unknown>) {
  const workId = typeof body.workId === "string" ? body.workId : null;
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : null;
  const agentName = typeof body.agentName === "string" ? body.agentName : null;
  const issueId = typeof body.issueId === "string" ? body.issueId : null;
  const releaseAll = body.releaseAll === true;
  const reason = typeof body.reason === "string" ? body.reason : "Released by operator";

  // Original release path by workId or leaseId (backward compatible)
  if (workId || leaseId) {
    if (!workId && !leaseId) {
      return NextResponse.json({ error: "Missing workId or leaseId" }, { status: 400 });
    }

    try {
      let work = null;

      if (workId) {
        const existing = await prisma.agentWork.findUnique({ where: { id: workId } });
        if (!existing) {
          return NextResponse.json({ error: "Work item not found" }, { status: 404 });
        }
        if (existing.state === "DONE" || existing.state === "RELEASED") {
          return NextResponse.json({ error: "Work is already completed or released" }, { status: 400 });
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
          return NextResponse.json({ error: "Lease not found" }, { status: 404 });
        }

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
      return NextResponse.json({ error: "Failed to release agent work" }, { status: 500 });
    }
  }

  // New release path by agentName + issueId (operator recovery for orphaned work)
  if (!agentName) {
    return NextResponse.json({ error: "Missing workId, leaseId, or agentName" }, { status: 400 });
  }

  try {
    let releasedLeases = 0;
    let releasedWork = 0;
    let repoFullName = "";
    let issueNumber: number | null = null;

    if (issueId) {
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
      return NextResponse.json({ error: "Missing required field: issueId, or set releaseAll: true" }, { status: 400 });
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
    return NextResponse.json({ error: "Failed to release agent work" }, { status: 500 });
  }
}

async function reassignAgentWork(body: Record<string, unknown>) {
  const workId = typeof body.workId === "string" ? body.workId : null;
  const newAgentName = typeof body.newAgentName === "string" ? body.newAgentName : null;
  const reason = typeof body.reason === "string" ? body.reason : "Reassigned by operator";

  if (!workId) {
    return NextResponse.json({ error: "Missing workId" }, { status: 400 });
  }
  if (!newAgentName) {
    return NextResponse.json({ error: "Missing newAgentName" }, { status: 400 });
  }

  try {
    const existing = await prisma.agentWork.findUnique({
      where: { id: workId },
      include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
    });

    if (!existing) {
      return NextResponse.json({ error: "Work item not found" }, { status: 404 });
    }

    const work = await prisma.$transaction(async (tx) => {
      // Release old agent's work
      await tx.agentWork.update({
        where: { id: workId },
        data: { state: "RELEASED", leaseExpiresAt: new Date() },
      });
      await tx.agentWorkHistory.create({
        data: { workId, action: "reassigned", summary: `${reason} -> ${newAgentName}` },
      });

      // Release any existing active work for the new agent on the same issue
      if (existing.issueId) {
        const newAgentExisting = await tx.agentWork.findFirst({
          where: { agentName: newAgentName, issueId: existing.issueId, state: { in: ["CLAIMED", "IN_PROGRESS"] } },
        });
        if (newAgentExisting) {
          await tx.agentWork.update({
            where: { id: newAgentExisting.id },
            data: { state: "RELEASED", leaseExpiresAt: new Date() },
          });
          await tx.agentWorkHistory.create({
            data: { workId: newAgentExisting.id, action: "released_by_reassignment" },
          });
        }
      }

      // Release any other active work for the new agent
      const otherActive = await tx.agentWork.findFirst({
        where: { agentName: newAgentName, state: { in: ["CLAIMED", "IN_PROGRESS"] } },
      });
      if (otherActive) {
        await tx.agentWork.update({
          where: { id: otherActive.id },
          data: { state: "RELEASED", leaseExpiresAt: new Date() },
        });
        await tx.agentWorkHistory.create({
          data: { workId: otherActive.id, action: "released_by_reassignment" },
        });
      }

      return tx.agentWork.update({
        where: { id: workId },
        data: { agentName: newAgentName, state: "CLAIMED", lastHeartbeatAt: new Date() },
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
    return NextResponse.json({ error: "Failed to reassign agent work" }, { status: 500 });
  }
}
