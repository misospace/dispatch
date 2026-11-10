import { PrFixLane } from "@/types";
import { surfacePrFixRequeued } from "../pr-fix-surfacing";
import { resolveIngestionClaimant } from "../pr-fix-ownership";
import { type PrFixQueueClient } from "./client";
import { normalizeQueueRepo } from "./shared";
import { type RequeuePrFixInput } from "./inputs";
import { linkedIssueEscalationClassified, releaseLaneFromParentClass } from "./escalation-lane";
import { freshAttemptGeneration } from "./handout";

/**
 * Return a BLOCKED pr-fix item to QUEUED with its attempt counter reset, so
 * the loop works it again without needing a hand-pushed commit to retrigger.
 *
 * Accepts `FIXED` items too — the FIXED tombstone is untrusted when the PR
 * head didn't move, and the previously-recommended `mark_pr_fix status=blocked
 * → requeue_pr_fix` two-call recovery required lying about the state. A single
 * honest requeue is preferable (#940).
 *
 * Refuses if the upstream PR is already merged or closed — consistent with
 * `classify_pr_lifecycle` treating those as nothing-left-to-fix. The caller
 * passes `isPrMergedOrClosed` (computed upstream) so this stays a pure db op.
 */
export async function requeuePrFixItem(client: PrFixQueueClient, rawInput: RequeuePrFixInput) {
  const input: RequeuePrFixInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  if (input.isPrMergedOrClosed) {
    throw new Error("Cannot requeue: upstream PR is merged or closed");
  }
  if (input.isRepoArchived) {
    throw new Error("Cannot requeue: repository is archived");
  }

  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    if (!existing) return null;
    // Requeue acts on BLOCKED (a human decision), PARKED (bounded exhaustion
    // or an operational failure, #1218) and FIXED (recovery from a no-progress
    // tombstone, #940). STALE is rejected because the upstream PR is gone.
    if (existing.status !== "BLOCKED" && existing.status !== "PARKED" && existing.status !== "FIXED") {
      throw new Error(`Cannot requeue: item is ${existing.status}, not BLOCKED, PARKED, or FIXED`);
    }
    const reopenedFrom = existing.status;
    // #1503: an operator requeue returns the work to the dispatchable loop,
    // never to a lane the authoritative classification excludes. A row whose
    // linked issue is escalation-classified (including one parked/BLOCKED as
    // NEEDS_HUMAN — the human decision is done, the lane is not) re-enters at
    // ESCALATED; an ESCALATED row keeps its lane; everything else resets to
    // NORMAL exactly as before.
    // #1503 review, tri-state: an "UNKNOWN" parent (lookup failed) keeps the
    // row's EXISTING lane — no silent demotion to NORMAL on an unreadable
    // parent, and no unverified raise either; the hand-out gate re-reads at
    // issuance.
    const requeueEscalation = await linkedIssueEscalationClassified(tx, input.repo, existing.issue);
    const requeueLane: PrFixLane = releaseLaneFromParentClass(requeueEscalation, existing.lane);
    // #1569: requeue recovery for a row whose ORIGINAL CLAIMANT never
    // resolved — re-resolve from the authoritative records inside the same
    // transaction. Only computed while the claimant is still NULL; a
    // recorded claimant is never re-derived, refreshed, or transferred.
    const requeueClaimantPatch =
      existing.claimant == null
        ? await resolveIngestionClaimant(tx, input.repo, existing.issue, existing.author)
        : null;
    // #1569: the re-resolved claimant rides its OWN write, pinned on
    // `claimant IS NULL`, not the requeue payload — so a concurrent operator
    // stamp or issuance backfill in the gap cannot be overwritten or cleared
    // here, and only a RESOLVED value is ever recorded (an unresolved
    // observation leaves the source NULL rather than churning the row).
    if (requeueClaimantPatch !== null && requeueClaimantPatch.state === "resolved") {
      await tx.prFixQueueItem.updateMany({
        where: { id: existing.id, claimant: null },
        data: { claimant: requeueClaimantPatch.claimant, claimantSource: requeueClaimantPatch.source },
      });
    }
    const updated = await tx.prFixQueueItem.update({
      where: { id: existing.id },
      // Requeue hands the PR back to the worker loop as a fresh attempt —
      // bump the generation in the same update so consumers see a new work
      // identity rather than one they may already have deduplicated (#1044).
      // It is an operator reset, so the attempt count starts over (#1103).
      // Baseline the attempt from the last observed head: a null baseline
      // made the guard fall back to the mutable headSha, which the next sync
      // overwrites with the worker's own push (#1074, #1104).
      data: {
        status: "QUEUED",
        lane: requeueLane,
        // The operator release clears the BLOCKED/PARKED classification (#1218).
        outcome: null,
        decisionDetail: null,
        // #1253: the operator reset also clears the recovery bookkeeping —
        // the stale-disposition flag, the disposition audit stamp, and the
        // reactivation cooldown.
        staleDisposition: false,
        disposedAt: null,
        disposedEvidence: null,
        recoveryAppliedAt: null,
        ...freshAttemptGeneration(),
        fixAttempts: 1,
        // Operator reset: the consecutive-stagnation budget restarts too (#1543).
        stagnationCount: 0,
        attemptHeadSha: existing.headSha ?? null,
        // A fresh operator requeue must not carry post-dispatch evidence
        // recorded for a prior attempt (#1119), nor hand-out records that
        // would suppress the item's re-dispatch (#1133). The operator reset
        // also clears the stale-hand-out reclaim budget (#1211) — unlike an
        // automatic reclaim, which deliberately counts toward it.
        postDispatchEvidenceKeys: [],
        agentHandouts: [],
        externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
        handoutAcks: [],
        handoutAckTimes: [],
        handoutReceipts: [],
        handoutReclaims: 0,
      },
    });
    await tx.prFixHistory.create({
      data: {
        itemId: updated.id,
        action: "requeue",
        status: "QUEUED",
        lane: updated.lane,
        note:
          (input.note ? `${input.note} (reopened from ${reopenedFrom})` : `operator requeue from ${reopenedFrom}`) +
          (reopenedFrom === "FIXED" ? " — #940 recovery" : reopenedFrom === "PARKED" ? " — operator release of a parked item" : ""),
      },
    });
    return updated;
  });
  if (item) {
    // Best-effort cleanup: drop the needs-human label and fold the existing marker
    // comment into a concise requeued/active notice. Never blocks the requeue.
    await surfacePrFixRequeued(input.repo, input.pr, input.note ?? undefined).catch((error) => {
      console.error(`pr-fix-queue requeue cleanup error for ${input.repo}#${input.pr}:`, error);
    });
  }
  return item;
}
