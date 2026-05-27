import { NextResponse } from "next/server";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { parseFinishAgentWorkInput, finishAgentWork } from "@/lib/agent-work";

/**
 * POST /api/agent-work/finish
 *
 * Mark an agent's active work as complete or blocked. This sets the final state,
 * expires the lease, and writes a history record. After calling this, the agent
 * should call POST /api/agent-work/start to claim new work.
 *
 * ─── Request Schema ───────────────────────────────────────────────────────
 * Content-Type: application/json
 * Authorization: Bearer <DISPATCH_AGENT_TOKEN>
 *
 * {
 *   "agentName": "saffron",    // string, required — worker identifier
 *   "state": "DONE",           // string, required — one of:
 *                              //   CLAIMED | IN_PROGRESS | BLOCKED | DONE | RELEASED | STALE
 *   "summary": "..."           // string, optional — final summary of work or block reason
 * }
 *
 * ─── Response Schema ──────────────────────────────────────────────────────
 * 200 OK — Work finished successfully
 * {
 *   "id": "w-abc123",
 *   "agentName": "saffron",
 *   "state": "DONE",           // final state set by the request
 *   "checkpoint": "DONE",      // automatically set when state is DONE
 *   "summary": "...",
 *   "leaseExpiresAt": "2026-05-27T..."  // now (lease expired)
 * }
 *
 * 400 Bad Request — Validation error
 * { "error": "Missing required field: state (one of: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE)" }
 *
 * 401 Unauthorized — Invalid or missing bearer token
 * { "error": "Unauthorized" }
 *
 * 404 Not Found — No active work for this agent
 * { "error": "No active work found for agent" }
 *   (or { "releasedOrphan": true, "message": "Orphaned lease released — no active work to finish" })
 *
 * 500 Internal Server Error
 * { "error": "Failed to finish agent work" }
 */
export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = parseFinishAgentWorkInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const work = await finishAgentWork(asAgentWorkClient(prisma), parsed);
    if (!work) {
      // No active work found — check if there's an orphaned lease to clean up
      const now = new Date();
      const lease = await prisma.lease.findFirst({
        where: { agentName: parsed.agentName, expiredAt: { gt: now } },
        include: { issue: true },
      });

      if (lease && (!lease.issueId || !(await prisma.issue.findUnique({ where: { id: lease.issueId } })))) {
        // Orphaned lease detected — release it so the agent can pick up new work
        await prisma.lease.delete({ where: { id: lease.id } });
        await prisma.auditLog.create({
          data: {
            actor: parsed.agentName,
            action: "orphan_lease_released_during_finish",
            repoFullName: "",
            issueId: lease.issueId ?? undefined,
            success: true,
            notes: `Released orphaned lease during finish for agent ${parsed.agentName}: referenced issue not found`,
          },
        });
        return NextResponse.json({ releasedOrphan: true, message: "Orphaned lease released — no active work to finish" });
      }

      return NextResponse.json({ error: "No active work found for agent" }, { status: 404 });
    }

    await prisma.auditLog.create({
      data: {
        actor: parsed.agentName,
        action: "agent_work_finished",
        repoFullName: "",
        issueNumber: undefined,
        issueId: work.issueId ?? undefined,
        success: true,
        notes: `Agent ${parsed.agentName} finished work (${parsed.state}): ${parsed.summary ?? "-"}`,
      },
    });

    return NextResponse.json(work);
  } catch (error) {
    console.error("Failed to finish agent work:", error);
    return NextResponse.json({ error: "Failed to finish agent work" }, { status: 500 });
  }
}
