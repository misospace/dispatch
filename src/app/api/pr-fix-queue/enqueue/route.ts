import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { enqueuePrFixItem, parseEnqueuePrFixInput } from "@/lib/pr-fix-queue";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }
  const auditActor = getAuthorizedActor(auth, request);

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    const input = parseEnqueuePrFixInput(body);
    if ("error" in input) return errorResponse(input.error, 400);

    const item = await enqueuePrFixItem(asPrFixQueueClient(prisma), input);
    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_enqueue",
        repoFullName: input.repo,
        issueNumber: input.issue ?? null,
        success: true,
        beforeLabels: [],
        afterLabels: [],
        notes: `pr=${input.pr} lane=${item.lane} reason=${input.reason}`,
      },
    });

    return NextResponse.json(item);
  } catch (error) {
    console.error("Failed to enqueue PR fix item:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_enqueue",
        repoFullName: "unknown",
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return errorResponse("Failed to enqueue PR fix item", 500);
  }
}
