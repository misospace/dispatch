// #1251 — the operator-side READ surface for derived ownership.
//
// Ownership is derived, never stored (docs/ownership-reconciliation.md §4/§5).
// This module reads the three overlapping ownership signals — the issue's
// labels, the durable `Lease` checkpoint, and the per-agent `AgentWork`
// heartbeat — plus the issue's authoritative facts (open/closed, the blocked
// reason, the linked-PR merge state, and any open PR-fix queue row) for ONE
// issue, folds them into the derived state via `deriveOwnershipState`, and
// returns a redaction-safe snapshot.
//
// It is a pure read: no writes, no audit log, no lease release. The raw claim
// token is never surfaced — only its presence (`claimTokenPresent`). A failed
// live label read yields `labelSource: "unavailable"` and the cached set; it
// never throws a 5xx.

import { prisma } from "./prisma";
import { getLiveIssueLabels } from "./claim-gate";
import {
  deriveOwnershipState,
  type OwnershipAgentWorkEvidence,
  type OwnershipAssessment,
  type OwnershipEvidence,
  type OwnershipLabelSource,
  type OwnershipLeaseEvidence,
  type OwnershipWindows,
} from "./ownership-state";
import {
  ownershipActiveWindowMs,
  ownershipLongRunGraceMs,
} from "./worker-ownership";

/** The PR-fix queue states that represent work still in flight (an open row). */
const OPEN_PR_FIX_STATES: Array<"QUEUED" | "BLOCKED" | "PARKED" | "WAITING_EXTERNAL"> = [
  "QUEUED",
  "BLOCKED",
  "PARKED",
  "WAITING_EXTERNAL",
];

/** Only these AgentWork states count as an active claim / liveness. */
const ACTIVE_AGENT_WORK_STATES: Array<"CLAIMED" | "IN_PROGRESS" | "BLOCKED"> = [
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
];

/**
 * The subset of a `Lease` surfaced to an operator. The raw `claimToken` is
 * deliberately replaced by its boolean presence so a token can never leak
 * through a read path.
 */
export interface LeaseOwnershipView {
  agentName: string;
  expiredAt: Date;
  renewedAt: Date | null;
  claimTokenPresent: boolean;
  registeredAt: Date | null;
  registrationOccurredAt: Date | null;
  renewCount: number;
  lastRenewalObservedAt: Date | null;
  lastRenewalOccurredAt: Date | null;
  retryAfter: Date | null;
  disposition: string | null;
  runRef: string | null;
}

export interface AgentWorkOwnershipView {
  agentName: string;
  state: string;
  lastHeartbeatAt: Date | null;
}

/** The evidence snapshot behind an ownership derivation, redacted. */
export interface OwnershipEvidenceView {
  /** "live" | "cache" | "unavailable" — how the operative label set was read. */
  labelSource: OwnershipLabelSource;
  /** The operative label set the derivation ran against. */
  labelsUsed: string[];
  blockedReason: string | null;
  linkedPrNumber: number | null;
  linkedPrMergeState: string | null;
  openPrFix: boolean;
  lease: LeaseOwnershipView | null;
  agentWork: AgentWorkOwnershipView | null;
}

export type OwnershipInspectResult = {
  found: false;
} | {
  found: true;
  issue: {
    id: string;
    number: number;
    repoFullName: string;
    state: "open" | "closed";
  };
  assessment: OwnershipAssessment;
  windows: {
    activeMs: number;
    longRunGraceMs: number;
  };
  inspectedAt: Date;
  evidence: OwnershipEvidenceView;
};

export interface InspectIssueOwnershipOptions {
  /** Reference time for liveness windows; defaults to the current instant. */
  now?: Date;
  /**
   * When `true` (the default) the operative label set is read live from the
   * forge; a failed read yields `labelSource: "unavailable"` with the cached
   * set. When `false` the cached label set is used and `labelSource` is
   * "cache" — this is the knob the list surface uses to avoid one GitHub call
   * per candidate.
   */
  live?: boolean;
}

/**
 * Choose the ownership-relevant lease among a set of lease rows for an issue:
 * the freshest ACTIVE lease (`expiredAt > now`), ordered by `renewedAt` desc
 * (nulls last) with a `createdAt` desc tiebreak; when none is active, the most
 * recently created lease so a lapsed-but-disposed claim still surfaces.
 */
function selectLease<T extends { expiredAt: Date; renewedAt: Date | null; createdAt: Date }>(
  leases: T[],
  now: Date,
): T | null {
  if (leases.length === 0) return null;
  const nowMs = now.getTime();

  const active = leases
    .filter((l) => l.expiredAt.getTime() > nowMs)
    .sort((a, b) => {
      const aRen = a.renewedAt ? a.renewedAt.getTime() : -1;
      const bRen = b.renewedAt ? b.renewedAt.getTime() : -1;
      if (bRen !== aRen) return bRen - aRen;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  if (active.length > 0) return active[0];

  return [...leases]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

/**
 * Inspect the derived ownership of one issue.
 *
 * Returns `{ found: false }` when the issue id is not in the local cache.
 * Otherwise returns the issue identity, the derived `OwnershipAssessment`, the
 * deployment's liveness windows, the inspection time, and the redacted evidence
 * snapshot.
 */
export async function inspectIssueOwnership(
  issueId: string,
  options: InspectIssueOwnershipOptions = {},
): Promise<OwnershipInspectResult> {
  const now = options.now ?? new Date();
  const live = options.live ?? true;

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: { repository: true },
  });
  if (issue === null) {
    return { found: false };
  }

  const repoFullName = issue.repository.fullName;
  const issueState: "open" | "closed" = issue.state === "open" ? "open" : "closed";

  // --- Operative label set + how it was read -------------------------------
  let labelSource: OwnershipLabelSource;
  let labelsUsed: string[];
  if (live) {
    try {
      labelsUsed = await getLiveIssueLabels(repoFullName, issue.number);
      labelSource = "live";
    } catch {
      // Forge unreachable — the read is unverifiable but never a 5xx; the
      // cached set still feeds divergence and owner detection.
      labelsUsed = issue.labels;
      labelSource = "unavailable";
    }
  } else {
    labelsUsed = issue.labels;
    labelSource = "cache";
  }

  // --- First-party signals -------------------------------------------------
  const leaseRows = await prisma.lease.findMany({ where: { issueId: issue.id } });
  const lease = selectLease(leaseRows, now);

  const agentWork = await prisma.agentWork.findFirst({
    where: { issueId: issue.id, state: { in: ACTIVE_AGENT_WORK_STATES } },
    orderBy: { lastHeartbeatAt: "desc" },
  });

  const prFixOrConditions: Array<Record<string, number>> = [{ issue: issue.number }];
  if (issue.linkedPrNumber !== null) {
    prFixOrConditions.push({ pr: issue.linkedPrNumber });
  }
  const openPrFixRow = await prisma.prFixQueueItem.findFirst({
    where: {
      repo: repoFullName,
      status: { in: OPEN_PR_FIX_STATES },
      OR: prFixOrConditions,
    },
  });

  const linkedPrNumber = issue.linkedPrNumber;
  const linkedPrMergeState = issue.linkedPrMergeState;

  // --- Fold into the derived state ----------------------------------------
  const leaseEvidence: OwnershipLeaseEvidence | null =
    lease === null
      ? null
      : {
          agentName: lease.agentName,
          expiredAt: lease.expiredAt,
          renewedAt: lease.renewedAt,
          claimToken: lease.claimToken,
          registeredAt: lease.registeredAt,
          registrationOccurredAt: lease.registrationOccurredAt,
          renewCount: lease.renewCount,
          lastRenewalObservedAt: lease.lastRenewalObservedAt,
          lastRenewalOccurredAt: lease.lastRenewalOccurredAt,
          retryAfter: lease.retryAfter,
          disposition: lease.disposition,
        };

  const agentWorkEvidence: OwnershipAgentWorkEvidence | null =
    agentWork === null
      ? null
      : {
          agentName: agentWork.agentName,
          state: agentWork.state,
          lastHeartbeatAt: agentWork.lastHeartbeatAt,
        };

  const evidence: OwnershipEvidence = {
    issueState,
    labels: labelsUsed,
    labelSource,
    cachedLabels: issue.labels,
    blockedReason: issue.blockedReason,
    linkedPrNumber,
    linkedPrMergeState,
    openPrFix: openPrFixRow !== null,
    lease: leaseEvidence,
    agentWork: agentWorkEvidence,
  };

  const windows: OwnershipWindows = {
    activeMs: ownershipActiveWindowMs(),
    longRunGraceMs: ownershipLongRunGraceMs(),
  };

  const assessment = deriveOwnershipState(evidence, windows, now);

  return {
    found: true,
    issue: { id: issue.id, number: issue.number, repoFullName, state: issueState },
    assessment,
    windows: { activeMs: windows.activeMs, longRunGraceMs: windows.longRunGraceMs },
    inspectedAt: now,
    evidence: {
      labelSource,
      labelsUsed,
      blockedReason: issue.blockedReason ?? null,
      linkedPrNumber,
      linkedPrMergeState,
      openPrFix: openPrFixRow !== null,
      lease:
        lease === null
          ? null
          : {
              agentName: lease.agentName,
              expiredAt: lease.expiredAt,
              renewedAt: lease.renewedAt,
              claimTokenPresent: lease.claimToken !== null,
              registeredAt: lease.registeredAt,
              registrationOccurredAt: lease.registrationOccurredAt,
              renewCount: lease.renewCount,
              lastRenewalObservedAt: lease.lastRenewalObservedAt,
              lastRenewalOccurredAt: lease.lastRenewalOccurredAt,
              retryAfter: lease.retryAfter,
              disposition: lease.disposition,
              runRef: lease.runRef,
            },
      agentWork:
        agentWork === null
          ? null
          : {
              agentName: agentWork.agentName,
              state: agentWork.state,
              lastHeartbeatAt: agentWork.lastHeartbeatAt,
            },
    },
  };
}
