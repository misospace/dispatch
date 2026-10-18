import { AGENT_PREFIX } from "@/types";

/**
 * Derived ownership state for an issue — the §4 state model and §5 evidence
 * hierarchy of `docs/ownership-reconciliation.md` (#1251).
 *
 * Ownership is derived, never stored: this module folds the three overlapping
 * ownership signals — the persisted `agent/*` label, the durable `Lease`
 * checkpoint, and the per-agent `AgentWork` heartbeat — together with the
 * issue's authoritative facts (open/closed, blocked reason, linked-PR state,
 * open PR-fix queue row) into one state with machine-readable reason codes.
 *
 * Pure by contract: no Prisma, no network, no env reads. The evidence snapshot
 * and the liveness windows come in as parameters and `now` defaults to the
 * current instant. The caller reads live labels through the forge adapter (§7)
 * and the first-party lease/AgentWork rows, then passes the assembled snapshot.
 *
 * Precedence (first match wins):
 *   1. closed issue                  → UNOWNED (`issue_closed`)
 *   2. ownership conflicts           → CONFLICTED (`multiple_agent_labels`,
 *      `live_cache_divergence`, `lease_owner_mismatch`,
 *      `agent_work_owner_mismatch` — all applicable ones are collected)
 *   3. `status/blocked` + non-empty reason → HELD (`human_hold`); terminal,
 *      applies even with a live claim and even without any claim; a bare
 *      `status/blocked` without a reason does not hold
 *   4. claim + future lease `retryAfter` → EXTERNAL_WAIT
 *      (`external_wait_retry_after`); an elapsed `retryAfter` falls through
 *   5. `status/in-review` with an open linked PR (merge state other than
 *      "merged") or an open PR-fix row, or an open PR-fix row with any claim
 *      → REVIEW_OWNED (`open_linked_pr` / `open_pr_fix_queue`); terminal,
 *      never releases even on stale evidence
 *   6. no claim at all (no `agent/*` label, no lease, no active AgentWork)
 *      → UNOWNED (`unowned`)
 *   7. terminal lease disposition (completed/released/handed_off)
 *      → ABANDONED_CANDIDATE (`terminal_disposition_<kind>`); positive
 *      evidence the owner is gone, so it beats the liveness ladder even when
 *      the last renewal is fresh
 *   8. liveness ladder on the freshest Dispatch-side evidence:
 *      within the active window → CLAIMED_ACTIVE (`evidence_recent`); older
 *      but within the long-run grace, or the lease is still live
 *      → CLAIMED_LONG_RUNNING (`long_run_grace` / `lease_still_live`); beyond
 *      both → ABANDONED_CANDIDATE (`evidence_stale`)
 *   9. a claim with no Dispatch liveness evidence at all (label-only legacy
 *      claim) → UNKNOWN (`owner_unverified_no_dispatch_evidence`;
 *      `labels_unverifiable` when the label read is unavailable and only the
 *      cached set shows the claim). Absence of evidence is never abandonment
 *      (§5 tier 6, #1251 done-criteria).
 *
 * Non-short-circuiting cases: a `blocked` disposition without a future
 * `retryAfter` (the future case returns above as EXTERNAL_WAIT) continues
 * down the ladder with the added reason `disposition_blocked_no_retry_after`.
 * When `labelSource` is `unavailable` but first-party evidence (lease /
 * active AgentWork) exists, the ladder continues with the added reason
 * `labels_unverified` — lease/AgentWork are first-party evidence even when
 * the label read failed.
 *
 * `verified` is `labelSource === "live"` in every case. `evidenceAgeMs` is
 * the age of the freshest liveness evidence (null when there is none) and is
 * reported for every state, not only the ladder ones. `lease.renewCount` and
 * `lease.claimToken` are deliberately not read here: they are fencing/
 * rotation receipts for the disposition protocol, not liveness evidence.
 */

export const OWNERSHIP_STATES = ["UNOWNED","CLAIMED_ACTIVE","CLAIMED_LONG_RUNNING","REVIEW_OWNED","EXTERNAL_WAIT","HELD","ABANDONED_CANDIDATE","CONFLICTED","UNKNOWN"] as const;

export type OwnershipState = typeof OWNERSHIP_STATES[number];

export interface OwnershipLeaseEvidence {
  agentName: string;
  expiredAt: Date;
  renewedAt: Date | null;
  claimToken: string | null;
  /** Server-observed durable registration (first-party). */
  registeredAt: Date | null;
  /** Client-reported registration occurrence (self-reported). */
  registrationOccurredAt: Date | null;
  renewCount: number;
  lastRenewalObservedAt: Date | null;
  lastRenewalOccurredAt: Date | null;
  retryAfter: Date | null;
  /** "completed" | "released" | "blocked" | "handed_off" | null. */
  disposition: string | null;
}

export interface OwnershipAgentWorkEvidence {
  agentName: string;
  /** CLAIMED | IN_PROGRESS | BLOCKED | DONE | RELEASED | STALE; only the first three count as active. */
  state: string;
  lastHeartbeatAt: Date;
}

/** How the operative label set was obtained ("cache" = read-model without a forge call). */
export type OwnershipLabelSource = "live" | "cache" | "unavailable";

export interface OwnershipEvidence {
  issueState: "open" | "closed";
  /** Live labels when `labelSource === "live"`, else the cached set — the "operative" set. */
  labels: string[];
  labelSource: OwnershipLabelSource;
  /** Cached set, for divergence detection when the live read succeeded. */
  cachedLabels?: string[];
  blockedReason?: string | null;
  linkedPrNumber?: number | null;
  /** null/unknown is not merged; only the string "merged" ends review ownership. */
  linkedPrMergeState?: string | null;
  /** Open PR-fix queue row for this issue/PR. */
  openPrFix?: boolean;
  lease?: OwnershipLeaseEvidence | null;
  agentWork?: OwnershipAgentWorkEvidence | null;
}

export interface OwnershipWindows {
  activeMs: number;
  longRunGraceMs: number;
}

export interface OwnershipAssessment {
  state: OwnershipState;
  /** Sole `agent/*` label owner, else the lease owner, else the active AgentWork owner. */
  ownerAgent: string | null;
  /** Machine-readable, stable strings; the last entry is the deciding reason. */
  reasonCodes: string[];
  /** Age of the freshest liveness evidence; null = none. */
  evidenceAgeMs: number | null;
  /** labelSource === "live". */
  verified: boolean;
}

const BLOCKED_LABEL = "status/blocked";
const IN_REVIEW_LABEL = "status/in-review";
const MERGED_PR_STATE = "merged";

/** Only CLAIMED/IN_PROGRESS/BLOCKED AgentWork count as an active claim or liveness. */
const ACTIVE_AGENT_WORK_STATES: ReadonlySet<string> = new Set(["CLAIMED", "IN_PROGRESS", "BLOCKED"]);

/** Terminal dispositions: positive evidence the owner is gone. */
const TERMINAL_DISPOSITIONS: ReadonlySet<string> = new Set(["completed", "released", "handed_off"]);

function isAgentLabel(label: string): boolean {
  return label.startsWith(AGENT_PREFIX);
}

function isAgentWorkActive(agentWork: OwnershipAgentWorkEvidence | null | undefined): agentWork is OwnershipAgentWorkEvidence {
  return agentWork !== null && agentWork !== undefined && ACTIVE_AGENT_WORK_STATES.has(agentWork.state);
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/**
 * Freshest liveness timestamp (epoch ms) as of `now` (default: the current
 * instant), or null when there is no liveness evidence. The liveness
 * timestamps are the lease's registration/renewal fields (server-observed
 * and client-reported variants) plus the heartbeat of an active AgentWork;
 * `expiredAt` and `retryAfter` are not liveness evidence. A future-dated
 * timestamp (clock skew on a self-reported `occurred` value) is clamped to
 * `now` so the derived age is never negative — a claim can never look more
 * alive than the present.
 */
export function latestEvidenceTimestamp(
  lease: OwnershipLeaseEvidence | null | undefined,
  agentWork: OwnershipAgentWorkEvidence | null | undefined,
  now: Date = new Date(),
): number | null {
  const timestamps: number[] = [];

  if (lease !== null && lease !== undefined) {
    const leaseTimestamps = [
      lease.renewedAt,
      lease.registeredAt,
      lease.registrationOccurredAt,
      lease.lastRenewalObservedAt,
      lease.lastRenewalOccurredAt,
    ];
    for (const ts of leaseTimestamps) {
      if (ts !== null) timestamps.push(ts.getTime());
    }
  }

  if (isAgentWorkActive(agentWork)) {
    timestamps.push(agentWork.lastHeartbeatAt.getTime());
  }

  if (timestamps.length === 0) return null;
  return Math.min(Math.max(...timestamps), now.getTime());
}

/**
 * Derive the current ownership state for an issue from an evidence snapshot
 * and the deployment's liveness windows. Pure function: same inputs, same
 * output; the caller owns reading the live labels and the first-party rows.
 */
export function deriveOwnershipState(
  evidence: OwnershipEvidence,
  windows: OwnershipWindows,
  now: Date = new Date(),
): OwnershipAssessment {
  const nowMs = now.getTime();
  const verified = evidence.labelSource === "live";

  const operative = evidence.labels;
  const agentOwners = operative.filter(isAgentLabel).map((label) => label.slice(AGENT_PREFIX.length));
  const distinctOwners = [...new Set(agentOwners)];
  const soleLabelOwner = distinctOwners.length === 1 ? distinctOwners[0] : null;

  const lease = evidence.lease ?? null;
  const activeAgentWork = isAgentWorkActive(evidence.agentWork) ? evidence.agentWork : null;
  const hasClaim = agentOwners.length > 0 || lease !== null || activeAgentWork !== null;

  const ownerAgent = soleLabelOwner ?? lease?.agentName ?? activeAgentWork?.agentName ?? null;

  const latest = latestEvidenceTimestamp(lease, evidence.agentWork, now);
  const evidenceAgeMs = latest === null ? null : nowMs - latest;

  const assessment = (state: OwnershipState, reasonCodes: string[]): OwnershipAssessment => ({
    state,
    ownerAgent,
    reasonCodes,
    evidenceAgeMs,
    verified,
  });

  // 1. Closed issues are terminal: the close/sync path owns cleanup; a live
  //    claim is never released just because the issue closed.
  if (evidence.issueState === "closed") {
    return assessment("UNOWNED", ["issue_closed"]);
  }

  // 2. Ownership conflicts are collected, never resolved (operator-only).
  const conflictReasons: string[] = [];
  if (distinctOwners.length > 1) {
    conflictReasons.push("multiple_agent_labels");
  }
  if (evidence.labelSource === "live" && evidence.cachedLabels !== undefined) {
    const liveAgentSet = new Set(operative.filter(isAgentLabel));
    const cachedAgentSet = new Set(evidence.cachedLabels.filter(isAgentLabel));
    if (!sameStringSet(liveAgentSet, cachedAgentSet)) {
      conflictReasons.push("live_cache_divergence");
    }
  }
  if (distinctOwners.length === 1) {
    const labelOwner = distinctOwners[0];
    if (lease !== null && lease.agentName !== labelOwner) {
      conflictReasons.push("lease_owner_mismatch");
    }
    if (lease === null && activeAgentWork !== null && activeAgentWork.agentName !== labelOwner) {
      conflictReasons.push("agent_work_owner_mismatch");
    }
  }
  if (conflictReasons.length > 0) {
    return assessment("CONFLICTED", conflictReasons);
  }

  // 3. A deliberate block (status/blocked with a non-empty, non-blank reason)
  //    is a human hold: terminal, with or without a live claim.
  const blockedReason = (evidence.blockedReason ?? "").trim();
  if (operative.includes(BLOCKED_LABEL) && blockedReason.length > 0) {
    return assessment("HELD", ["human_hold"]);
  }

  // 4. A recorded external wait defers pickup until the retry-after elapses.
  const retryAfter = lease?.retryAfter ?? null;
  if (hasClaim && retryAfter !== null && retryAfter.getTime() > nowMs) {
    return assessment("EXTERNAL_WAIT", ["external_wait_retry_after"]);
  }

  // 5. Review ownership is terminal: an open linked PR or an open PR-fix row
  //    owns the issue; stale evidence never releases it.
  const inReview = operative.includes(IN_REVIEW_LABEL);
  const openPrFix = evidence.openPrFix === true;
  const openLinkedPr =
    evidence.linkedPrNumber != null && evidence.linkedPrMergeState !== MERGED_PR_STATE;
  if (inReview && (openPrFix || openLinkedPr)) {
    return assessment("REVIEW_OWNED", openLinkedPr ? ["open_linked_pr"] : ["open_pr_fix_queue"]);
  }
  if (openPrFix && hasClaim) {
    return assessment("REVIEW_OWNED", ["open_pr_fix_queue"]);
  }

  // 6. No claim at all: eligible subject to status.
  if (!hasClaim) {
    return assessment("UNOWNED", ["unowned"]);
  }

  // 7. A terminal disposition is positive evidence the owner is gone; it
  //    beats the liveness ladder even when the last renewal is fresh.
  const disposition = lease?.disposition ?? null;
  if (disposition !== null && TERMINAL_DISPOSITIONS.has(disposition)) {
    return assessment("ABANDONED_CANDIDATE", [`terminal_disposition_${disposition}`]);
  }

  const reasonCodes: string[] = [];
  if (disposition === "blocked") {
    // Not a short-circuit: with no future retryAfter (that case returned
    // above as EXTERNAL_WAIT) the block stays unverified and continues.
    reasonCodes.push("disposition_blocked_no_retry_after");
  }

  // 9. Labels unverifiable but first-party evidence exists: the ladder
  //    continues; the label-derived claim is flagged unverified.
  if (evidence.labelSource === "unavailable" && (lease !== null || activeAgentWork !== null)) {
    reasonCodes.push("labels_unverified");
  }

  // 8/9. Liveness ladder on the freshest Dispatch-side evidence.
  if (evidenceAgeMs === null) {
    // A claim with no Dispatch-side liveness evidence at all (a label-only
    // legacy claim) is unknown, never abandoned (§5 tier 6).
    reasonCodes.push(
      evidence.labelSource === "unavailable" && lease === null && activeAgentWork === null
        ? "labels_unverifiable"
        : "owner_unverified_no_dispatch_evidence",
    );
    return assessment("UNKNOWN", reasonCodes);
  }
  if (evidenceAgeMs <= windows.activeMs) {
    reasonCodes.push("evidence_recent");
    return assessment("CLAIMED_ACTIVE", reasonCodes);
  }
  if (evidenceAgeMs <= windows.longRunGraceMs || (lease?.expiredAt.getTime() ?? 0) > nowMs) {
    reasonCodes.push(evidenceAgeMs <= windows.longRunGraceMs ? "long_run_grace" : "lease_still_live");
    return assessment("CLAIMED_LONG_RUNNING", reasonCodes);
  }
  reasonCodes.push("evidence_stale");
  return assessment("ABANDONED_CANDIDATE", reasonCodes);
}
