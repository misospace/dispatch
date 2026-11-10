import { PrFixLane } from "@/types";
import { getConfiguredLanes, type LaneConfig, laneMatchesConfigured } from "../lane-config";
import { type PrFixQueueClient } from "./client";
import { normalizeQueueRepo } from "./shared";

/**
 * The explicitly configured escalation lane (claimable, role "escalation"),
 * or null when the deployment declared none.
 *
 * Deliberately NOT `getEscalationLane()`, whose fallback resolves "the
 * escalation lane" to the default claimable lane: on a single-lane deployment
 * that would make EVERY linked issue look escalation-classified and raise
 * every PR-fix item. Exclusivity exists only where the operator declared an
 * escalation tier — the same explicitness rule the scan-failure recurrence
 * branch in pr-followup-ingestion applies.
 */
export function getExplicitEscalationLane(): LaneConfig | null {
  return getConfiguredLanes().find((lane) => lane.claimable && lane.role === "escalation") ?? null;
}

/**
 * Tri-state result of the authoritative linked-issue classification read
 * (#1503 review): the hand-out boundary must be able to distinguish a
 * definitive "not escalation" from an UNVERIFIABLE read — an unknown
 * classification must never authorize the lower/shared lane.
 */
export type LinkedIssueEscalationClassification =
  | "ESCALATED"
  | "NOT_ESCALATED"
  | "UNKNOWN";

/**
 * Whether a PR-fix row's linked issue is AUTHORITATIVELY escalation-classified
 * (#1503): the issue row's `currentLane` matches the configured escalation
 * lane (aliases resolved). The issue — not the agent name, not the PR-fix
 * row's own mutable lane — is the escalation provenance, so nothing here
 * infers authority from an agent display label.
 *
 * Tri-state, FAIL CLOSED on the hand-out boundary (#1503 review):
 * - issue null/undefined → "NOT_ESCALATED" (no parent; definitive).
 * - no explicit escalation lane configured → "NOT_ESCALATED" (the feature is
 *   inert on this deployment; definitive).
 * - lookup succeeds, row found → "ESCALATED"/"NOT_ESCALATED" per the row.
 * - lookup succeeds, NO row → "NOT_ESCALATED" — deliberately a DEFINITIVE
 *   read, not an error: a missing issue row cannot conceal a live frontier
 *   parent (classification recreates rows via sync), and treating pruning as
 *   UNKNOWN would strand QUEUED items forever. Enqueue may still conservatively
 *   keep its supplied lane on it.
 * - any thrown error → "UNKNOWN": an unverifiable classification must not
 *   authorize the lower/shared lane. Where UNKNOWN lands per caller:
 *   enqueue conservatively keeps the supplied lane; requeue keeps the row's
 *   existing lane (no silent demotion); the hand-out gate refuses NORMAL
 *   consumers (escalation/unfiltered consumers stay eligible — an escalation
 *   consumer is authorized regardless, and the #1046 unfiltered poll is
 *   unrestricted by contract).
 */
export async function linkedIssueEscalationClassified(
  client: Pick<PrFixQueueClient, "issue">,
  repo: string,
  issue: number | null | undefined,
): Promise<LinkedIssueEscalationClassification> {
  if (issue === null || issue === undefined) return "NOT_ESCALATED";
  const escalationLane = getExplicitEscalationLane();
  if (!escalationLane) return "NOT_ESCALATED";
  try {
    // The queue folds repo casing (#1145); Issue.repository.fullName keeps the
    // GitHub casing — match case-insensitively instead of re-deriving the row.
    const row = await client.issue?.findFirst({
      where: {
        repository: { fullName: { equals: normalizeQueueRepo(repo), mode: "insensitive" } },
        number: issue,
      },
      select: { currentLane: true },
    });
    return row ? (laneMatchesConfigured(row.currentLane ?? null, escalationLane.id) ? "ESCALATED" : "NOT_ESCALATED") : "NOT_ESCALATED";
  } catch (error) {
    console.warn("[pr-fix-queue] linked-issue escalation lookup failed; deferring classification as UNKNOWN (#1503)", {
      repo,
      issue,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return "UNKNOWN";
  }
}

/**
 * Lane-preservation rule (#1503): a row already carrying the exclusive
 * escalation lane is never demoted to NORMAL by a recovery / fresh-attempt /
 * requeue write. Only an explicit human hold (NEEDS_HUMAN, which blocks
 * dispatch entirely) may replace ESCALATED. Everything else collapses to
 * NORMAL exactly as before #1503.
 */
export function preserveEscalationLane(lane: unknown): PrFixLane {
  return lane === "ESCALATED" ? "ESCALATED" : "NORMAL";
}

/**
 * Release-lane rule (#1503 review): any path that returns a held or parked
 * row to the dispatchable loop re-derives the authoritative classification
 * from the linked issue — a NEEDS_HUMAN hold replaced the lane column, so
 * `preserveEscalationLane` alone cannot see a frontier parent. ESCALATED
 * (verified) wins; otherwise the row collapses per preserveEscalationLane:
 * a hold deliberately resets to NORMAL unless the parent verifies ESCALATED
 * (pre-#1503 rule), and an unreadable parent (UNKNOWN) neither demotes a
 * stored ESCALATED row nor raises an unverified one — the hand-out gate
 * re-reads at issuance either way. Shared with requeuePrFixItem so the
 * release semantics cannot drift between the operator and mark paths.
 */
export function releaseLaneFromParentClass(
  parentClass: LinkedIssueEscalationClassification,
  existingLane: unknown,
): PrFixLane {
  return parentClass === "ESCALATED" ? "ESCALATED" : preserveEscalationLane(existingLane);
}

/**
 * Hand-out lane-compatibility gate (#1503), the defense-in-depth layer in
 * front of the read filter: a consumer polling the NORMAL role must never be
 * handed PR-fix work whose authoritative classification (linked issue on the
 * escalation lane) or stored lane is ESCALATED — including rows misclassified
 * before this fix, and parent/queue changes that raced the queue read.
 *
 * Request-lane semantics follow `prFixLaneForRequest`:
 * - "NORMAL": the declared shared queue. Refuses any escalation-authoritative
 *   candidate and applies the SAFE CLASSIFICATION CORRECTION: the stored lane
 *   flips NORMAL → ESCALATED by CAS pinned on (id, lane, status QUEUED,
 *   generation, empty agentHandouts, no dispatch stamp at this generation).
 *   The CAS never touches generation, dispatch stamps, receipts, or acks, and
 *   a LIVE attempt (any hand-out record at the current generation) or an
 *   already-dispatched generation misses the pin and is left exactly as
 *   issued: no stolen claim, no disturbed receipt. The residual window — a
 *   normal poller that passed this gate on a pre-reclassification read and
 *   stamps after this CAS re-reads — keeps its pre-#1503 meaning: same-
 *   generation hand-outs to several agents are an existing, settlement-
 *   arbitrated behavior; what the gate adds is that no NEW normal-lane
 *   issuance starts on escalation-authoritative work, and every observation
 *   retries the correction until it lands (a racing plain-lane enqueue can
 *   undo it, and the next gate re-applies it).
 *   Queued work self-heals for the escalation consumer on the next poll.
 * - "ESCALATED": the read filter already handed this poller only ESCALATED
 *   rows; a lane mismatch here can only be a stale read, and the existing
 *   hand-out re-read pin (lane equality at stamp time) defers that race.
 * - undefined (unfiltered poll): legacy/operator request that intentionally
 *   serves every lane (#1046) — never refused, but the correction above is
 *   still applied opportunistically so misclassified rows converge no matter
 *   which consumer observes them first.
  * - UNKNOWN parent (#1503 review, widened by #1569): an unverifiable
  *   classification authorizes NEITHER declared lane — both the
  *   declared-NORMAL and the declared-ESCALATED consumer are refused
  *   (transient — the next poll re-reads; no correction CAS, no history row,
  *   because there is nothing verified to correct). Only the unfiltered
  *   legacy poll is unrestricted by contract, and it gets no correction
  *   either. REBASE rows are exempt from this LANE gate upstream — but not
  *   from the ownership gate (#1569): `evaluatePrFixHandoutOwnership`
  *   applies to every dispatchable candidate, REBASE included.
 *
 * REBASE rows are the declared mechanical exception (#1327): they are gated
 * by the DISPATCH_REBASE_AGENTS local-only pool, not this lane column, and
 * raising their lane would strand a merge conflict with nobody able to fix
 * it. The caller skips this gate for REBASE candidates entirely.
 */
export async function enforcePrFixHandoutLaneExclusivity(
  client: PrFixQueueClient,
  candidate: {
    id: string;
    repo: string;
    pr: number;
    issue?: number | null;
    generation: number;
    lane?: string | null;
  },
  requestPrFixLane: "NORMAL" | "ESCALATED" | null | undefined,
): Promise<{ decision: "eligible" | "refuse"; correctedLane: boolean }> {
  // A stored ESCALATED row needs no linked-issue lookup: it is exclusive by
  // its own classification, and a declared-normal poller must never get past
  // it (the read filter should have kept it out of this poll's candidates —
  // reaching here means the row was reclassified after the queue read).
  if (candidate.lane === "ESCALATED") {
    if (requestPrFixLane === "NORMAL") {
      console.info("[next-task-pr-fix] refusing ESCALATED PR-fix work for the normal lane (#1503)", {
        repoFullName: candidate.repo,
        pullRequestNumber: candidate.pr,
        generation: candidate.generation,
        escalationLinked: null,
        correctedLane: false,
      });
      return { decision: "refuse", correctedLane: false };
    }
    return { decision: "eligible", correctedLane: false };
  }

  // Lane NORMAL (or a legacy null): the linked issue is the only authority.
  // The shared verdict helper keeps the plain tri-state lookup and the fence's
  // locked re-read (`withHandoutLaneExclusivityFence`) on the SAME semantics.
  return handoutExclusivityFromParentClass(
    client,
    candidate,
    requestPrFixLane,
    await linkedIssueEscalationClassified(client, candidate.repo, candidate.issue),
  );
}

/**
 * The parent-classification verdict shared by the plain gate and the fence's
 * locked re-read (#1503 review, symmetric both-directions rule #1569):
 * NOT_ESCALATED → eligible for NORMAL/unfiltered, REFUSED for a
 * declared-ESCALATED consumer (frontier cannot take normal work); UNKNOWN →
 * refused for BOTH declared lanes (fail closed, no correction — nothing was
 * verified); ESCALATED → the safe correction CAS + history row, then
 * refuse-for-NORMAL / eligible-for-escalated-and-unfiltered. Kept internal so
 * both authority reads can never drift apart.
 */
export async function handoutExclusivityFromParentClass(
  client: PrFixQueueClient,
  candidate: {
    id: string;
    repo: string;
    pr: number;
    issue?: number | null;
    generation: number;
    lane?: string | null;
  },
  requestPrFixLane: "NORMAL" | "ESCALATED" | null | undefined,
  parentClass: LinkedIssueEscalationClassification,
): Promise<{ decision: "eligible" | "refuse"; correctedLane: boolean }> {
  const escalation = parentClass;
  if (escalation === "NOT_ESCALATED") {
    // #1569: isolation is BIDIRECTIONAL at issuance. Work that is
    // authoritatively NORMAL never goes to a declared-escalation consumer
    // either — the frontier lane exists exclusively for escalation work, and
    // a shared-queue repair must not be absorbed by the tier reserved for
    // higher-judgment fixes. A row already STORED ESCALATED is frontier by
    // its own authority (#1503: a verified row is never demoted by a later
    // parent read), so it stays eligible for the escalation consumer — the
    // fence's locked re-read lands here with the row lane, not a fresh one.
    // (The read filter should have kept a NORMAL row out of the escalation
    // poll's candidates entirely; reaching here means a reclassification
    // raced the queue read, or a linked-PR materialization offered NORMAL
    // work to an escalation poll.)
    if (requestPrFixLane === "ESCALATED" && candidate.lane !== "ESCALATED") {
      console.info("[next-task-pr-fix] refusing NORMAL PR-fix work for the escalation lane (#1569)", {
        repoFullName: candidate.repo,
        pullRequestNumber: candidate.pr,
        generation: candidate.generation,
        escalationLinked: "NOT_ESCALATED",
        correctedLane: false,
      });
      return { decision: "refuse", correctedLane: false };
    }
    return { decision: "eligible", correctedLane: false };
  }
  // UNKNOWN parent (#1503 review, widened symmetrically by #1569): an
  // unverifiable classification must not authorize EITHER declared lane.
  // No correction CAS and no history row: nothing was verified, so there is
  // nothing to correct. The #1046 unfiltered poll stays eligible (see
  // docblock).
  if (escalation === "UNKNOWN") {
    if (requestPrFixLane === "NORMAL" || requestPrFixLane === "ESCALATED") {
      console.info(`[next-task-pr-fix] refusing PR-fix work with an UNVERIFIABLE escalation classification for the declared ${requestPrFixLane} lane (#1503, #1569)`, {
        repoFullName: candidate.repo,
        pullRequestNumber: candidate.pr,
        generation: candidate.generation,
        escalationLinked: "UNKNOWN",
        correctedLane: false,
      });
      return { decision: "refuse", correctedLane: false };
    }
    return { decision: "eligible", correctedLane: false };
  }

  // Safe correction of a stale/misclassified QUEUED row (see docblock).
  // Pinned so it can never disturb a live attempt or a concurrently moved
  // generation; best-effort — a refused hand-out stands either way, and the
  // next observation retries the correction.
  let correctedLane = false;
  try {
    const { count } = await client.prFixQueueItem.updateMany({
      where: {
        id: candidate.id,
        lane: "NORMAL",
        status: "QUEUED",
        generation: candidate.generation,
        // A hand-out record at this generation = a live attempt. Fresh
        // attempts/reclaims reset the list, so empty means "never handed
        // out at this generation".
        agentHandouts: { equals: [] },
        // And no dispatch stamp at this generation either: a poller that
        // passed this gate on the pre-reclassification read stamps before it
        // appends, so pinning the stamp closes the correction on the row it
        // is about to hand out (Prisma `not` never matches NULL, hence the
        // explicit OR).
        OR: [{ dispatchedGeneration: null }, { dispatchedGeneration: { not: candidate.generation } }],
      },
      data: { lane: "ESCALATED" },
    });
    if (count === 1) {
      correctedLane = true;
      await client.prFixHistory.create({
        data: {
          itemId: candidate.id,
          action: "mark",
          status: "QUEUED",
          lane: "ESCALATED",
          note: `Escalation-lane correction (#1503): linked issue #${candidate.issue} is escalation-classified; queued row reclassified NORMAL → ESCALATED (no generation change, no hand-out touched).`,
        },
      });
    }
  } catch (error) {
    console.warn(
      `[pr-fix-queue] escalation-lane correction failed for ${candidate.repo}#${candidate.pr} (#1503):`,
      error instanceof Error ? error.message : error,
    );
  }

  if (requestPrFixLane === "NORMAL") {
    console.info("[next-task-pr-fix] refusing escalation-authoritative PR-fix work for the normal lane (#1503)", {
      repoFullName: candidate.repo,
      pullRequestNumber: candidate.pr,
      generation: candidate.generation,
      escalationLinked: "ESCALATED",
      correctedLane,
    });
    return { decision: "refuse", correctedLane };
  }
  return { decision: "eligible", correctedLane };
}
