// POST /api/pr-fix-queue/attempt-requeue (#1491)
//
// Fenced, idempotent reactivation of exactly ONE queue-backed attempt, pinned
// cross-repo by Courier's retry transport (misospace/courier#608). It is NOT
// the operator reset at `POST /api/pr-fix-queue/requeue` (which stays exactly
// as it is: unfenced, maintainer-only, budget-resetting). This route fences
// on the hand-out receipt ISSUED for the named generation — validated
// against the durable issuance history, because the terminal report already
// released the live receipt — and a committed idempotency key replays the
// original result with zero further mutation.
//
// Refusals are the pinned coded-409 vocabulary `{reason: stale-generation |
// superseded | item-closed | human-hold}`; 404 is RESERVED for route absence
// (an unadopted deployment latches Courier's version-skew posture on it, so
// a per-item condition must never answer 404).
//
// Auth follows the CI-park family: MAINTAINER tier (absent from
// `WORKER_ALLOWLIST`) plus the bearer-only gate; the maintainer bearer is the
// connector's credential, and the agent it names is bound by the issued
// receipt the transition validates.
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { attemptRequeuePrFixItem, parseAttemptRequeueInput } from "@/lib/issue-requeue";
import { normalizeQueueRepo } from "@/lib/pr-fix-queue";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  // Bearer only (or `disabled`, the tokenless dev mode) — same posture as
  // the CI-park family the connector already calls with.
  if (auth.type !== "bearer" && auth.type !== "disabled") {
    return errorResponse(
      "Forbidden: pr-fix attempt requeue requires a bearer token (DISPATCH_AGENT_TOKEN or DISPATCH_MAINTAINER_TOKEN); basic / OIDC sessions cannot requeue on behalf of an agent",
      403,
    );
  }

  const limited = enforceRateLimit(`pr-fix-attempt-requeue:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const input = parseAttemptRequeueInput(body);
  if ("error" in input) return errorResponse(input.error, 400);

  // The audit actor falls back to the agent the requeue acts FOR (see the
  // CI-park route for the full rationale). The requested agent is
  // authorized by the FENCE, not by identity: the transition validates the
  // presented receipt against the issuance recorded for exactly this
  // (item, agent, generation), and an agent with no such issuance is
  // refused `stale-generation`.
  const auditActor = getAuthorizedActor(auth, request, input.agentName);

  const scopeError = await enforceWorkerAgentScope(auth, input.agentName);
  if (scopeError) return scopeError;

  try {
    const result = await attemptRequeuePrFixItem(asPrFixQueueClient(prisma), input);
    if (result.ok) {
      // Audit is best-effort: a failing audit row must never mask (or undo)
      // the committed requeue — same rule the issue-requeue route follows.
      try {
        await prisma.auditLog.create({
          data: {
            actor: auditActor,
            action: "pr_fix_attempt_requeue",
            repoFullName: normalizeQueueRepo(input.repo),
            issueNumber: null,
            success: true,
            beforeLabels: [],
            afterLabels: [],
            notes:
              `pr=${input.pr} generation=${input.generation}->${result.generation} ` +
              `${result.replayed ? "replayed" : "committed"} agent=${input.agentName}` +
              (input.note ? ` note=${input.note}` : ""),
          },
        });
      } catch (auditError) {
        console.error("pr_fix_attempt_requeue success audit failed:", auditError);
      }
      // The pinned success shape. `prFixItem` always carries the SAME item id
      // the request pivoted on and the FRESH generation the requeue issued —
      // Courier derives the successor attempt identity from it and refuses a
      // response that reissues a different item.
      return NextResponse.json({
        success: true,
        replayed: result.replayed,
        prFixItem: { id: result.itemId, generation: result.generation },
      });
    }
    if ("keyConflict" in result) {
      // The `AgentReportDedupe` refusal: a committed key never rewrites its
      // original payload. Uncoded 409 — Courier keeps it transient.
      return errorResponse("idempotencyKey already used for a different pr-fix attempt-requeue payload", 409);
    }
    if ("unavailable" in result) {
      // Covers ledger-read failure and a lost write race with an unchanged
      // row: both are transient, no settlement committed, retry is safe.
      return errorResponse("Attempt-requeue did not settle (ledger unavailable or a concurrent change landed); retry shortly", 503);
    }
    // A refusal is an audit event for the coordinator's lifecycle observer;
    // it never settles anything and never touches the current owner. Best
    // effort: a failing audit row must not mask the pinned refusal code.
    try {
      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: "pr_fix_attempt_requeue",
          repoFullName: normalizeQueueRepo(input.repo),
          issueNumber: null,
          success: false,
          errorMessage: `refused: ${result.refusal}`,
          beforeLabels: [],
          afterLabels: [],
          notes: `pr=${input.pr} generation=${input.generation} code=${result.refusal} agent=${input.agentName}`,
        },
      });
    } catch (auditError) {
      console.error("pr_fix_attempt_requeue refusal audit failed:", auditError);
    }
    return NextResponse.json({ reason: result.refusal }, { status: 409 });
  } catch (error) {
    console.error("Failed to requeue PR fix queue attempt:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    try {
      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: "pr_fix_attempt_requeue",
          repoFullName: normalizeQueueRepo(input.repo),
          success: false,
          errorMessage,
          beforeLabels: [],
          afterLabels: [],
        },
      });
    } catch {
      // Audit failure must not mask the error.
    }
    return errorResponse("Failed to requeue PR fix queue attempt", 500);
  }
}
