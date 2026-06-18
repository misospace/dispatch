import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createIdleTask,
  createImplementTask,
  createFollowupPrTask,
  createGroomTask,
} from "@/lib/agent-task";
import { isBacklogLane, getBacklogLane } from "@/lib/lane-config";
import { fetchAgentQueueData } from "@/lib/agent-queue-fetch";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentName: string }> },
) {
  const { agentName } = await params;

  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const lane = searchParams.get("lane");
  const excludeDecomposed = searchParams.get("exclude_decomposed");
  const includeClaimed = searchParams.get("includeClaimed") === "true";
  const includeRenovate = searchParams.get("includeRenovate") === "true";
  const mode = searchParams.get("mode");

  try {
    // Groom mode: return exactly one issue to triage/enrich
    if (mode === "groom") {
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
          repository: { select: { fullName: true } },
        },
        orderBy: { number: "asc" },
      });

      const candidates = issues
        .map((issue) => {
          const hasStatus = issue.labels.some((l) => l.startsWith("status/"));
          const hasPriority = issue.labels.some((l) => l.startsWith("priority/"));
          const hasAgent = issue.labels.some((l) => l.startsWith("agent/"));
          const hasLane = !!issue.currentLane;
          const isBacklog = issue.currentLane ? isBacklogLane(issue.currentLane) : false;
          const isUnlabeled = issue.labels.length === 0;

          // Eligible if missing any key metadata
          const eligible =
            isUnlabeled || !hasStatus || !hasPriority || !hasAgent || !hasLane || isBacklog;

          // Score: fewer missing fields = lower priority (higher number)
          // Priority order: unlabeled > missing status > missing priority > backlog lane
          let score = 0;
          if (isUnlabeled) score += 1000;
          if (!hasStatus) score += 500;
          if (!hasPriority) score += 250;
          if (isBacklog) score += 100;
          if (!hasAgent) score += 50;
          if (!hasLane && !isBacklog) score += 25;

          return { issue, eligible, score };
        })
        .filter((c) => c.eligible)
        .sort((a, b) => b.score - a.score || a.issue.number - b.issue.number);

      if (candidates.length === 0) {
        return NextResponse.json(createIdleTask("No grooming work available"));
      }

      const best = candidates[0].issue;
      const task = createGroomTask({
        agentName,
        lane: best.currentLane ?? getBacklogLane()?.id ?? "backlog",
        issue: {
          repoFullName: best.repository.fullName,
          number: best.number,
          title: best.title,
          url: best.url,
        },
      });
      return NextResponse.json(task);
    }

    const { laneValid, rankedQueue, prFixItems, availableLanes } = await fetchAgentQueueData({
      agentName,
      lane,
      excludeDecomposed: excludeDecomposed === "true",
      includeClaimed,
      includeRenovate,
    });

    if (!laneValid) {
      return NextResponse.json(
        {
          error: `Invalid lane: "${lane}". Must be one of: ${availableLanes.join(", ")}`,
        },
        { status: 400 },
      );
    }

    if (prFixItems.length > 0) {
      const first = prFixItems[0];
      const reasons = [
        ...new Set([first.reason, ...first.feedback].filter(Boolean)),
      ];
      const task = createFollowupPrTask({
        agentName,
        lane: first.lane ?? undefined,
        pullRequest: {
          repoFullName: first.repo,
          number: first.pr,
          url: first.url ?? undefined,
        },
        issue: first.issue
          ? { repoFullName: first.repo, number: first.issue }
          : undefined,
        reasons,
      });
      return NextResponse.json(task);
    }

    if (rankedQueue.length > 0) {
      // Scan for linked PR follow-up before returning implement task
      const followupItem = rankedQueue.find(
        (item) => item.linkedPrHealth?.needsFollowup && item.linkedPrHealth?.number,
      );

      if (followupItem && followupItem.linkedPrHealth?.number) {
        const health = followupItem.linkedPrHealth;
        const task = createFollowupPrTask({
          agentName,
          lane: followupItem.lane ?? undefined,
          issue: {
            repoFullName: followupItem.repoFullName ?? "",
            number: followupItem.number,
            title: followupItem.title,
            url: followupItem.url,
          },
          pullRequest: {
            repoFullName: followupItem.repoFullName ?? "",
            number: health.number!,
            url: health.url ?? undefined,
          },
          reasons: health.followupReasons.length > 0
            ? health.followupReasons
            : ["Linked PR needs follow-up"],
        });
        return NextResponse.json(task);
      }

      const first = rankedQueue[0];
      const task = createImplementTask({
        agentName,
        lane: first.lane ?? undefined,
        issue: {
          repoFullName: first.repoFullName ?? "",
          number: first.number,
          title: first.title,
          url: first.url,
        },
      });
      return NextResponse.json(task);
    }

    return NextResponse.json(createIdleTask("No work available"));
  } catch (error) {
    console.error("Failed to fetch next task:", error);
    return NextResponse.json(
      { error: "Failed to fetch next task" },
      { status: 500 },
    );
  }
}
