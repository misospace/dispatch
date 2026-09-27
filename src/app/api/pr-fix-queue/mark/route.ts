import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { markPrFixItem, parseMarkPrFixInput } from "@/lib/pr-fix-queue";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`pr-fix-mark:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  const auditActor = getAuthorizedActor(auth, request);

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    const input = parseMarkPrFixInput(body);
    if ("error" in input) return errorResponse(input.error, 400);

    // #1074: bearer (agent/bridge) marks must settle a specific attempt, so
    // the generation token is required. Operator paths (oidc session, basic,
    // disabled) keep the optional behavior for compatibility.
    if (auth.type === "bearer" && input.expectedGeneration === undefined) {
      return errorResponse("generation is required for agent/bridge marks (#1074)", 400);
    }

    const result = await markPrFixItem(asPrFixQueueClient(prisma), input);
    if (!result.mutated) {
      if (result.reason === "generation-mismatch") {
        // The item moved to a newer attempt between the caller's read and
        // this write. Conflict, not an error: no mutation happened.
        return errorResponse(
          `PR fix queue item generation mismatch: expected generation ${input.expectedGeneration} did not match the item's current generation`,
          409,
        );
      }
      return errorResponse("PR fix queue item not found", 404);
    }
    const item = result.item;

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_mark",
        repoFullName: input.repo,
        issueNumber: null,
        success: true,
        beforeLabels: [],
        afterLabels: [],
        notes: `pr=${input.pr} status=${item.status}${input.note ? ` note=${input.note}` : ""}`,
      },
    });

    return NextResponse.json(item);
  } catch (error) {
    console.error("Failed to mark PR fix queue item:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_mark",
        repoFullName: "unknown",
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return errorResponse("Failed to mark PR fix queue item", 500);
  }
}
