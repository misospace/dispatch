import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildAgentQueue } from "@/lib/agent-queue";
import { listQueuedPrFixItems, toAgentQueuePrFixItem } from "@/lib/pr-fix-queue";

export async function GET(request: Request, { params }: { params: Promise<{ agentName: string }> }) {
  const { agentName } = await params;
  const { searchParams } = new URL(request.url);
  const lane = searchParams.get("lane");
  const excludeDecomposed = searchParams.get("exclude_decomposed");

  try {
    // Fetch all open issues from enabled repos, using GitHub Issues as source of truth
    const issues = await prisma.issue.findMany({
      where: {
        state: "open",
        repository: { enabled: true },
      },
      select: {
        number: true,
        title: true,
        url: true,
        labels: true,
        currentLane: true,
        decomposed: true,
      },
    });

    const issueLane = lane === "gpt" ? "escalated" : (lane?.toLowerCase() as "normal" | "escalated" | "backlog" | undefined);
    const prFixLane = lane === "gpt" ? "ESCALATED" : lane;

    const prFixItems = await listQueuedPrFixItems(prisma, { lane: prFixLane });
    const queue = buildAgentQueue(
      issues.map((issue) => ({ ...issue, lane: issue.currentLane ?? undefined })),
      agentName,
      {
        lane: issueLane,
        excludeDecomposed: excludeDecomposed === "true",
      },
    );

    return NextResponse.json([...prFixItems.map(toAgentQueuePrFixItem), ...queue]);
  } catch (error) {
    console.error("Failed to fetch agent queue:", error);
    return NextResponse.json({ error: "Failed to fetch agent queue" }, { status: 500 });
  }
}
