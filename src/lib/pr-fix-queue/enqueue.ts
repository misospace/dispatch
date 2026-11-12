import { Prisma } from "@prisma/client";
import { normalizePrFixLane, normalizePrFixOutcome, normalizePrFixType, PrFixDecisionContext, PrFixLane, PrFixOutcome, PrFixStatus } from "@/types";
import { type PrFixUnblockOutcome, surfacePrFixBlocked, surfacePrFixParked, surfacePrFixUnblocked } from "../pr-fix-surfacing";
import { isPrFixEvidenceKind, type PrFixEvidenceKind } from "../pr-fix-evidence";
import { parseStoredExternalWait } from "../pr-fix-external-wait";
import { evaluateRecovery, recoveryCooldownMs, type RecoveryDecision } from "../pr-fix-recovery";
import { ingestionClaimantPatch, resolveIngestionClaimant } from "../pr-fix-ownership";
import { type PrFixQueueClient } from "./client";
import { maxPrFixReclaims, normalizeQueueRepo, uniqueAppend } from "./shared";
import { rebaseExecutorClaimantExclusion } from "./lane-admission";
import { type CreateLinkedPrFixInput, type EnqueuePrFixInput } from "./inputs";
import { linkedIssueEscalationClassified } from "./escalation-lane";
import { appendPostDispatchEvidenceEntry, buildPrFixBlockedContext, carriesLedgerFields, encodePostDispatchEvidenceKey, readEvidenceLedgerView, recordEvidenceTransition, type EvidenceLedgerView, type EvidenceObservation } from "./evidence";
import { attemptHeadAdvanced, maxPrFixStagnation } from "./external-wait";
import { freshAttemptGeneration } from "./handout";

/**
 * A GitHub Actions run/job URL: what the pre-#1098 ingestion stored as an
 * item URL for CI failures. Never valid item identity (#1118).
 */
const ACTIONS_RUN_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\//;

function isActionsRunUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && ACTIONS_RUN_URL.test(url);
}

/** The item URL an enqueue may write: never a CI job URL (#1098, #1118). */
function itemUrlFromInput(input: EnqueuePrFixInput): string | undefined {
  return input.url && !isActionsRunUrl(input.url) ? input.url : undefined;
}

// `url` is not part of this patch (#1098): the item URL is identity (the PR
// URL) — set at first enqueue, backfilled only while empty. A CI-failure
// re-enqueue's job URL must not flip it; job links belong in feedback/
// evidence (pr-followup-ingestion), not the item URL.
function metadataPatch(input: EnqueuePrFixInput): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({
    issue: input.issue ?? undefined,
    branch: input.branch ?? undefined,
    title: input.title ?? undefined,
    headSha: input.headSha ?? undefined,
    author: input.author ?? undefined,
  })) {
    if (value !== undefined && value !== null && value !== "") patch[key] = value as string | number;
  }
  return patch;
}

export async function enqueuePrFixItem(client: PrFixQueueClient, rawInput: EnqueuePrFixInput) {
  // Fold the repo before any read or write: `(repo, pr)` is the ownership key
  // and must not depend on the caller's casing (#1145).
  const input: EnqueuePrFixInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  const lane = normalizePrFixLane(input.lane);
  const type = normalizePrFixType(input.type);
  // #1503: the linked issue's authoritative escalation classification is
  // resolved once per enqueue, BEFORE the transaction (the issue row is a
  // separate aggregate; the hand-out gate re-checks it at every issuance, so
  // a parent reclassifying inside this read→write window is refused there —
  // and a correction this enqueue races can simply be re-applied by the next
  // observation).
  // #1503 review, tri-state: "UNKNOWN" (unavailable lookup) conservatively
  // KEEPS the supplied lane — enqueue is an ingestion-side convenience, and
  // the stored-ESCALATED arm in buildUpdate still protects already-raised
  // rows — while "ESCALATED" raises a NORMAL lane and "NOT_ESCALATED" leaves
  // it exactly as supplied.
  // REBASE is the declared mechanical exception (#1327): its exclusivity is
  // the DISPATCH_REBASE_AGENTS local-only pool, and raising a merge-conflict
  // row's lane would strand it with no eligible worker.
  const escalation =
    type !== "REBASE" && (await linkedIssueEscalationClassified(client, input.repo, input.issue));
  // #1569: ORIGINAL CLAIMANT resolution runs once per enqueue, alongside the
  // lane classification: linked issue → live Lease / single `agent/*` label /
  // single `owner/*` label; no linked issue → PR author login. The value is
  // WRITTEN AT CREATION and only ever BACKFILLED on an update while the
  // row's claimant is still NULL — a recorded claimant (any provenance,
  // "operator" included) is never transferred, refreshed, or cleared by
  // re-ingestion, so a later owner change or lane flip cannot move existing
  // PR ownership.
  // #1615: on a non-REBASE item the rebase-executor pool (DISPATCH_REBASE_AGENTS)
  // is not claimant evidence — the rebase executor is not a fix-work owner —
  // so its name (agent label or a live lease) falls through to the next
  // source instead of propagating a claimant no fix connector can own.
  const claimantResolution = await resolveIngestionClaimant(
    client,
    input.repo,
    input.issue,
    input.author,
    undefined,
    rebaseExecutorClaimantExclusion(type),
  );
  const claimantPatch = ingestionClaimantPatch(claimantResolution);
  // A NORMAL classification may be raised to the exclusive escalation lane by
  // the linked issue; it never lowers ESCALATED, and it never touches a
  // NEEDS_HUMAN human hold (BLOCKED stops dispatch anyway).
  const authoritativeLane: PrFixLane =
    escalation === "ESCALATED" && lane === "NORMAL" ? "ESCALATED" : lane;
  const nextStatus: PrFixStatus = authoritativeLane === "NEEDS_HUMAN" ? "BLOCKED" : "QUEUED";

  let previousStatus: PrFixStatus | undefined;
  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    // Deliberately the FIRST-read status: the #1134 pinned loop may re-decide
    // from fresher snapshots, and the post-transaction BLOCKED-surfacing
    // comparison keeps its pre-#1134 meaning.
    previousStatus = existing?.status;
    // #1569: backfill the ORIGINAL CLAIMANT on an EXISTING row as its own
    // write, pinned on `claimant IS NULL` — never folded into the decision
    // payload. The pin is what makes this safe against the recovery paths:
    // an operator stamp (`POST /api/pr-fix-queue/claimant`) or an
    // issuance-side backfill committing in this read→write gap wins, and a
    // re-ingestion can then neither transfer NOR clear a recorded claimant
    // (a failure-state resolution would otherwise write `claimant: null`
    // over it). Only a RESOLVED value is ever written here: an unresolved
    // observation leaves the row's source NULL ("legacy") instead of
    // churning the row or recording a transient read failure as provenance.
    if (existing && existing.claimant == null && claimantResolution.state === "resolved") {
      await tx.prFixQueueItem.updateMany({
        where: { id: existing.id, claimant: null },
        data: { claimant: claimantResolution.claimant, claimantSource: claimantResolution.source },
      });
    }
    // One wall-clock instant per enqueue decision (#1253): every
    // disposition stamp (`disposedAt`) and reactivation stamp
    // (`recoveryAppliedAt`) this decision writes uses the same `now`, so the
    // pinned-loop re-derivations stay internally consistent instead of
    // drifting per loop iteration.
    const now = new Date();
    if (existing) {
      // buildUpdate: the per-snapshot decision + write payload. Everything the
      // write and the history row depend on is derived from ONE row snapshot,
      // so the #1134 pinned-write loop below can re-derive it from a fresh
      // read instead of replaying a stale decision.
      const buildUpdate = (snapshot: any, ledgerView: EvidenceLedgerView) => {
        // Evidence this item has already recorded must not move it back to
        // QUEUED. The sync re-reads every open PR each sweep, so an event that
        // never goes away — an undismissed CHANGES_REQUESTED review, a comment
        // — otherwise resurrects the item after every resolution and dispatches
        // a coder again 15 minutes later. Observed on misospace/pinchflat#25.
        //
        // The enqueue is still recorded in history: knowing the sync re-observed
        // the evidence is useful, and it is the status flip that causes the
        // churn. New evidence flows through normally.
        //
        // One exception (#940): a `FIXED` item whose PR head hasn't moved since
        // enqueue must be reopened, because the FIXED tombstone is untrusted —
        // a workload reported success without pushing a fix. This is the safety
        // net for the case where markPrFixItem's head-SHA guard ran with
        // missing data or before this re-detection loop kicked in.
        //
        // #1249: when the enqueue carries durable evidence fields, KNOWN means
        // the ledger holds this identity at an UNCHANGED version — not mere
        // membership in the bounded 40-entry cache. A replay of recorded
        // evidence stays inert after eviction (the design's control 8), a new
        // VERSION of a known identity is new evidence (review state change),
        // a new identity repeating an already-recorded signature is recorded
        // but not actionable on its own (control 3/7), and a non-actionable
        // version (dismissed review, cleared condition) is recorded and kept
        // sticky (control 4). Without ledger fields the pre-#1249
        // identity-only cache semantics stand.
        const evidenceKind: PrFixEvidenceKind | null = isPrFixEvidenceKind(input.evidenceKind)
          ? input.evidenceKind
          : null;
        // Condition kinds are persistent states, not one-shot observations:
        // their baseline is the durable per-condition ledger row, and a
        // re-read of the SAME (state, head) must never reopen — even at FIXED
        // with an unchanged head, where the #940 net reopens one-shot evidence
        // (design control 19: a persistent old `dirty` re-discovered after
        // eviction, dispositioned by unrelated review R, stays closed).
        const isConditionKind = evidenceKind === "merge_state" || evidenceKind === "merge_conflict";
        const cacheKnown = !!input.evidenceKey && (snapshot.evidenceKeys ?? []).includes(input.evidenceKey);
        const identityKnown = !!input.evidenceKey && (!!ledgerView?.prior || cacheKnown);
        const versionUnchanged =
          !!input.evidenceKey &&
          (ledgerView?.prior
            ? ledgerView.prior.version === (input.evidenceVersion ?? "")
            : cacheKnown);
        // Repeated text: a NEW identity whose content signature was already
        // recorded under another identity at the same commit. An already-known
        // identity repeating itself is the duplicate-version case below, not
        // this one.
        const isRepeatedText = !!ledgerView?.repeatedSignature && !ledgerView?.prior;
        const isNonActionableVersion = input.evidenceActionable === false;
        const isKnownEvidence = versionUnchanged || isRepeatedText || isNonActionableVersion;
        const headShaUnchanged =
          snapshot.status === "FIXED" &&
          !!snapshot.headSha &&
          typeof input.headSha === "string" &&
          snapshot.headSha === input.headSha;
        // #1303: the #940 net reopens on re-observed ACTIONABLE evidence only.
        // A non-actionable version of a known identity (`evidenceActionable
        // === false`, e.g. a re-read review in an APPROVED/DISMISSED/COMMENTED
        // state) at a FIXED/unchanged head falls through to the sticky
        // `isKnownEvidence` branch (control 4) — the tombstone stays closed.
        const reopenFixStale =
          identityKnown && headShaUnchanged && !isConditionKind && !isNonActionableVersion;

        // #1575: a REBASE conflict episode is closed by the conflict CLEARING
        // (`clearResolvedConflictItems`), not by an attempt settling. A re-read
        // CONFLICTING observation of the same (identity, version) at a FIXED
        // tombstone therefore is not settled "known evidence": the earlier
        // attempt left the PR exactly as conflicted as it found it (the head
        // never moves — the BASE advanced), and the sticky arm kept the row
        // closed while the rebase lane starved. Reopen it as a fresh attempt.
        // The loop stays bounded by every existing guard: only FIXED reaches
        // here (terminal STALE/IGNORED are sticky above, PARKED/BLOCKED/
        // WAITING_EXTERNAL route through `evaluateRecovery`, and an unchanged
        // condition on an already-QUEUED row stays the same attempt); the head
        // has not advanced, so the #1543 stagnation budget below counts this
        // reopen and parks at the cap instead of churning; and the pinned
        // generation write rejects decisions computed from a row that moved
        // under us.
        const rebaseEpisodeOpen =
          type === "REBASE" &&
          snapshot.status === "FIXED" &&
          input.evidenceActionable === true;

        // STALE/IGNORED stay sticky inline (#1000): terminal states never
        // reactivate on evidence and are operator-only, so they are kept OUT
        // of the recovery module's decision path entirely. The three
        // dispositions below (BLOCKED human hold, PARKED operational hold,
        // WAITING_EXTERNAL) DO route through `evaluateRecovery` (#1253):
        // fresh actionable evidence may reactivate an operational hold
        // (rows 8/13) and must surface as a stale disposition on the holds
        // evidence must not override (rows 9/10/11/16).
        const isTerminalStatus =
          snapshot.status === "STALE" ||
          snapshot.status === "IGNORED";
        const isDispositionedStatus =
          snapshot.status === "BLOCKED" ||
          snapshot.status === "PARKED" ||
          snapshot.status === "WAITING_EXTERNAL";

        // #1253: fresh actionable evidence = a NEW ledger transition that is
        // actionable by kind. `isKnownEvidence` already covers
        // version-unchanged replays, repeated review text, and
        // non-actionable versions; the explicit `evidenceActionable !==
        // false` guard keeps the predicate self-contained even if the
        // isKnownEvidence composition changes.
        const freshEvidence = !isKnownEvidence && input.evidenceActionable !== false;
        const recovery: RecoveryDecision | null = isDispositionedStatus
          ? evaluateRecovery({
              status: snapshot.status,
              outcome: snapshot.outcome ?? null,
              stagnationCount: snapshot.stagnationCount,
              handoutReclaims: snapshot.handoutReclaims,
              hasValidExternalWait:
                snapshot.status === "WAITING_EXTERNAL" ? !!parseStoredExternalWait(snapshot.externalWait) : false,
              freshEvidence,
              // #1253 control 8: a REACTIVATION requires durable-ledger
              // provenance — an observation the pre-#1249 cache semantics
              // call fresh but no ledger row recorded cannot mint one. The
              // HOLD + stale-flag rows keep working on the cache semantics.
              ledgerProvenance: ledgerView.records,
              now,
              disposedAt: snapshot.disposedAt ?? null,
              recoveryAppliedAt: snapshot.recoveryAppliedAt ?? null,
              maxStagnation: maxPrFixStagnation(),
              maxReclaims: maxPrFixReclaims(),
              cooldownMs: recoveryCooldownMs(),
            })
          : null;

        const nextEvidenceKeys = uniqueAppend(snapshot.evidenceKeys ?? [], input.evidenceKey, 40);

        let resolvedStatus: PrFixStatus;
        let resolvedLane: PrFixLane = authoritativeLane;
        let statusNote: string | null = null;
        let resolvedOutcome: PrFixOutcome | null = null;
        let resolvedDecision: PrFixDecisionContext | null = null;
        let recoveryNote: string | null = null;
        if (isTerminalStatus) {
          resolvedStatus = snapshot.status; // sticky — never resurrect a gone PR
          // Preserve the stored lane: a sticky terminal item keeps its lane,
          // regardless of the enqueue's lane argument (#1218).
          resolvedLane = snapshot.lane ?? resolvedLane;
        } else if (recovery?.action === "reactivate") {
          // #1253 row 8/13: fresh actionable evidence reopens an operational
          // hold as a QUEUED fresh attempt. The lane is preserved from the
          // snapshot when it is NORMAL, else NORMAL — evidence must never
          // manufacture a human lane (never NEEDS_HUMAN).
          resolvedStatus = "QUEUED";
          resolvedLane = snapshot.lane === "NEEDS_HUMAN" ? "NORMAL" : (snapshot.lane ?? "NORMAL");
          recoveryNote = recovery.reason;
        } else if (recovery) {
          // #1253 hold rows (16/9/10/11/15/19-via-inline): the disposition
          // stands. `setStaleDisposition` surfaces fresh evidence without
          // reopening; a hold without the flag leaves the row untouched
          // apart from the evidence recording shared below.
          resolvedStatus = snapshot.status; // sticky
          resolvedLane = snapshot.lane ?? resolvedLane;
          if (recovery.setStaleDisposition) recoveryNote = recovery.reason;
        } else if (reopenFixStale) {
          resolvedStatus = nextStatus; // #940 recovery from a no-progress FIXED tombstone
        } else if (isKnownEvidence && rebaseEpisodeOpen) {
          resolvedStatus = nextStatus; // #1575: a still-conflicting PR re-enters the rebase lane
        } else if (isKnownEvidence) {
          resolvedStatus = snapshot.status; // #25 anti-churn: repeat evidence never flips status
        } else {
          resolvedStatus = nextStatus;
        }

        // Guard the fix loop (#1543, replacing the retired lifetime
        // PR_FIX_MAX_ATTEMPTS cap of #1001). Only a transition back to QUEUED
        // opens a new attempt — more evidence on already-QUEUED work (the rest
        // of one review's inline comments) is the same attempt and never
        // counts (#1103). Progress is proven ONLY from durable source state:
        // the observed head advancing past the consumed attempt's baseline
        // (`attemptHeadSha`, legacy `headSha` fallback). A progressing loop
        // resets the stagnation budget and iterates for as many rounds as it
        // needs; a loop that keeps burning attempts without advancing the head
        // exhausts the consecutive-stagnation budget and PARKS (#1218) —
        // bounded exhaustion, not a human decision, so it never carries the
        // needs-human label. This check runs AFTER the recovery decision
        // (#1253): a budget-available reactivation that lands at the
        // stagnation cap parks here with the stale-disposition flag (row 9
        // semantics — the fresh evidence that justified the reopen is still
        // unaddressed and must surface to the operator).
        let capParked = false;
        let stagnationCountWrite: number | undefined;
        if (resolvedStatus === "QUEUED" && snapshot.status !== "QUEUED") {
          if (attemptHeadAdvanced(input.headSha, snapshot.attemptHeadSha ?? snapshot.headSha)) {
            stagnationCountWrite = 0; // proven progress resets the budget (#1543)
          } else {
            const nextStagnation = (snapshot.stagnationCount ?? 0) + 1;
            if (nextStagnation >= maxPrFixStagnation()) {
              resolvedStatus = "PARKED";
              resolvedLane = "NORMAL";
              resolvedOutcome = normalizePrFixOutcome(input.outcome) ?? "no_progress";
              statusNote = `Stagnation budget exhausted: ${nextStagnation} consecutive attempts with no head advancement (PR_FIX_MAX_STAGNATION=${maxPrFixStagnation()}); parked instead of re-queuing (#1543, replaces the retired #1001 attempt cap).`;
              capParked = true;
            }
            stagnationCountWrite = nextStagnation;
          }
        }

        // #1503: escalation-lane exclusivity is authoritative over this
        // enqueue's lane argument (and over the cap-park NORMAL reset above,
        // whose intent was only "not a human lane"). A row whose linked issue
        // is escalation-classified, or that already carries ESCALATED, never
        // lands back on NORMAL through a generic re-enqueue: that is how a
        // frontier parent's review fix fell into the shared normal queue.
        // Terminal sticky rows keep their stored lane; NEEDS_HUMAN human
        // holds are untouched; REBASE is the declared mechanical exception.
        if (
          !isTerminalStatus &&
          type !== "REBASE" &&
          resolvedLane === "NORMAL" &&
          (escalation === "ESCALATED" || snapshot.lane === "ESCALATED")
        ) {
          resolvedLane = "ESCALATED";
          const raiseReason =
            escalation === "ESCALATED"
              ? `linked issue #${input.issue} is escalation-classified`
              : "the row already carries the exclusive escalation lane";
          statusNote = statusNote
            ? `${statusNote} Lane held at ESCALATED: ${raiseReason} (#1503).`
            : `Lane held at ESCALATED: ${raiseReason} (#1503).`;
        }

        if (resolvedStatus === "BLOCKED") {
          resolvedOutcome = "human_decision";
          resolvedDecision = input.decision ?? snapshot.decisionDetail ?? null;
        } else if (resolvedStatus === "PARKED") {
          resolvedOutcome =
            resolvedOutcome ??
            normalizePrFixOutcome(input.outcome) ??
            normalizePrFixOutcome(snapshot.outcome) ??
            "no_progress";
        }

        // A transition from a non-QUEUED status back to QUEUED is a fresh
        // dispatchable attempt — new work a worker should run — so the item's
        // work-generation identity must change (#1044). Staying QUEUED (e.g.
        // additional evidence on already-pending work) is the same attempt and
        // must keep the identity stable.
        const isFreshAttempt = resolvedStatus === "QUEUED" && snapshot.status !== "QUEUED";

        // Evidence that arrives AFTER this generation was handed to a worker
        // cannot reach the worker already running on it, so record it in
        // postDispatchEvidenceKeys: settlement must open a fresh attempt
        // instead of absorbing it into the in-flight one (#1119).
        // Evidence arriving before hand-out (dispatchedGeneration !==
        // generation, or never dispatched) still joins the same attempt, as
        // before.
        const dispatchedThisGeneration =
          snapshot.dispatchedGeneration != null && snapshot.dispatchedGeneration === snapshot.generation;
        const isPostDispatchNewEvidence =
          !isTerminalStatus &&
          !isKnownEvidence &&
          snapshot.status === "QUEUED" &&
          dispatchedThisGeneration;

        // #1249: a NEW identity, or a version change of a known identity, is a
        // durable ledger transition and claims the next per-item sequence from
        // the SAME snapshot this write is computed on (the pinned loop
        // re-derives it on a contention retry). Re-recording a stored
        // (identity, version) — replayed webhook, at-least-once redelivery,
        // periodic re-read — is inert here: no increment, no restamp.
        const isNewLedgerTransition =
          ledgerView.records &&
          (!ledgerView.prior || ledgerView.prior.version !== (input.evidenceVersion ?? ""));
        const assignedEvidenceSequence = (snapshot.evidenceSequence ?? 0) + 1;

        const data = {
          lane: resolvedLane,
          type,
          status: resolvedStatus,
          reason: input.reason,
          feedback: uniqueAppend(snapshot.feedback ?? [], input.feedback, 12),
          evidenceKeys: nextEvidenceKeys,
          // #1098: the item URL is identity — write-once. Backfill it only
          // while empty; never overwrite an existing URL with a re-enqueue's
          // value (e.g. a CI job URL). A stored CI job URL left by the
          // pre-#1098 ingestion counts as empty, so it heals on the next
          // enqueue instead of being frozen by the guard (#1118).
          ...((!snapshot.url || isActionsRunUrl(snapshot.url)) && itemUrlFromInput(input)
            ? { url: itemUrlFromInput(input) }
            : {}),
          // A fresh attempt gets a fresh per-attempt head baseline (#1074):
          // the head the sync observed in THIS enqueue, else the last one
          // observed (#1104). metadataPatch below keeps refreshing the mutable
          // `headSha` as before — the two columns now mean different things.
          ...(isFreshAttempt
            ? {
                ...freshAttemptGeneration(),
                fixAttempts: { increment: 1 },
                // #1543: the consumed attempt's progress classification —
                // 0 after proven head advancement, the incremented
                // consecutive-stagnation count otherwise.
                ...(stagnationCountWrite !== undefined ? { stagnationCount: stagnationCountWrite } : {}),
                attemptHeadSha: input.headSha ?? snapshot.headSha ?? null,
              }
            : {}),
          // Post-dispatch evidence (#1119): record the key that landed on a
          // dispatched QUEUED item, encoded with the enqueue's observed head
          // (or "unknown") so a check entry can be revalidated at settle time.
          // A fresh attempt resets the list. Mutually exclusive with
          // isFreshAttempt (one requires QUEUED, the other not). Past 20
          // entries appendPostDispatchEvidenceEntry evicts the oldest
          // NON-actionable entry (review/comment entries survive eviction).
          ...(isPostDispatchNewEvidence
            ? {
                postDispatchEvidenceKeys: appendPostDispatchEvidenceEntry(
                  snapshot.postDispatchEvidenceKeys ?? [],
                  encodePostDispatchEvidenceKey(input.evidenceKey, input.headSha),
                  20,
                ),
              }
            : {}),
          // A fresh attempt resets the post-dispatch list AND the per-agent
          // hand-out records: the prior generation's records are dead either
          // way, and the skip check must match only the current identity
          // (#1119, #1133, #1211). It also clears the #1253 recovery
          // bookkeeping — the stale-disposition flag and the disposition
          // audit stamp — so ANY fresh attempt (not just a recovery
          // reactivation; e.g. the #940 reopen of a previously-flagged FIXED
          // row) starts clean.
          ...(isFreshAttempt
            ? {
                postDispatchEvidenceKeys: [],
                agentHandouts: [],
                externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
                handoutAcks: [],
                handoutAckTimes: [],
                handoutReceipts: [],
                staleDisposition: false,
                disposedAt: null,
                disposedEvidence: null,
              }
            : {}),
          // Structured outcome (#1218): recorded on the same write as the
          // status. Only BLOCKED/PARKED carry one; decisionDetail is persisted
          // only for a human-decision BLOCKED.
          ...(resolvedOutcome ? { outcome: resolvedOutcome } : {}),
          ...(resolvedStatus === "BLOCKED" && resolvedDecision ? { decisionDetail: resolvedDecision } : {}),
          // #1253: a recovery reactivation sheds the disposition it was held
          // under. `retryAt`/`externalWait`/`recoveryAppliedAt`/
          // `staleDisposition` apply EVEN when the cap check above flipped
          // the row to PARKED (the later `capParked` spread re-sets
          // staleDisposition true — spread order makes it win);
          // `outcome`/`decisionDetail` only clear on an actual fresh attempt
          // so the cap park's `no_progress` outcome survives.
          ...(recovery?.action === "reactivate"
            ? {
                retryAt: null,
                externalWait: Prisma.DbNull,
                recoveryAppliedAt: now,
                staleDisposition: false,
                ...(isFreshAttempt ? { outcome: null, decisionDetail: null } : {}),
              }
            : {}),
          // #1253: a hold whose fresh evidence must be surfaced writes the
          // stale-disposition flag without touching status; a cap park (row
          // 9 semantics — the fresh evidence that forced the reopen is still
          // unaddressed) flags too.
          ...(recovery?.action === "hold" && recovery.setStaleDisposition ? { staleDisposition: true } : {}),
          ...(capParked ? { staleDisposition: true } : {}),
          // #1543: the stagnation-exhaustion park records the exhausted
          // count so queue/observability show how the budget was spent.
          ...(capParked && stagnationCountWrite !== undefined ? { stagnationCount: stagnationCountWrite } : {}),
          // #1253: disposition stamps — written only when THIS decision
          // transitions the row INTO a disposition from a different status.
          // Idempotent sticky re-marks (the sync's duplicate enqueues onto a
          // held row) never restamp, so they cannot keep pushing a PARKED
          // item's recovery-cooldown anchor forward. Audit-only: never a
          // freshness predicate (#1249).
          ...((resolvedStatus === "PARKED" || resolvedStatus === "BLOCKED") && snapshot.status !== resolvedStatus
            ? { disposedAt: now, disposedEvidence: input.evidenceKey || null }
            : {}),
          // #1249: the ledger row itself is upserted AFTER the (pinned) item
          // write succeeds, with `assignedEvidenceSequence`; the item only
          // carries the atomic counter bump here.
          ...(isNewLedgerTransition ? { evidenceSequence: { increment: 1 } } : {}),
          ...metadataPatch(input),
        };

        return {
          data,
          statusNote,
          reopenFixStale,
          outcome: resolvedOutcome,
          isNewLedgerTransition,
          assignedEvidenceSequence,
          recoveryNote,
          // #1134: the append above is computed from THIS snapshot's key list,
          // so the write must be pinned on exactly that list. The
          // isFreshAttempt reset-to-[] is mutually exclusive with the append
          // and is deliberately NOT pinned.
          pinnedKeys: isPostDispatchNewEvidence ? (snapshot.postDispatchEvidenceKeys ?? []) : null,
          // #1249: a ledger transition claims `assignedEvidenceSequence` from
          // THIS snapshot, so the write is also pinned on the counter value it
          // was derived from — a concurrent transition landing in the gap
          // misses the pin (the atomic increment moved the counter) and the
          // re-decide loop recomputes both the decision and the sequence from
          // the fresh row instead of double-issuing or skipping a sequence.
          pinnedEvidenceSequence: isNewLedgerTransition ? (snapshot.evidenceSequence ?? 0) : null,
          // #1253: a decision computed from a NON-QUEUED snapshot (a sticky
          // hold, a recovery reactivation, FIXED tombstone handling) is also
          // pinned on the generation it decided from — a concurrent
          // requeue/settlement that bumped the generation in the read→write
          // gap misses the pin and the loop re-decides from the fresh row.
          pinnedGeneration: snapshot.status !== "QUEUED" ? (snapshot.generation ?? null) : null,
        };
      };

      // #1134: a plain `update` computed from the read at the top of this
      // branch would clobber a concurrent post-dispatch append that commits in
      // the read→write gap — one entry escapes flagging. So when the write
      // appends post-dispatch evidence, it is pinned on the exact
      // `postDispatchEvidenceKeys` snapshot it read (mirroring markPrFixItem's
      // settle-side pin): a concurrent append in the gap misses the pin, and a
      // bounded in-transaction re-decide re-reads and re-derives EVERY decision
      // (status/lane/attempts/postDispatch) from the fresh row instead of
      // dropping the entry. No network call runs in this loop, so the #1124
      // transaction-timeout hazard does not apply.
      const maxPinnedEnqueueWrites = 3;
      let snapshot = existing;
      let ledgerView = await readEvidenceLedgerView(tx, existing.id, input);
      let decided = buildUpdate(snapshot, ledgerView);
      let updated: any;
      // True when the exhausted-loop fallback below wrote the item without its
      // pins; suppresses the ledger record for that write (see there).
      let unpinnedLedgerWrite = false;
      if (
        decided.pinnedKeys !== null ||
        decided.pinnedEvidenceSequence !== null ||
        decided.pinnedGeneration !== null
      ) {
        let pinnedKeys: string[] | null = decided.pinnedKeys;
        let pinnedEvidenceSequence: number | null = decided.pinnedEvidenceSequence;
        let pinnedGeneration: number | null = decided.pinnedGeneration;
        for (let i = 0; i < maxPinnedEnqueueWrites; i += 1) {
          const { count } = await tx.prFixQueueItem.updateMany({
            where: {
              id: existing.id,
              ...(pinnedKeys !== null ? { postDispatchEvidenceKeys: { equals: pinnedKeys } } : {}),
              ...(pinnedEvidenceSequence !== null ? { evidenceSequence: pinnedEvidenceSequence } : {}),
              ...(pinnedGeneration !== null ? { generation: pinnedGeneration } : {}),
            },
            data: decided.data,
          });
          if (count === 1) {
            updated = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
            break;
          }
          // The pin missed: a concurrent append, ledger transition, or
          // generation bump (requeue/settlement) landed in the read→write gap
          // (or the row was deleted). Re-read in-transaction and re-decide
          // from the fresh snapshot — no decision is reused from the stale
          // read.
          const fresh = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
          // Row deleted mid-loop: stop re-deciding; the exhausted-loop fallback
          // below runs its plain `update`, which surfaces Prisma's P2025 exactly
          // like the pre-#1134 path did for a deleted row.
          if (!fresh) break;
          snapshot = fresh;
          // Re-read the ledger alongside the fresh row so a concurrent
          // transition that landed in the gap re-decides known/version
          // instead of replaying the stale ledger snapshot's decision.
          ledgerView = await readEvidenceLedgerView(tx, existing.id, input);
          decided = buildUpdate(fresh, ledgerView);
          // Pin the retry against the key list / counter value / generation
          // the NEW write was computed from, so a further gap write no-ops it
          // the same way.
          pinnedKeys = decided.pinnedKeys;
          pinnedEvidenceSequence = decided.pinnedEvidenceSequence;
          pinnedGeneration = decided.pinnedGeneration;
        }
        if (updated === undefined) {
          // The pin kept missing under sustained contention, or the row was
          // deleted mid-loop (then this plain `update` throws P2025, as the
          // pre-#1134 path did). Otherwise: fall back to ONE plain unpinned
          // write from the last recomputed snapshot. This degrades to the
          // pre-#1134 worst case (a concurrent entry in the final gap can
          // still be clobbered) only when the gap loses 3 writes in a row; no
          // network call runs in here, so the #1124 transaction-timeout hazard
          // does not apply. The same degradation now also applies to the
          // operator-facing staleDisposition/recoveryAppliedAt stamps a
          // concurrent decision tried to write — bounded, and self-healing on
          // the next observation.
          await tx.prFixQueueItem.update({ where: { id: existing.id }, data: decided.data });
          updated = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
          // #1249: the counter this write bumped belongs to a row nobody pinned,
          // so `assignedEvidenceSequence` is not a position this transaction
          // actually claimed. Recording the ledger row at it could MOVE an
          // existing identity's row backwards (a re-versioned row now restamps
          // its sequence), i.e. bury fresh evidence below a live watermark.
          // Skipping is self-healing: the next observation of this identity
          // still sees the stored version and records the transition then.
          unpinnedLedgerWrite = true;
        }
      } else {
        // No post-dispatch append: the write does not touch the key list, so it
        // stays a plain update, exactly as before #1134.
        updated = await tx.prFixQueueItem.update({ where: { id: existing.id }, data: decided.data });
      }

      // #1249: the durable ledger transition rides the SAME transaction as the
      // item write it was decided from — a rolled-back write rolls back the
      // ledger row, and a committed decision can never miss its ledger row
      // ("concurrent settlement vs enqueue cannot discard an observation").
      // Exception: the unpinned exhausted-loop fallback above, where the write
      // claims no sequence this transaction can vouch for.
      if (decided.isNewLedgerTransition && !unpinnedLedgerWrite) {
        await recordEvidenceTransition(
          tx,
          existing.id,
          input,
          decided.assignedEvidenceSequence,
          ledgerView.repeatedSignature,
        );
      }

      const historyData: Record<string, unknown> = {
        itemId: updated.id,
        action: "enqueue",
        lane: updated.lane,
        reason: input.reason,
        evidenceKey: input.evidenceKey,
      };
      if (decided.outcome) historyData.outcome = decided.outcome;
      if (decided.reopenFixStale) {
        historyData.note = `Reopened: PR head SHA unchanged since FIXED (${snapshot.headSha}); re-detected evidence on a no-progress tombstone (#940).`;
      } else if (decided.statusNote && decided.recoveryNote) {
        // #1253: a cap-flipped reactivation carries BOTH notes — the
        // recovery rationale and the cap park — composed deterministically
        // (recovery reason first) instead of one shadowing the other.
        historyData.note = `${decided.recoveryNote} ${decided.statusNote}`;
      } else if (decided.statusNote) {
        historyData.note = decided.statusNote;
      } else if (decided.recoveryNote) {
        // #1253: the recovery decision's rationale (reactivation or
        // stale-disposition surfacing) is the audit note.
        historyData.note = decided.recoveryNote;
      }
      await tx.prFixHistory.create({ data: historyData });
      return updated;
    }

    // A brand-new item's first durable observation opens the ledger at
    // sequence 1 (#1249); legacy enqueues without evidence fields stay 0.
    const createsEvidenceLedger = !!tx.prFixEvidence && carriesLedgerFields(input);
    const created = await tx.prFixQueueItem.create({
      data: {
        repo: input.repo,
        pr: input.pr,
        lane: authoritativeLane,
        type,
        status: nextStatus,
        reason: input.reason,
        feedback: [input.feedback],
        evidenceKeys: [input.evidenceKey],
        ...(createsEvidenceLedger ? { evidenceSequence: 1 } : {}),
        // #1098: the item URL is identity (the PR URL) — set it at first
        // enqueue, explicitly, so it is never left to the update patch.
        ...(itemUrlFromInput(input) ? { url: itemUrlFromInput(input) } : {}),
        // A brand-new item is a fresh attempt: capture the head the sync
        // observed now as its immutable per-attempt baseline (#1074).
        attemptHeadSha: input.headSha ?? null,
        // A brand-new NEEDS_HUMAN enqueue is a genuine human decision (#1218).
        ...(nextStatus === "BLOCKED"
          ? { outcome: "human_decision", ...(input.decision ? { decisionDetail: input.decision } : {}) }
          : {}),
        // #1569: a brand-new row records its ORIGINAL CLAIMANT (or its
        // failure state "missing"/"ambiguous") at creation. A FAILED fact read
        // records nothing: the row stays source-NULL ("legacy", unresolved and
        // therefore never auto-handed out) and re-resolves on the next
        // observation, so a transient error is never stored as provenance.
        // Provenance and missing-value behavior: docs/pr-fix-ownership-contract.md.
        ...claimantPatch,
        ...metadataPatch(input),
      },
    });
    if (createsEvidenceLedger) {
      await recordEvidenceTransition(tx, created.id, input, 1);
    }
    await tx.prFixHistory.create({
      data: {
        itemId: created.id,
        action: "enqueue",
        lane: created.lane,
        reason: input.reason,
        evidenceKey: input.evidenceKey,
        ...(nextStatus === "BLOCKED" ? { outcome: "human_decision" } : {}),
      },
    });
    return created;
  });

  const wasBlocked = previousStatus === "BLOCKED";
  const wasParked = previousStatus === "PARKED";
  if (item.status === "BLOCKED" && !wasBlocked) {
    const context = await buildPrFixBlockedContext(client, item);
    await surfacePrFixBlocked({
      repo: input.repo,
      pr: input.pr,
      reason: item.reason,
      latestNote: null,
      context,
      decision: item.decisionDetail ?? input.decision ?? null,
    });
  } else if (item.status === "PARKED" && !wasParked) {
    const context = await buildPrFixBlockedContext(client, item);
    await surfacePrFixParked({
      repo: input.repo,
      pr: input.pr,
      reason: item.reason,
      outcome: item.outcome ?? "no_progress",
      latestNote: null,
      context,
    });
  } else if ((wasBlocked || wasParked) && (item.status === "QUEUED" || item.status === "FIXED")) {
    await retractNeedsHuman(input.repo, input.pr, item.status === "FIXED" ? "resolved" : "requeued", "New evidence reopened this item.");
  }
  return item;
}

/**
 * Record a durable ledger transition for an observation that enqueues NO work
 * (#1276), and report whether one was recorded.
 *
 * A review that moves CHANGES_REQUESTED → APPROVED/DISMISSED/COMMENTED is a
 * real observation of the same identity: the ledger must learn that the
 * actionable baseline is gone, or the item keeps a stale actionable version
 * forever. Ingestion previously dropped every non-CHANGES_REQUESTED review, so
 * that transition was never delivered and never recorded.
 *
 * Deliberately NOT an enqueue, in every respect that matters:
 * - no item is created, and no item's status / lane / feedback / outcome /
 *   generation / fixAttempts is touched — the only item write is the atomic
 *   `evidenceSequence` counter bump that claims the ledger row's position;
 * - no `prFixHistory` row: the ledger row IS the audit record for this
 *   transition, and an `enqueue` history row would report work that was never
 *   enqueued (and re-trigger the needs-human/parked surfacing in
 *   `enqueuePrFixItem`, which this path must never do);
 * - no item → no write at all (false). An observation for a PR with no queue
 *   item has nothing to attach a ledger row to, and creating an item here would
 *   manufacture work out of a state transition.
 * - no status filter. A transition is recorded wherever the item currently
 *   sits, and that is deliberate: a settled/awaiting item carries no attempt,
 *   and every terminal disposition clears `attemptEvidenceWatermark`, so its
 *   durable read is empty and a recorded dismissal provably cannot reopen it.
 *   The row is still what makes the review's verdict durable — it is the
 *   baseline a later operator requeue (fresh attempt) and the periodic
 *   reconciliation (#1253) read, instead of a stale actionable version.
 *
 * Replay inertness is the same invariant the enqueue path holds (control 8): a
 * stored (identity, version) pair is not a transition, so there is no counter
 * bump, no restamp, and no write of any kind — the periodic re-read of a
 * dismissed review cannot inflate the counter forever. Only a VERSION change
 * records, and it rides the same transaction as the counter bump that claims its
 * sequence, pinned on the exact counter value the claim was derived from: a
 * concurrent transition landing in the read→write gap misses the pin, and the
 * bounded in-transaction loop re-reads and re-derives instead of double-issuing
 * a sequence. A ledger row is never written for a sequence the write did not
 * claim — the pin gives up (false) rather than writing an unclaimed one.
 */
export async function recordPrFixEvidenceBaseline(
  client: PrFixQueueClient,
  rawInput: EvidenceObservation & { repo: string; pr: number },
): Promise<boolean> {
  // Same identity fold as enqueuePrFixItem (#1145): (repo, pr) is the ownership
  // key and must not depend on the caller's casing.
  const input = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  // Fail closed exactly like the enqueue path: without a complete evidence
  // block there is no way to tell a re-read from a transition, and a client
  // without the ledger surface has nowhere to record.
  if (!carriesLedgerFields(input) || !client.prFixEvidence) return false;

  // Non-transactional pre-check (#1276 review): a sync sweep re-observes every
  // review on every open PR, and almost all of them are replays of a stored
  // version or have no item at all. Answering those without opening a
  // transaction keeps the record-only path's cost proportional to real
  // transitions. Purely an optimization — the transaction below re-reads and
  // re-checks, so a lost race still lands on the in-transaction decision.
  const precheck = await client.prFixQueueItem.findUnique({
    where: { repo_pr: { repo: input.repo, pr: input.pr } },
  });
  if (!precheck) return false;
  const precheckLedger = await readEvidenceLedgerView(client, precheck.id, input);
  if (precheckLedger.prior && precheckLedger.prior.version === (input.evidenceVersion ?? "")) {
    return false;
  }

  // #1134/#1249 pin budget, shared with the enqueue path: three in-transaction
  // retries are enough to ride out a concurrent transition, and giving up is
  // safe because nothing was written.
  const maxPinnedBaselineWrites = 3;

  return client.$transaction(async (tx) => {
    if (!tx.prFixEvidence) return false;
    let snapshot = await tx.prFixQueueItem.findUnique({
      where: { repo_pr: { repo: input.repo, pr: input.pr } },
    });
    // No item, no write — and no item is ever created for a record-only
    // observation.
    if (!snapshot) return false;

    let ledgerView = await readEvidenceLedgerView(tx, snapshot.id, input);
    if (!ledgerView.records) return false;

    for (let attempt = 0; attempt < maxPinnedBaselineWrites; attempt += 1) {
      // Replay of a stored (identity, version): inert. Re-read every attempt so
      // a transition that landed in a previous attempt's gap is seen here.
      if (ledgerView.prior && ledgerView.prior.version === (input.evidenceVersion ?? "")) {
        return false;
      }
      const claimedSequence = (snapshot.evidenceSequence ?? 0) + 1;
      const { count } = await tx.prFixQueueItem.updateMany({
        where: { id: snapshot.id, evidenceSequence: snapshot.evidenceSequence ?? 0 },
        data: { evidenceSequence: { increment: 1 } },
      });
      if (count === 1) {
        await recordEvidenceTransition(tx, snapshot.id, input, claimedSequence, ledgerView.repeatedSignature);
        return true;
      }
      // The pin missed (concurrent transition in the read→write gap, or the row
      // was deleted). Re-read in-transaction and re-derive; nothing has been
      // written by the missed `updateMany`, so there is nothing to unwind.
      const fresh = await tx.prFixQueueItem.findUnique({ where: { id: snapshot.id } });
      if (!fresh) return false;
      snapshot = fresh;
      ledgerView = await readEvidenceLedgerView(tx, snapshot.id, input);
    }
    // Sustained contention: give up rather than write a ledger row for a
    // sequence no item write claimed. The next sweep re-observes and records it.
    return false;
  });
}

/**
 * Drop the needs-human label and fold the BLOCKED marker comment whenever an
 * item leaves BLOCKED. Only requeue used to do this, so an item settled FIXED
 * by a mark kept `needs-human` on an approved PR (#1105). Never throws.
 */
export async function retractNeedsHuman(repo: string, pr: number, outcome: PrFixUnblockOutcome, note?: string | null) {
  await surfacePrFixUnblocked(repo, pr, outcome, note ?? undefined).catch((error) => {
    console.error(`pr-fix-queue needs-human cleanup error for ${repo}#${pr}:`, error);
  });
}

export async function createLinkedPrFixItem(
  client: PrFixQueueClient,
  rawInput: CreateLinkedPrFixInput,
): Promise<{ item: any; created: boolean }> {
  // Same identity fold as enqueuePrFixItem (#1145).
  const input: CreateLinkedPrFixInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  // #1569: a materialized row records its ORIGINAL CLAIMANT at creation,
  // resolved from the linked issue's authoritative records (live Lease →
  // single `agent/*` label → single `owner/*` label). No PR-author input
  // exists here (the row is minted from health, not a PR event), so an
  // unresolved issue records its failure state; the issuance-time lazy
  // backfill and operator recovery resolve it later. Ownership is never
  // inherited from any consuming poll.
  // #1615: on a non-REBASE item the rebase-executor pool is not claimant
  // evidence (same rule as enqueuePrFixItem).
  const materializedType = normalizePrFixType(input.type);
  const claimantResolution = await resolveIngestionClaimant(
    client,
    input.repo,
    input.issue,
    null,
    undefined,
    rebaseExecutorClaimantExclusion(materializedType),
  );
  // #1569: same rule as enqueue — a resolved identity or an honest failure
  // state is recorded at materialization; a failed fact read records nothing
  // and the row stays unresolved ("legacy").
  const claimantPatch = ingestionClaimantPatch(claimantResolution);
  try {
    const item = await client.$transaction(async (tx) => {
      const item = await tx.prFixQueueItem.create({
        data: {
          repo: input.repo,
          pr: input.pr,
          issue: input.issue,
          lane: input.lane,
          ...claimantPatch,
          // The caller picks the lane's type (#1327): a conflicted linked PR
          // materializes as REBASE, everything else stays the ordinary fix
          // lane (OTHER).
          type: normalizePrFixType(input.type),
          status: "QUEUED",
          reason: input.reason,
          feedback: input.feedback,
          evidenceKeys: [input.evidenceKey],
          ...(input.url ? { url: input.url } : {}),
          ...(input.title ? { title: input.title } : {}),
          headSha: input.headSha ?? null,
          attemptHeadSha: input.headSha ?? null,
        },
      });
      await tx.prFixHistory.create({
        data: {
          itemId: item.id,
          action: "enqueue",
          lane: item.lane,
          reason: input.reason,
          evidenceKey: input.evidenceKey,
          note: "Materialized from linked PR health scan.",
        },
      });
      return item;
    });
    return { item, created: true };
  } catch (error) {
    // The unique (repo, pr) constraint is the ownership boundary. If another
    // enqueue won, return its row without mutating or reopening it. A
    // transaction-level P2002 may also come from history, so only treat it as
    // the ownership race when the unique-key winner can be read back.
    if ((error as { code?: string })?.code !== "P2002") throw error;
    const item = await client.prFixQueueItem.findUnique({
      where: { repo_pr: { repo: input.repo, pr: input.pr } },
    });
    if (!item) throw error;
    return { item, created: false };
  }
}
