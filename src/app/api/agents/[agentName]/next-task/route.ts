import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createIdleTask,
  createImplementTask,
  createFollowupPrTask,
  createGroomTask,
} from "@/lib/agent-task";
import { isBacklogLane, getBacklogLane } from "@/lib/lane-config";
import { fetchAgentQueueData } from "@/lib/agent-queue-fetch";
import { selectGroomingCandidate } from "@/lib/groomer/selector";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentName: string }> },
) {
  const { agentName } = await params;

  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
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
      const candidate = await selectGroomingCandidate();
      if (!candidate) {
        return NextResponse.json(createIdleTask("No grooming work available"));
      }

      const task = createGroomTask({
        agentName,
        lane: candidate.currentLane ?? getBacklogLane()?.id ?? "backlog",
        issue: {
          id: candidate.id,
          repoFullName: candidate.repoFullName,
          number: candidate.number,
          title: candidate.title,
          url: candidate.url,
        },
      });
      return NextResponse.json(task);
    }

    const { laneValid, rankedQueue, fullQueue, withheldQueue, admissionMode, prFixItems, availableLanes } =
      await fetchAgentQueueData({
        agentName,
        lane,
        excludeDecomposed: excludeDecomposed === "true",
        includeClaimed,
        includeRenovate,
      });

    if (!laneValid) {
      return errorResponse(`Invalid lane: "${lane}". Must be one of: ${availableLanes.join(", ")}`, 400);
    }

    if (prFixItems.length > 0) {
      const first = prFixItems[0];
      // Stamp the hand-out on the FIRST hand-out of this generation only:
      // the OR clause matches rows not yet stamped at `first.generation`.
      // Re-hand-outs of a still-QUEUED generation (polling workers re-fetch
      // every ~30s) must not re-stamp or clear postDispatchEvidenceKeys, so
      // evidence enqueued mid-run survives for settlement to flag (#1119).
      // The row is always re-read after the stamp so evidence enqueued in
      // the gap ships in this payload or is flagged for a reopen rather than
      // being swallowed. Best-effort: a failure here only loses freshness
      // tracking, never the task.
      let dispatchReason = first.reason;
      let dispatchFeedback = first.feedback;
      try {
        await prisma.prFixQueueItem.updateMany({
          where: {
            id: first.id,
            generation: first.generation,
            OR: [
              { dispatchedGeneration: null },
              { dispatchedGeneration: { not: first.generation } },
            ],
          },
          data: {
            dispatchedAt: new Date(),
            dispatchedGeneration: first.generation,
            postDispatchEvidenceKeys: [],
          },
        });
        const fresh = await prisma.prFixQueueItem.findUnique({
          where: { id: first.id },
          select: { reason: true, feedback: true, generation: true },
        });
        if (fresh) {
          if (fresh.generation !== first.generation) {
            // Generation moved between the queue read and the stamp: another
            // attempt took over. Log so the race is visible (#1119).
            console.warn(`next-task pr-fix hand-out re-read for ${first.repo}#${first.pr}: generation moved`);
          }
          dispatchReason = fresh.reason;
          dispatchFeedback = fresh.feedback ?? [];
        }
      } catch (error) {
        console.error(`next-task pr-fix dispatch tracking update failed for ${first.repo}#${first.pr}:`, error);
      }
      const reasons = [...new Set([dispatchReason, ...dispatchFeedback].filter(Boolean))];
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
        prFixItem: {
          id: first.id,
          generation: first.generation,
        },
        reasons,
      });
      return NextResponse.json(task);
    }

    // Linked-PR follow-up is PR work, not implementation pickup, so it scans
    // the queue before grooming admission (#1065); in off/audit mode the two
    // queues are the same list.
    if (fullQueue.length > 0) {
      // Scan for linked PR follow-up before returning implement task
      const followupItem = fullQueue.find(
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
    }

    if (rankedQueue.length > 0) {
      const first = rankedQueue[0];
      if (admissionMode === "audit" && first.admission && !first.admission.admitted) {
        console.warn(
          `[queue-admission] audit: ${agentName} handed ${first.repoFullName ?? ""}#${first.number}, which enforce mode would withhold: ${first.admission.summary}`,
        );
      }
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

    if (withheldQueue.length > 0) {
      return NextResponse.json(
        createIdleTask(
          `No work available (${withheldQueue.length} ready issue${withheldQueue.length === 1 ? "" : "s"} withheld by grooming admission)`,
        ),
      );
    }

    return NextResponse.json(createIdleTask("No work available"));
  } catch (error) {
    return handleApiError("fetch next task", error);
  }
}
