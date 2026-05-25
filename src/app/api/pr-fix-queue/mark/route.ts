import { NextResponse } from "next/server";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { markPrFixItem, parseMarkPrFixInput } from "@/lib/pr-fix-queue";
import { isAuthorized } from "@/lib/auth";

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const input = parseMarkPrFixInput(body);
    if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });

    const item = await markPrFixItem(asPrFixQueueClient(prisma), input);
    if (!item) return NextResponse.json({ error: "PR fix queue item not found" }, { status: 404 });

    const actor = request.headers.get("x-agent-name") ?? "agent";
    await prisma.auditLog.create({
      data: {
        actor,
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
        actor: request.headers.get("x-agent-name") ?? "agent",
        action: "pr_fix_mark",
        repoFullName: "unknown",
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return NextResponse.json({ error: "Failed to mark PR fix queue item" }, { status: 500 });
  }
}
