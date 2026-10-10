import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import {
  createIdleTask,
  createImplementTask,
  createFollowupPrTask,
} from "@/lib/agent-task";
import { isBacklogLane, prFixLaneForRequest } from "@/lib/lane-config";
import { fetchAgentQueueData } from "@/lib/agent-queue-fetch";
import { agentAlreadyHanded, agentHandoutToken, createLinkedPrFixItem, normalizeQueueRepo } from "@/lib/pr-fix-queue";
import { fetchPullRequestLabels, fetchPullRequestHeadSha } from "@/lib/github";
import { NEEDS_HUMAN_LABEL } from "@/lib/pr-fix-surfacing";

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
  agentName: string,
): Promise<{ generation: number; reason: string; feedback: string[]; lane: string | null } | null> {
  let dispatchReason = candidate.reason;
  let dispatchFeedback = candidate.feedback;
  let dispatchLane = candidate.lane ?? null;
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
          status: "QUEUED",
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
        select: { reason: true, feedback: true, generation: true, status: true, lane: true, agentHandouts: true },
      });
      if (
        !fresh ||
        (fresh.status !== undefined && fresh.status !== "QUEUED") ||
        (fresh.lane !== undefined && candidate.lane !== undefined && fresh.lane !== candidate.lane)
      ) break;
      if (agentAlreadyHanded({ agentHandouts: fresh.agentHandouts, generation: fresh.generation }, agentName)) break;
      dispatchReason = fresh.reason;
      dispatchFeedback = fresh.feedback ?? [];
      dispatchLane = fresh.lane ?? null;
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
  return { generation: confirmedGeneration, reason: dispatchReason, feedback: dispatchFeedback, lane: dispatchLane };
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

  // External grooming is retired. Reject before any candidate or queue reads.
  if (mode === "groom") {
    return errorResponse("External grooming task dispatch is retired; use POST /api/groomer/run", 410);
  }

  // A bound worker credential may only act for its own agent; an unbound
  // legacy worker token is refused on this identity-scoped route (#1129).
  const scopeError = await enforceWorkerAgentScope(auth, agentName);
  if (scopeError) return scopeError;

  try {
    const { laneValid, resolvedLane, rankedQueue, fullQueue, withheldQueue, admissionMode, prFixItems, availableLanes } =
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

    // Issue identity for the deferred-work set: `<repo>#<issueNumber>`, repo
    // case-folded so a cache row written with different casing than the
    // issue's `repository.fullName` still matches (#1145).
    const issueKey = (repo: string | null | undefined, number: number) =>
      `${(repo ?? "").toLowerCase()}#${number}`;
    // Issues the queue owns for this poll (#1145). They must not be handed out
    // as ordinary implement work: a worker would push to the very PR the queue
    // is holding back — bypassing a BLOCKED / needs-human verdict and
    // re-creating the loop this fix removes.
    const deferredIssues = new Set<string>();

    const dispatchPrFixCandidate = async (candidate: PrFixCandidate) => {
      if (agentAlreadyHanded(candidate, agentName)) return null;
      const confirmed = await confirmPrFixHandOut(candidate, agentName);
      if (!confirmed) return null;

      try {
        await prisma.prFixQueueItem.updateMany({
          where: { id: candidate.id, generation: confirmed.generation, status: "QUEUED" },
          data: { agentHandouts: { push: [agentHandoutToken(agentName, confirmed.generation)] } },
        });
      } catch (error) {
        console.error(`next-task pr-fix hand-out record failed for ${candidate.repo}#${candidate.pr}:`, error);
      }

      const reasons = [...new Set([confirmed.reason, ...confirmed.feedback].filter(Boolean))];
      return createFollowupPrTask({
        agentName,
        lane: confirmed.lane ?? undefined,
        pullRequest: {
          repoFullName: candidate.repo,
          number: candidate.pr,
          url: candidate.url ?? undefined,
        },
        issue: candidate.issue
          ? { repoFullName: candidate.repo, number: candidate.issue }
          : undefined,
        prFixItem: { id: candidate.id, generation: confirmed.generation },
        reasons,
      });
    };

    // PR-fix items come first, but an item this agent already received at
    // its current generation is not dispatchable to it again (#1133): the
    // polling worker drops the re-hand (it already has a run for that work
    // identity), so re-handing only starves the lane behind it. Scan for
    // the first item that is both new to this agent and confirmable; a
    // skipped or contested candidate falls through to the next one, and
    // only a fully undispatchable PR-fix queue falls through to issue work.
    for (const candidate of prFixItems) {
      const task = await dispatchPrFixCandidate(candidate);
      if (task) return NextResponse.json(task);
      // The item stays queue-owned: this agent already holds its work
      // identity, or the row was contested. Its issue must not be re-served
      // as implement work on the same PR (#1145).
      if (candidate.issue != null) deferredIssues.add(issueKey(candidate.repo, candidate.issue));
    }

    // Linked-PR follow-up is PR work, not implementation pickup, so it scans
    // the queue before grooming admission (#1065); in off/audit mode the two
    // queues are the same list.
    //
    // The caller's lane decides whether it may consume PR-fix work at all
    // (#1046): `null` means a configured lane with no PR-fix equivalent (e.g.
    // "cloud"), `undefined` an unfiltered request that serves every lane.
    const requestPrFixLane = prFixLaneForRequest(resolvedLane);
    const dispatchedLinkedPrs = new Set<string>();

    for (const followupItem of fullQueue) {
      const health = followupItem.linkedPrHealth;
      const repo = followupItem.repoFullName;
      const pr = health?.number;
      if (!pr || !repo) continue;

      // Queue rows own the PR identity in every state — including BLOCKED,
      // which `listQueuedPrFixItems` does not surface, so it never appears in
      // prFixItems above. This check deliberately does NOT depend on the cached
      // `needsFollowup` flag: that column is refreshed on a reconcile cadence
      // and can lag the row's creation, and a false value must not let the
      // issue through to implement pickup on a PR the queue is holding back.
      const existing = await prisma.prFixQueueItem.findUnique({
        where: { repo_pr: { repo: normalizeQueueRepo(repo), pr } },
      });
      if (existing) {
        deferredIssues.add(issueKey(repo, followupItem.number));
        continue;
      }

      // No row: only follow-up health asks us to create one. A linked PR that
      // needs no follow-up leaves the issue as ordinary implement work.
      if (!health?.needsFollowup) continue;
      // From here the issue is queue-owned for the poll whatever happens next.
      deferredIssues.add(issueKey(repo, followupItem.number));
      const key = `${repo.toLowerCase()}#${pr}`;
      if (dispatchedLinkedPrs.has(key)) continue;
      dispatchedLinkedPrs.add(key);

      const labels = await fetchPullRequestLabels(repo, pr);
      if (labels === null || labels.some((label) => label.toLowerCase() === NEEDS_HUMAN_LABEL)) continue;

      // Lane for the materialized item: the issue's lane when it has a PR-fix
      // equivalent (default -> NORMAL, escalation -> ESCALATED). A claimable
      // lane with no role (e.g. a "cloud" lane) has no PR-fix equivalent, but
      // that must not silently drop discovered work — fall back to NORMAL,
      // the same lane the default claimable lane consumes.
      const queueLane = prFixLaneForRequest(followupItem.lane) ?? "NORMAL";
      const reasons = [...new Set(
        (health.followupReasons.length > 0 ? health.followupReasons : ["Linked PR needs follow-up"])
          .filter((reason): reason is string => Boolean(reason)),
      )];
      // Materialization is best-effort per candidate: a transient DB failure
      // must not 500 the poll (and with it the whole lane), so log and move on
      // to the next candidate.
      let materialized: Awaited<ReturnType<typeof createLinkedPrFixItem>>;
      try {
        // Capture the head the follow-up attempt starts from (#1074), so the
        // #940 no-progress guard can refuse a FIXED tombstone for a worker that
        // pushed nothing — the same protection queue-enqueued rows get.
        const headSha = await fetchPullRequestHeadSha(repo, pr);
        materialized = await createLinkedPrFixItem(asPrFixQueueClient(prisma), {
          repo,
          pr,
          issue: followupItem.number,
          lane: queueLane,
          reason: reasons[0],
          feedback: reasons,
          evidenceKey: `linked-health:${followupItem.number}:${health.checkedAt ?? "unknown"}`,
          url: health.url,
          title: `Follow up linked PR for ${repo}#${followupItem.number}`,
          headSha,
        });
      } catch (error) {
        console.error(`next-task linked-PR materialization failed for ${repo}#${pr}:`, error);
        continue;
      }

      // A concurrent enqueue wins ownership without mutation. It appears in
      // the queue snapshot next poll; do not manufacture a second token here.
      if (!materialized.created || materialized.item?.status !== "QUEUED") continue;

      // A lane without a PR-fix equivalent must not consume PR-fix work
      // (#1046). The row is materialized above so a capable lane picks it up
      // next poll; this caller keeps to its own issue work.
      if (requestPrFixLane === null) continue;
      const linkedContext = {
        reasons,
        issueTitle: followupItem.title,
        issueUrl: followupItem.url,
      };
      const candidate = {
        id: materialized.item.id,
        repo,
        pr,
        lane: materialized.item.lane,
        url: materialized.item.url,
        issue: materialized.item.issue,
        generation: materialized.item.generation,
        reason: materialized.item.reason,
        feedback: materialized.item.feedback ?? [],
        agentHandouts: materialized.item.agentHandouts ?? [],
      };
      const task = await dispatchPrFixCandidate(candidate);
      if (task) {
        if (task.issue) {
          task.issue.title = linkedContext.issueTitle ?? followupItem.title;
          task.issue.url = linkedContext.issueUrl ?? followupItem.url;
        }
        if (linkedContext.reasons?.length) task.reasons = linkedContext.reasons;
        return NextResponse.json(task);
      }
    }

    // Ordinary issue pickup skips every issue whose linked PR the queue owns
    // for this poll (#1145), so the lane drains to the next independent issue
    // instead of re-serving the deferred one.
    const isDeferred = (item: { repoFullName?: string | null; number: number }) =>
      deferredIssues.has(issueKey(item.repoFullName, item.number));
    const first = rankedQueue.find((item) => !isDeferred(item));
    if (first) {
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

    // No dispatchable issue left: report why, so an operator can tell a
    // queue-owned deferral apart from a grooming-admission hold.
    const deferredCount = rankedQueue.filter(isDeferred).length;
    const deferredNote =
      deferredCount > 0
        ? `${deferredCount} ready issue${deferredCount === 1 ? "" : "s"} deferred: linked PR follow-up is owned by the PR-fix queue`
        : null;

    if (withheldQueue.length > 0) {
      const withheldNote = `${withheldQueue.length} ready issue${withheldQueue.length === 1 ? "" : "s"} withheld by grooming admission`;
      return NextResponse.json(
        createIdleTask(`No work available (${[withheldNote, deferredNote].filter(Boolean).join("; ")})`),
      );
    }

    if (deferredNote) {
      return NextResponse.json(createIdleTask(`No work available (${deferredNote})`));
    }

    return NextResponse.json(createIdleTask("No work available"));
  } catch (error) {
    return handleApiError("fetch next task", error);
  }
}
