import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { listQueuedPrFixItems } from "@/lib/pr-fix-queue";
import { getConfiguredLanes, getDefaultClaimableLane, resolveLaneId } from "@/lib/lane-config";
import { applyRenovateIssueExclusion } from "@/lib/issue-filters";

type WorkSummaryLaneCounts = { queued: number; inProgress: number };
type PrFixLaneCounts = { total: number; blocked: number };

interface WorkSummaryResponse {
  agentName: string;
  issues: Record<string, WorkSummaryLaneCounts>;
  /** Issues in lanes that are not currently configured (stale/unknown lane IDs). */
  unknownLanes?: Record<string, WorkSummaryLaneCounts>;
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

  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const issueWhere: Record<string, unknown> = {
      state: "open",
      repository: { enabled: true },
    };
    applyRenovateIssueExclusion(issueWhere);

    const issues = await prisma.issue.findMany({
      where: issueWhere,
      select: {
        labels: true,
        currentLane: true,
      },
    });

    const configuredLanes = getConfiguredLanes();
    const laneCounts: Record<string, WorkSummaryLaneCounts> = {};
    for (const lane of configuredLanes) {
      laneCounts[lane.id] = { queued: 0, inProgress: 0 };
    }

    // Track unknown/unconfigured lanes separately so they're not silently dropped
    const unknownLaneCounts: Record<string, WorkSummaryLaneCounts> = {};

    for (const issue of issues) {
      const defaultLane = getDefaultClaimableLane()?.id ?? "default";
      const rawLane = (issue.currentLane ?? defaultLane).toLowerCase();
      const resolved = resolveLaneId(rawLane);
      if (!resolved) continue;

      // If the resolved lane isn't a configured lane, it's unknown
      if (!laneCounts[resolved]) {
        if (!unknownLaneCounts[resolved]) {
          unknownLaneCounts[resolved] = { queued: 0, inProgress: 0 };
        }
        const status = classifyIssueStatus(issue.labels);
        if (status === "queued") {
          unknownLaneCounts[resolved].queued++;
        } else if (status === "inProgress") {
          unknownLaneCounts[resolved].inProgress++;
        }
        continue;
      }

      const status = classifyIssueStatus(issue.labels);
      if (status === "queued") {
        laneCounts[resolved].queued++;
      } else if (status === "inProgress") {
        laneCounts[resolved].inProgress++;
      }
    }

    const prFixItems = await listQueuedPrFixItems(asPrFixQueueClient(prisma), { includeBlocked: true });

    const prFixLaneKeys: Record<string, string> = { NORMAL: "local", ESCALATED: "frontier", NEEDS_HUMAN: "needsHuman" };
    const prFixCounts: Record<string, PrFixLaneCounts> = {};
    for (const key of Object.values(prFixLaneKeys)) {
      prFixCounts[key] = { total: 0, blocked: 0 };
    }

    for (const item of prFixItems) {
      const rawLane = (item.lane ?? "NORMAL") as string;
      const laneKey = prFixLaneKeys[rawLane] ?? "default";
      if (!prFixCounts[laneKey]) continue;

      prFixCounts[laneKey].total++;
      if (item.status === "BLOCKED") {
        prFixCounts[laneKey].blocked++;
      }
    }

    const response: WorkSummaryResponse = {
      agentName,
      issues: laneCounts,
      ...(Object.keys(unknownLaneCounts).length > 0 ? { unknownLanes: unknownLaneCounts } : {}),
      prFixes: prFixCounts,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to fetch work summary:", error);
    return NextResponse.json({ error: "Failed to fetch work summary" }, { status: 500 });
  }
}
