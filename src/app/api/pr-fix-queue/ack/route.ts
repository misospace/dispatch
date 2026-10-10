import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { ackPrFixHandout, parseAckPrFixHandoutInput } from "@/lib/pr-fix-queue";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 } as const;

/**
 * Acknowledge a PR-fix hand-out (#1211). A worker calls this after it has
 * durably materialized its attempt (created the run that owns the work) so the
 * stale hand-out reclaimer knows the stamped generation was not lost. The write
 * is generation-pinned and idempotent: a repeat ack is a 200, not an error.
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`pr-fix-ack:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const input = parseAckPrFixHandoutInput(body);
  if ("error" in input) return errorResponse(input.error, 400);

  try {
    const result = await ackPrFixHandout(asPrFixQueueClient(prisma), input);
    if (result.acknowledged) {
      return NextResponse.json({ acknowledged: true, item: result.item });
    }
    switch (result.reason) {
      case "already-acknowledged":
        // Idempotent: a retry after a lost response must not error.
        return NextResponse.json({ acknowledged: true, alreadyAcknowledged: true });
      case "not-found":
        return errorResponse("pr-fix item not found", 404);
      case "generation-mismatch":
        return NextResponse.json(
          { error: "PR fix queue item generation mismatch", reason: result.reason },
          { status: 409 },
        );
      case "not-queued":
        return NextResponse.json(
          { error: "PR fix queue item is not QUEUED", reason: result.reason },
          { status: 409 },
        );
    }
  } catch (error) {
    console.error("Failed to acknowledge pr-fix hand-out:", error);
    return errorResponse("Failed to acknowledge pr-fix hand-out", 500);
  }
}
