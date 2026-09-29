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
import { agentAlreadyHanded, agentHandoutToken } from "@/lib/pr-fix-queue";

/** A queued PR-fix item as the route consumes it (see toAgentQueuePrFixItem). */
type PrFixCandidate = {
  id: string;
  repo: string;
  pr: number;
  lane?: string | null;
  url?: string | null;
  issue?: number | null;
  generation: number;
  reason: string;
  feedback: string[];
};

/**
 * Stamp the hand-out on the FIRST hand-out of this generation only:
 * the OR clause matches rows not yet stamped at the stamped
 * generation. Re-hand-outs of a still-QUEUED generation (polling
 * workers re-fetch every ~30s) must not re-stamp or clear
 * postDispatchEvidenceKeys, so evidence enqueued mid-run survives for
 * settlement to flag (#1119). The row is always re-read after the
 * stamp so evidence enqueued in the gap ships in this payload or is
 * flagged for a reopen rather than being swallowed.
 *
 * Bounded retry: if the re-read shows the row's generation moved
 * between the queue read and the stamp (another path took over the
 * item), the stamp+re-read runs once more against the NEW generation.
 *
 * Confirmed-token invariant: the task only ships a generation that a
 * stamp + re-read confirmed against the live row. Once a generation
 * move has been observed, an unconfirmed token would classify
 * mid-run evidence as pre-dispatch and let settlement absorb it —
 * the exact loss #1119 fixes — and its settle report may mismatch
 * anyway. When the bounded retry cannot confirm (the generation
 * moved on both passes, a failure after an observed move, or the row
 * vanished), the caller gets null and moves on to the next candidate.
 *
 * Best-effort: a failure here only loses freshness tracking, never
 * the task.
 */
async function confirmPrFixHandOut(
  candidate: PrFixCandidate,
): Promise<{ generation: number; reason: string; feedback: string[] } | null> {
  let dispatchReason = candidate.reason;
  let dispatchFeedback = candidate.feedback;
  // The generation the task token ships, or null when no pass
  // confirmed the live row (defer the hand-out to the next poll).
  let confirmedGeneration: number | null = null;
  // The generation the next pass stamps. Moves forward as re-reads
  // observe concurrent re-issues; differing from candidate.generation
  // marks that a move was observed.
  let nextGeneration = candidate.generation;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const stampGeneration = nextGeneration;
      await prisma.prFixQueueItem.updateMany({
        where: {
          id: candidate.id,
          generation: stampGeneration,
          OR: [
            { dispatchedGeneration: null },
            { dispatchedGeneration: { not: stampGeneration } },
          ],
        },
        data: {
          dispatchedAt: new Date(),
          dispatchedGeneration: stampGeneration,
          postDispatchEvidenceKeys: [],
        },
      });
      const fresh = await prisma.prFixQueueItem.findUnique({
        where: { id: candidate.id },
        select: { reason: true, feedback: true, generation: true },
      });
      if (!fresh) break;
      dispatchReason = fresh.reason;
      dispatchFeedback = fresh.feedback ?? [];
      // A re-read generation that is a number and not the one we just
      // stamped means the row moved under us: log the race (#1119) and
      // retry the stamp+re-read against the new generation. The token
      // may only ship once a pass confirms.
      if (typeof fresh.generation === "number" && fresh.generation !== stampGeneration) {
        console.warn(`next-task pr-fix hand-out re-read for ${candidate.repo}#${candidate.pr}: generation moved ${stampGeneration} -> ${fresh.generation}`);
        nextGeneration = fresh.generation;
        continue;
      }
      // The re-read confirms the row is still at the stamped
      // generation: the token may ship.
      confirmedGeneration = typeof fresh.generation === "number" ? fresh.generation : stampGeneration;
      break;
    }
  } catch (error) {
    console.error(`next-task pr-fix dispatch tracking update failed for ${candidate.repo}#${candidate.pr}:`, error);
    // Best-effort: without an observed move, the pre-stamp snapshot is
    // as good as any (same behavior as before the retry existed). After
    // a move the live generation is unknown — a stale token's settle
    // report would be rejected as a mismatch — so leave the hand-out
    // unconfirmed and defer.
    dispatchReason = candidate.reason;
    dispatchFeedback = candidate.feedback;
    if (nextGeneration === candidate.generation) {
      confirmedGeneration = candidate.generation;
    }
  }
  if (confirmedGeneration === null) {
    console.warn(`next-task pr-fix hand-out for ${candidate.repo}#${candidate.pr}: no confirmed generation; deferring the item to the next poll`);
    return null;
  }
  return { generation: confirmedGeneration, reason: dispatchReason, feedback: dispatchFeedback };
}

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

    // PR-fix items come first, but an item this agent already received at
    // its current generation is not dispatchable to it again (#1133): the
    // polling worker drops the re-hand (it already has a run for that work
    // identity), so re-handing only starves the lane behind it. Scan for
    // the first item that is both new to this agent and confirmable; a
    // skipped or contested candidate falls through to the next one, and
    // only a fully undispatchable PR-fix queue falls through to issue work.
    for (const candidate of prFixItems) {
      // The hand-out record is per-agent: another agent still gets the
      // item, and this agent gets it again once a fresh attempt bumps the
      // generation (#1133).
      if (agentAlreadyHanded(candidate, agentName)) continue;

      const confirmed = await confirmPrFixHandOut(candidate);
      if (!confirmed) continue;

      // Record the per-agent hand-out at the confirmed generation so the
      // skip applies to this agent's future polls. The write is pinned to
      // the confirmed generation, so a re-issue landing between the
      // confirmation and this push no-ops instead of recording a hand-out
      // for a dead identity. Best-effort: a failure only loses the skip
      // (the next poll may re-hand, which workers already dedupe), never
      // the task itself.
      try {
        await prisma.prFixQueueItem.updateMany({
          where: { id: candidate.id, generation: confirmed.generation },
          data: {
            agentHandouts: {
              push: [agentHandoutToken(agentName, confirmed.generation)],
            },
          },
        });
      } catch (error) {
        console.error(`next-task pr-fix hand-out record failed for ${candidate.repo}#${candidate.pr}:`, error);
      }

      const reasons = [...new Set([confirmed.reason, ...confirmed.feedback].filter(Boolean))];
      const task = createFollowupPrTask({
        agentName,
        lane: candidate.lane ?? undefined,
        pullRequest: {
          repoFullName: candidate.repo,
          number: candidate.pr,
          url: candidate.url ?? undefined,
        },
        issue: candidate.issue
          ? { repoFullName: candidate.repo, number: candidate.issue }
          : undefined,
        prFixItem: {
          id: candidate.id,
          generation: confirmed.generation,
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
