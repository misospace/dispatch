import { NextResponse } from "next/server";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { listQueuedPrFixItems } from "@/lib/pr-fix-queue";
import { VALID_LANES } from "@/types";

type WorkSummaryLaneCounts = { queued: number; inProgress: number };
type PrFixLaneCounts = { total: number; blocked: number };

interface WorkSummaryResponse {
  agentName: string;
  issues: Record<string, WorkSummaryLaneCounts>;
  prFixes: Record<string, PrFixLaneCounts>;
}

function classifyIssueStatus(labels: string[]): "queued" | "inProgress" {
  const inReview = labels.includes("status/in-review");
  const inProgress = labels.includes("status/in-progress");
  const ready = labels.includes("status/ready");

  if (inProgress || inReview) return "inProgress";
  return "queued";
}

export async function GET(request: Request, { params }: { params: Promise<{ agentName: string }> }) {
  const { agentName } = await params;

  try {
    const issues = await prisma.issue.findMany({
      where: {
        state: "open",
        repository: { enabled: true },
      },
      select: {
        labels: true,
        currentLane: true,
      },
    });

    const laneCounts: Record<string, WorkSummaryLaneCounts> = {};
    for (const lane of VALID_LANES) {
      laneCounts[lane] = { queued: 0, inProgress: 0 };
    }

    for (const issue of issues) {
      const lane = (issue.currentLane ?? "normal").toLowerCase();
      if (!laneCounts[lane]) continue;

      const status = classifyIssueStatus(issue.labels);
      if (status === "queued") {
        laneCounts[lane].queued++;
      } else if (status === "inProgress") {
        laneCounts[lane].inProgress++;
      }
    }

    const prFixItems = await listQueuedPrFixItems(asPrFixQueueClient(prisma), { includeBlocked: true });

    const prFixLaneKeys: Record<string, string> = { NORMAL: "normal", ESCALATED: "escalated", NEEDS_HUMAN: "needsHuman" };
    const prFixCounts: Record<string, PrFixLaneCounts> = {};
    for (const key of Object.values(prFixLaneKeys)) {
      prFixCounts[key] = { total: 0, blocked: 0 };
    }

    for (const item of prFixItems) {
      const rawLane = (item.lane ?? "NORMAL") as string;
      const laneKey = prFixLaneKeys[rawLane] ?? "normal";
      if (!prFixCounts[laneKey]) continue;

      prFixCounts[laneKey].total++;
      if (item.status === "BLOCKED") {
        prFixCounts[laneKey].blocked++;
      }
    }

    const response: WorkSummaryResponse = {
      agentName,
      issues: laneCounts,
      prFixes: prFixCounts,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to fetch work summary:", error);
    return NextResponse.json({ error: "Failed to fetch work summary" }, { status: 500 });
  }
}
