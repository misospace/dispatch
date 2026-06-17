import { NextResponse } from "next/server";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { buildAgentQueue } from "@/lib/agent-queue";
import { listQueuedPrFixItems, toAgentQueuePrFixItem } from "@/lib/pr-fix-queue";
import { findLeasedIssueIds } from "@/lib/lease";
import { parseExcludedLabels } from "@/lib/config";
import {
  createIdleTask,
  createImplementTask,
  createFollowupPrTask,
} from "@/lib/agent-task";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentName: string }> },
) {
  const { agentName } = await params;
  const { searchParams } = new URL(request.url);
  const lane = searchParams.get("lane");
  const excludeDecomposed = searchParams.get("exclude_decomposed");
  const includeClaimed = searchParams.get("includeClaimed") === "true";
  const includeRenovate = searchParams.get("includeRenovate") === "true";

  try {
    const issues = await prisma.issue.findMany({
      where: {
        state: "open",
        repository: { enabled: true },
      },
      select: {
        id: true,
        number: true,
        title: true,
        url: true,
        labels: true,
        currentLane: true,
        decomposed: true,
        repository: { select: { fullName: true } },
        linkedPrNumber: true,
        linkedPrUrl: true,
        linkedPrNeedsFollowup: true,
        linkedPrFollowupReasons: true,
        linkedPrReviewDecision: true,
        linkedPrMergeState: true,
        linkedPrHealthCheckedAt: true,
      },
    });

    const issueLane = lane?.toLowerCase() as "normal" | "escalated" | "backlog" | undefined;
    const prFixLane = lane;

    const leasedIssueIds = await findLeasedIssueIds(agentName);

    const prFixItems = await listQueuedPrFixItems(
      asPrFixQueueClient(prisma),
      { lane: prFixLane },
    );

    const filteredIssues = issues.filter(
      (issue) => !leasedIssueIds.includes(issue.id),
    );

    const queue = buildAgentQueue(
      filteredIssues.map((issue) => ({
        ...issue,
        lane: issue.currentLane ?? undefined,
        issueId: issue.id,
        repoFullName: issue.repository.fullName,
        linkedPrHealth: {
          number: issue.linkedPrNumber,
          url: issue.linkedPrUrl,
          needsFollowup: issue.linkedPrNeedsFollowup,
          followupReasons: issue.linkedPrFollowupReasons,
          reviewDecision: issue.linkedPrReviewDecision,
          mergeState: issue.linkedPrMergeState,
          checkedAt: issue.linkedPrHealthCheckedAt?.toISOString() ?? null,
        },
      })),
      agentName,
      {
        lane: issueLane,
        excludeDecomposed: excludeDecomposed === "true",
        includeClaimed,
        includeRenovate,
        excludedLabels: parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS),
      },
    );

    const prFixQueueItems = prFixItems.map(toAgentQueuePrFixItem);

    if (prFixQueueItems.length > 0) {
      const first = prFixQueueItems[0];
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

    if (queue.length > 0) {
      // Scan for linked PR follow-up before returning implement task
      const followupItem = queue.find(
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

      const first = queue[0];
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
