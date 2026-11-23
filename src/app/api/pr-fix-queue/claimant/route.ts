import { NextResponse } from "next/server";
import { errorResponse, readJsonObjectBody } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { setPrFixClaimant, clearPrFixClaimant, transferPrFixClaimant, normalizeQueueRepo } from "@/lib/pr-fix-queue";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/** Identity-string ceiling for a stamped claimant (an agent name or GitHub login). */
const MAX_CLAIMANT_LENGTH = 200;

/**
 * PostgreSQL `text` cannot store NUL, and control characters have no place in
 * a repo slug or an identity string; reject them as 400 input validation
 * instead of letting them surface as a database 500.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Operator recovery for #1569: explicitly stamp the ORIGINAL CLAIMANT of a
 * PR-fix queue row (the agent/owner identity that owned the work when the row
 * was ingested). Distinct from `author` (the PR author login) and from
 * `agentHandouts` (per-generation receiving consumers): a fresh hand-out
 * recipient never becomes the claimant. This route is the operator escape
 * hatch for an unresolved (`missing`/`ambiguous`/legacy-NULL) claimant — the
 * helper pins `claimantSource` to "operator" and records a PrFixHistory
 * "mark" row; the value itself is stored verbatim after trim, with NO prefix
 * inference and no special-casing.
 *
 * Auth: maintainer tier only. `/api/pr-fix-queue/claimant` is deliberately
 * absent from `WORKER_ALLOWLIST` (src/lib/auth.ts), so `requiredTierForRoute`
 * defaults it to "maintainer" and `authorizeRequest` refuses a worker-tier
 * bearer with a 403 before any body read — the standard authorized check
 * below is the complete tier enforcement for this route.
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`route:pr-fix-queue/claimant:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  const parsed = await readJsonObjectBody(request, { rejectArrays: true });
  if ("error" in parsed) return parsed.error;
  const body = parsed.body;

  if (typeof body.repo !== "string" || !body.repo.trim()) {
    return errorResponse("Missing required field: repo", 400);
  }
  if (CONTROL_CHARS.test(body.repo)) {
    return errorResponse("repo must not contain control characters", 400);
  }
  const repo = normalizeQueueRepo(body.repo);
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    return errorResponse("repo must be in owner/name form", 400);
  }

  const pr = typeof body.pr === "string" ? Number(body.pr) : body.pr;
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) {
    return errorResponse("pr must be an integer >= 1", 400);
  }

  const action = body.action === undefined ? "stamp" : body.action;
  if (action !== "stamp" && action !== "clear" && action !== "transfer") {
    return errorResponse('action must be "stamp", "clear", or "transfer"', 400);
  }
  if (action === "clear" && body.claimant !== undefined) {
    return errorResponse('claimant must be omitted when action is "clear"', 400);
  }

  let claimant: string | undefined;
  if (action !== "clear") {
    if (typeof body.claimant !== "string" || !body.claimant.trim()) {
      return errorResponse("Missing required field: claimant", 400);
    }
    if (CONTROL_CHARS.test(body.claimant)) {
      return errorResponse("claimant must not contain control characters", 400);
    }
    claimant = body.claimant.trim();
    if (claimant.length > MAX_CLAIMANT_LENGTH) {
      return errorResponse(`claimant must be at most ${MAX_CLAIMANT_LENGTH} characters`, 400);
    }
  }

  try {
    const client = asPrFixQueueClient(prisma);
    if (action === "clear") {
      const result = await clearPrFixClaimant(client, { repo, pr });
      if (!result.updated) {
        return result.reason === "contended"
          ? errorResponse("pr-fix claimant update contended, retry", 503)
          : errorResponse("pr-fix item not found", 404);
      }
      return NextResponse.json({ ok: true, action: "clear", repo, pr, previousClaimant: result.previousClaimant, previousSource: result.previousSource });
    }
    if (action === "transfer") {
      const result = await transferPrFixClaimant(client, { repo, pr, claimant: claimant! });
      if (!result.updated) {
        return result.reason === "contended"
          ? errorResponse("pr-fix claimant update contended, retry", 503)
          : errorResponse("pr-fix item not found", 404);
      }
      return NextResponse.json({ ok: true, action: "transfer", repo, pr, claimant, previousClaimant: result.previousClaimant, previousSource: result.previousSource });
    }
    // #1569 stamp semantics remain unchanged: only NULL can be stamped.
    const result = await setPrFixClaimant(client, { repo, pr, claimant: claimant! });
    if (!result.updated) {
      if (result.reason === "already_set") {
        return errorResponse(
          "pr-fix item already has a recorded claimant; an operator stamp never transfers it (#1569)",
          409,
        );
      }
      return errorResponse("pr-fix item not found", 404);
    }
    return NextResponse.json({ ok: true, updated: true, repo, pr, claimant });
  } catch (error) {
    console.error("Failed to update pr-fix claimant:", error);
    return errorResponse(action === "stamp" ? "Failed to stamp pr-fix claimant" : "Failed to update pr-fix claimant", 500);
  }
}
