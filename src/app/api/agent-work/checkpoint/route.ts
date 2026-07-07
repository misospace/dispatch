import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { parseCheckpointAgentWorkInput, checkpointAgentWork } from "@/lib/agent-work";

/**
 * POST /api/agent-work/checkpoint
 *
 * Advance the checkpoint of an agent's active work. Workers call this as a
 * heartbeat to extend their 5-minute lease and record progress milestones.
 *
 * ─── Request Schema ───────────────────────────────────────────────────────
 * Content-Type: application/json
 * Authorization: Bearer <DISPATCH_AGENT_TOKEN>
 *
 * {
 *   "agentName": "saffron",          // string, required — worker identifier
 *   "checkpoint": "CHANGES_MADE",    // string, required — one of:
 *                                    //   CLAIMED | REPO_PREPARED | BRANCH_CREATED
 *                                    //   CHANGES_MADE | TESTS_RUNNING | PR_OPENED
 *                                    //   DONE | BLOCKED
 *   "summary": "...",                // string, optional — progress description
 *   "blockerReason": "..."           // string, optional — required when checkpoint is BLOCKED
 * }
 *
 * ─── Response Schema ──────────────────────────────────────────────────────
 * 200 OK — Work checkpointed successfully
 * {
 *   "id": "w-abc123",
 *   "agentName": "saffron",
 *   "state": "IN_PROGRESS",          // transitions to IN_PROGRESS on first non-CLAIMED checkpoint
 *                                    // transitions to BLOCKED when checkpoint is BLOCKED
 *                                    // transitions to DONE when checkpoint is DONE
 *   "checkpoint": "CHANGES_MADE",
 *   "lastHeartbeatAt": "2026-05-27T...",
 *   "leaseExpiresAt": "2026-05-27T...",
 *   ...
 * }
 *
 * 400 Bad Request — Validation error
 * { "error": "Missing required field: checkpoint (one of: CLAIMED, REPO_PREPARED, ...)" }
 *
 * 401 Unauthorized — Invalid or missing bearer token
 * { "error": "Unauthorized" }
 *
 * 404 Not Found — No active work for this agent
 * { "error": "No active work found for agent" }
 *   (or { "releasedOrphan": true, "message": "Orphaned lease released — no active work to checkpoint" })
 *
 * 500 Internal Server Error
 * { "error": "Failed to checkpoint agent work" }
 */
export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    const body = await request.json();
    const parsed = parseCheckpointAgentWorkInput(body);
    if ("error" in parsed) {
      return errorResponse(parsed.error, 400);
    }

    const work = await checkpointAgentWork(asAgentWorkClient(prisma), parsed);
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
            action: "orphan_lease_released_during_checkpoint",
            repoFullName: "",
            issueId: lease.issueId ?? undefined,
            success: true,
            notes: `Released orphaned lease during checkpoint for agent ${parsed.agentName}: referenced issue not found`,
          },
        });
        return NextResponse.json({ releasedOrphan: true, message: "Orphaned lease released — no active work to checkpoint" });
      }

      return errorResponse("No active work found for agent", 404);
    }

    await prisma.auditLog.create({
      data: {
        actor: parsed.agentName,
        action: "agent_work_checkpoint",
        repoFullName: "",
        issueNumber: undefined,
        issueId: work.issueId ?? undefined,
        success: true,
        notes: `Agent ${parsed.agentName} checkpointed (${parsed.checkpoint}): ${parsed.summary ?? parsed.blockerReason ?? "-"}`,
      },
    });

    return NextResponse.json(work);
  } catch (error) {
    return handleApiError("checkpoint agent work", error);
  }
}
