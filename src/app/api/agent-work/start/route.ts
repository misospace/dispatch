import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { parseStartAgentWorkInput, startAgentWork } from "@/lib/agent-work";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isIssueExcludedByLabels } from "@/lib/issue-filters";
import { parseExcludedLabels } from "@/lib/config";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 } as const;

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
 * 400 Bad Request — the issue's cached labels match DISPATCH_EXCLUDED_LABELS (#1605)
 * { "error": "Issue labels match DISPATCH_EXCLUDED_LABELS; agent work cannot start on an excluded issue" }
 *
 * 401 Unauthorized — Invalid or missing bearer token
 * { "error": "Unauthorized" }
 *
 * 500 Internal Server Error
 * { "error": "Failed to start agent work" }
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`route:agent-work/start:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    const body = await request.json();
    const parsed = parseStartAgentWorkInput(body);
    if ("error" in parsed) {
      return errorResponse(parsed.error, 400);
    }

    // #1129: a bound worker credential may only start work for its own agent;
    // an unbound legacy worker token is refused here.
    const scopeError = await enforceWorkerAgentScope(auth, parsed.agentName);
    if (scopeError) return scopeError;

    // #1605: the excluded set is an operator visibility opt-out — the queue
    // never offers such an issue and the claim path refuses it by id (#1604).
    // Start is the last door: without this gate an AgentWork row still attaches
    // to an excluded issue and checkpoint/finish reports accumulate on it.
    // Same cached labels and same predicate as the claim gate and the sync
    // prune — no second definition of the excluded set. An issueId missing
    // from the cache has no cached labels to match, so start behaves as
    // before. With the set unset the gate costs no database read.
    const excludedLabels = parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS);
    if (parsed.issueId && excludedLabels.length > 0) {
      const issue = await prisma.issue.findUnique({
        where: { id: parsed.issueId },
        select: { labels: true },
      });
      if (issue && isIssueExcludedByLabels(issue.labels, excludedLabels)) {
        return errorResponse(
          "Issue labels match DISPATCH_EXCLUDED_LABELS; agent work cannot start on an excluded issue",
          400,
        );
      }
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
