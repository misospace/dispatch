// POST /api/issues/capacity-handoff (#1256)
//
// Worker-facing fenced recovery for explicit capacity exhaustion on a claimed
// issue. The caller presents the claim token Dispatch issued at claim time;
// the release is fenced to that exact claim and refuses human holds and
// changed ownership (see src/lib/issue-capacity-handoff.ts). On success the
// issue returns to circulation for other compatible workers and the exhausted
// capacity gets a bounded, capacity-SCOPED cooldown — unrelated capacities are
// never suppressed.
//
// #1262: an optional `settlementKey` makes success durable — the release is
// recorded and an identical retry (same key + original claim token) replays
// the recorded result with zero mutation, so a lost HTTP response can no
// longer make a completed settlement unprovable.
//
// Auth follows the claim/unclaim contract: bearer-authenticated; a bound
// worker credential may only hand off its own agent's claim; the unbound
// legacy worker token is refused (#1129).
import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { recoverIssueCapacityHandoff } from "@/lib/issue-capacity-handoff";
import { normalizeCapacity } from "@/lib/capacity-handoff";
import { normalizeSettlementKey, MAX_SETTLEMENT_KEY_LENGTH } from "@/lib/issue-handoff-settlement";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };
const MAX_NOTE_LENGTH = 500;
const MAX_TOKEN_LENGTH = 200;

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`capacity-handoff:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }
    if (typeof body !== "object" || body === null) {
      return errorResponse("Invalid JSON body", 400);
    }

    const {
      issueId,
      repoFullName,
      issueNumber,
      agentName,
      claimToken,
      capacity,
      settlementKey,
      note,
    } = body as Record<string, unknown>;

    if (
      typeof issueId !== "string" || issueId.trim() === "" ||
      typeof repoFullName !== "string" || repoFullName.trim() === "" ||
      typeof issueNumber !== "number" || !Number.isInteger(issueNumber) ||
      typeof agentName !== "string" || agentName.trim() === ""
    ) {
      return errorResponse("Missing required fields: issueId, repoFullName, issueNumber, agentName", 400);
    }
    if (typeof claimToken !== "string" || claimToken.trim() === "" || claimToken.length > MAX_TOKEN_LENGTH) {
      return errorResponse(`claimToken must be a non-empty string of at most ${MAX_TOKEN_LENGTH} characters (issued with the claim)`, 400);
    }
    // #1262: optional durable settlement key. When present, the successful
    // release is recorded and an identical retry replays the recorded result;
    // when absent (or null), behavior is exactly the pre-#1262 path. Opaque
    // caller data, persisted — never embed secrets.
    if (settlementKey != null && normalizeSettlementKey(settlementKey) === null) {
      return errorResponse(`settlementKey must be a non-empty string of at most ${MAX_SETTLEMENT_KEY_LENGTH} characters when provided`, 400);
    }
    // Explicit recognition of capacity exhaustion: a non-empty, bounded,
    // opaque capacity identifier. Silently exhausting nothing is not allowed.
    const normalizedCapacity = normalizeCapacity(capacity);
    if (normalizedCapacity === null) {
      return errorResponse("capacity must be a non-empty recognized capacity identifier of at most 200 characters", 400);
    }
    if (note !== undefined && (typeof note !== "string" || note.length > MAX_NOTE_LENGTH)) {
      return errorResponse(`note must be a string of at most ${MAX_NOTE_LENGTH} characters`, 400);
    }

    // A bound worker credential may only hand off its own agent's claim; an
    // unbound legacy worker token is refused here (#1129).
    const scopeError = await enforceWorkerAgentScope(auth, agentName);
    if (scopeError) return scopeError;

    const actor = getAuthorizedActor(auth, request, agentName);

    const result = await recoverIssueCapacityHandoff({
      client: prisma as any,
      issueId: issueId.trim(),
      repoFullName: repoFullName.trim(),
      issueNumber,
      agentName: agentName.trim(),
      claimToken: claimToken.trim(),
      capacity: normalizedCapacity,
      settlementKey: settlementKey == null ? null : normalizeSettlementKey(settlementKey),
      note: typeof note === "string" && note.trim() !== "" ? note.trim() : null,
      actor,
    });

    if (!result.ok) {
      return errorResponse(result.message, result.httpStatus);
    }

    return NextResponse.json({
      success: true,
      labels: result.labels,
      status: result.status,
      statusNote: result.statusNote,
      capacity: normalizedCapacity,
      // Fresh release: null only when the (post-release, best-effort) cooldown
      // write failed; the ownership release itself succeeded. Replay (#1262):
      // echoes the recorded original result, whose deadline may predate a
      // cooldown-write failure on the settling attempt.
      cooldownUntil: result.cooldownUntil ? result.cooldownUntil.toISOString() : null,
      // #1262: true when this response replays a durable settlement record
      // rather than performing a fresh release (zero mutation on replay).
      replayed: result.replayed,
    });
  } catch (error) {
    return handleApiError("capacity handoff", error);
  }
}
