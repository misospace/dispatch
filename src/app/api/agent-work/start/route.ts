import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { parseStartAgentWorkInput, startAgentWork } from "@/lib/agent-work";

/**
 * POST /api/agent-work/start
 *
 * Claim new work for an agent. This releases any existing active work for the
 * same agent before creating a new record with state="CLAIMED".
 *
 * ─── Request Schema ───────────────────────────────────────────────────────
 * Content-Type: application/json
 * Authorization: Bearer <DISPATCH_AGENT_TOKEN>
 *
 * {
 *   "agentName": "saffron",    // string, required — worker identifier
 *   "issueId": "gh_123",       // string, optional — GitHub issue ID
 *   "runId": "run-456",        // string, optional — agent run identifier
 *   "branch": "fix/456"        // string, optional — git branch name
 * }
 *
 * ─── Response Schema ──────────────────────────────────────────────────────
 * 201 Created — Work claimed successfully
 * {
 *   "id": "w-abc123",
 *   "agentName": "saffron",
 *   "issueId": "gh_123",
 *   "state": "CLAIMED",
 *   "checkpoint": "CLAIMED",
 *   "branch": "fix/456",
 *   "leaseExpiresAt": "2026-05-27T...",  // 5 minutes from now
 *   "lastHeartbeatAt": "2026-05-27T..."
 * }
 *
 * 400 Bad Request — Validation error
 * { "error": "Missing required field: agentName (string)" }
 *
 * 401 Unauthorized — Invalid or missing bearer token
 * { "error": "Unauthorized" }
 *
 * 500 Internal Server Error
 * { "error": "Failed to start agent work" }
 */
export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    const body = await request.json();
    const parsed = parseStartAgentWorkInput(body);
    if ("error" in parsed) {
      return errorResponse(parsed.error, 400);
    }

    const work = await startAgentWork(asAgentWorkClient(prisma), parsed);

    await prisma.auditLog.create({
      data: {
        actor: parsed.agentName,
        action: "agent_work_started",
        repoFullName: "",
        issueNumber: undefined,
        issueId: parsed.issueId ?? undefined,
        success: true,
        notes: `Agent ${parsed.agentName} started work on issue ${parsed.issueId ?? "unassigned"}`,
      },
    });

    return NextResponse.json(work, { status: 201 });
  } catch (error) {
    return handleApiError("start agent work", error);
  }
}
