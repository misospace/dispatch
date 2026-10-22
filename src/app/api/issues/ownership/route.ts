import { NextResponse } from "next/server";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  inspectIssueOwnership,
  type OwnershipEvidenceView,
} from "@/lib/ownership-inspect";
import {
  OWNERSHIP_STATES,
  type OwnershipAssessment,
  type OwnershipState,
} from "@/lib/ownership-state";
import {
  ownershipActiveWindowMs,
  ownershipLongRunGraceMs,
} from "@/lib/worker-ownership";
import {
  ownershipReconcileMode,
  reconcileMaxReclaims,
  reconcileRecheckIntervalMs,
  reconcileMaxForgeRetries,
} from "@/lib/ownership-reconciliation";
import { GUARD_HEARTBEAT_MS, GUARD_OVERRIDE_MIN_AGE_MS } from "@/lib/issue-mutation-guard";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const AGENT_LABEL_PREFIX = "agent/";

/** One entry in the ownership list: a resolved open issue and its derivation. */
interface OwnershipListItem {
  id: string;
  number: number;
  repoFullName: string;
  state: "open" | "closed";
  assessment: OwnershipAssessment;
  evidence: OwnershipEvidenceView;
}

/** The `Lease` columns the bounded scan orders on. */
interface LeaseScanRow {
  id: string;
  issueId: string;
  createdAt: Date;
  renewedAt: Date | null;
}

/**
 * Effective activity of a lease: its last renewal, or its claim time when it
 * was never renewed. The renewal paths (`upsertLease` and the ownership
 * capability's renew) stamp `renewedAt`; `register` and `disposition` are not
 * renewals and deliberately leave it alone, so a lease that was only ever
 * registered falls back to its claim time.
 */
function leaseActivity(row: LeaseScanRow): number {
  return (row.renewedAt ?? row.createdAt).getTime();
}

/**
 * Most recent activity first; `id` ascending breaks ties deterministically.
 * The id is a cuid (lower-case alphanumeric), so the JS comparison and the
 * database's `id ASC` order agree.
 */
function compareLeaseActivity(x: LeaseScanRow, y: LeaseScanRow): number {
  const ax = leaseActivity(x);
  const ay = leaseActivity(y);
  if (ax !== ay) return ay - ax;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

/**
 * Merge two runs that are each already sorted by (activity desc, id asc) into
 * one run with the same order. Only the heads are compared — the runs are
 * never re-sorted — so the query's `orderBy` stays the single source of
 * ordering truth and the `id` tie-break is the same on both sides of the
 * merge.
 */
function mergeLeaseRuns(a: LeaseScanRow[], b: LeaseScanRow[]): LeaseScanRow[] {
  const merged: LeaseScanRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const takeA =
      j >= b.length || (i < a.length && compareLeaseActivity(a[i], b[j]) <= 0);
    merged.push(takeA ? a[i++] : b[j++]);
  }
  return merged;
}

/**
 * GET /api/issues/ownership — operator debug surface: the derived ownership
 * state for every issue that plausibly has a claim (#1251,
 * docs/ownership-reconciliation.md §9).
 *
 * Collects candidate issue ids from three signals — issues referenced by an
 * active (non-expired) lease and issues with an active `AgentWork` row first
 * (the strongest ownership signals, naturally bounded by live claims), then
 * open issues holding an `agent/*` label — and reuses the same
 * `inspectIssueOwnership` the per-issue route uses (with `live: false`, so no
 * per-candidate GitHub call). Not-found and closed issues are dropped.
 *
 * Bounded: every source read is capped at `MAX_CANDIDATE_SCAN` rows in a
 * deterministic most-recent-first order, and only the first `MAX_INSPECTED`
 * candidates are derived. `truncated: true` says candidates were dropped
 * *before* derivation, so `counts`/`examined` describe the inspected set, not
 * the whole population. `sourcesTruncated` separately reports, per source
 * (`labeled` = label sweep, `leased` = active lease, `working` = active
 * AgentWork), whether that source had more rows than the cap — so an operator
 * can tell which signal overflowed rather than only that something did.
 *
 * "Most recent" means the row's most recent ACTIVITY: for a lease that is its
 * last renewal (falling back to its claim time when it was never renewed), for
 * an issue or an AgentWork row its last update.
 *
 * Operator-only: worker-tier callers get 403 by the central tiering (this
 * route is not in `WORKER_ALLOWLIST`), not by any local check.
 *
 * Query params:
 * - `state` — filter by derived ownership state; must be one of
 *   `OWNERSHIP_STATES` (400 otherwise).
 * - `limit` — cap on returned items (default 50, clamped to 1..200).
 *
 * Response: `{ items, counts, examined, truncated, sourcesTruncated, limit,
 * windows }`, where `counts` and `examined` reflect the inspected (open)
 * population before the state filter and limit are applied.
 */
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return authErrorResponse(auth);

  const searchParams = new URL(request.url).searchParams;

  const stateParam = searchParams.get("state")?.trim();
  if (stateParam !== undefined && stateParam !== "" &&
      !(OWNERSHIP_STATES as readonly string[]).includes(stateParam)) {
    return NextResponse.json(
      { error: `Invalid state: ${stateParam}. Allowed: ${OWNERSHIP_STATES.join(", ")}` },
      { status: 400 },
    );
  }

  let limit = DEFAULT_LIMIT;
  const limitParam = searchParams.get("limit");
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isNaN(parsed)) {
      limit = Math.min(Math.max(parsed, 1), MAX_LIMIT);
    }
  }

  const now = new Date();

  // Bounded scan: this is an operator inspection surface, not an index. Every
  // source read is capped (most recently touched first, so the kept slice is
  // stable and reproducible rather than arbitrary) and the total number of
  // per-candidate derivations is capped with chunked concurrency so one
  // maintainer request cannot amplify into an unbounded query storm.
  const MAX_CANDIDATE_SCAN = 1000;
  const MAX_INSPECTED = 500;
  const INSPECT_CONCURRENCY = 25;

  // Each source is read with ONE probe row past the cap and the probe row is
  // dropped before candidates are seeded. Overflow is therefore exact — a
  // length of exactly MAX_CANDIDATE_SCAN + 1 means the source really had more
  // rows — rather than inferred from a filled-up page. The lease source reads
  // two runs, so it has two probe rows; both are older than the cap worth of
  // rows their own run returned, so the merged slice below drops them.
  const SCAN_TAKE = MAX_CANDIDATE_SCAN + 1;

  // (a) open issues holding an agent/* label (cached set)
  const labeledRows = await prisma.issue.findMany({
    where: { repository: { enabled: true }, state: "open" },
    select: { id: true, labels: true },
    orderBy: { updatedAt: "desc" },
    take: SCAN_TAKE,
  });
  const openLabeled = labeledRows.slice(0, MAX_CANDIDATE_SCAN);
  const labeledTruncated = labeledRows.length > MAX_CANDIDATE_SCAN;
  // (b) issues referenced by an active (non-expired) lease. Freshness is the
  // row's most recent ACTIVITY, not its creation: a lease renewed a moment
  // ago is live ownership evidence even when the claim itself is old, and a
  // never-renewed claim's activity is its creation time. Ordering on
  // `createdAt` alone ranked a freshly claimed, never-renewed lease above an
  // old lease its owner is still heartbeating — and past the cap, dropped the
  // live one while keeping the stale one.
  //
  // Prisma's `orderBy` cannot express that combined timestamp, so the source
  // is read as two runs that are each already sorted by their activity
  // timestamp — renewed leases by `renewedAt`, never-renewed leases by
  // `createdAt` — and merged below on the same key. `id` breaks ties in both
  // the query and the merge, so equal timestamps cannot reorder between runs.
  const [renewedRows, neverRenewedRows] = await Promise.all([
    prisma.lease.findMany({
      where: { expiredAt: { gt: now }, renewedAt: { not: null } },
      select: { id: true, issueId: true, createdAt: true, renewedAt: true },
      orderBy: [{ renewedAt: "desc" }, { id: "asc" }],
      take: SCAN_TAKE,
    }),
    prisma.lease.findMany({
      where: { expiredAt: { gt: now }, renewedAt: null },
      select: { id: true, issueId: true, createdAt: true, renewedAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: SCAN_TAKE,
    }),
  ]);
  // The merged pool is capped too: each run's probe row is older than the cap
  // worth of rows the run itself returned, so slicing the merged pool drops
  // exactly the rows the probe rows stand for. The pool holds every row both
  // runs returned, so its length above the cap is the exact overflow signal.
  const mergedLeases = mergeLeaseRuns(renewedRows, neverRenewedRows);
  const activeLeased = mergedLeases.slice(0, MAX_CANDIDATE_SCAN);
  const leasedTruncated = mergedLeases.length > MAX_CANDIDATE_SCAN;
  // (c) issues with an active AgentWork row. `updatedAt` moves on every
  // checkpoint/heartbeat write, so it is the row's most recent activity.
  const workingRows = await prisma.agentWork.findMany({
    where: { issueId: { not: null }, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
    select: { issueId: true },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: SCAN_TAKE,
  });
  const activeWorking = workingRows.slice(0, MAX_CANDIDATE_SCAN);
  const workingTruncated = workingRows.length > MAX_CANDIDATE_SCAN;

  // Seed the Set with the STRONGEST ownership signals first so the bounded
  // `cappedIds` slice below drops label-only candidates before ever dropping
  // an issue with an active lease or active AgentWork (both sources are
  // themselves capped at `MAX_CANDIDATE_SCAN` newest rows).
  const candidateIds = new Set<string>();
  for (const lease of activeLeased) candidateIds.add(lease.issueId);
  for (const work of activeWorking) {
    if (work.issueId !== null) candidateIds.add(work.issueId);
  }
  for (const issue of openLabeled) {
    if (issue.labels.some((label) => label.startsWith(AGENT_LABEL_PREFIX))) {
      candidateIds.add(issue.id);
    }
  }

  const cappedIds = [...candidateIds].slice(0, MAX_INSPECTED);
  const truncated = candidateIds.size > cappedIds.length;
  const inspected: Awaited<ReturnType<typeof inspectIssueOwnership>>[] = [];
  for (let i = 0; i < cappedIds.length; i += INSPECT_CONCURRENCY) {
    const batch = cappedIds.slice(i, i + INSPECT_CONCURRENCY);
    inspected.push(...(await Promise.all(batch.map((id) => inspectIssueOwnership(id, { now, live: false })))));
  }

  // Keep existing, open issues only (closed issues are terminal and dropped).
  const openResults = inspected.filter(
    (r): r is Extract<typeof r, { found: true }> => r.found && r.issue.state === "open",
  );

  const counts: Record<OwnershipState, number> = {} as Record<OwnershipState, number>;
  for (const state of OWNERSHIP_STATES) counts[state] = 0;
  for (const result of openResults) {
    counts[result.assessment.state] += 1;
  }

  const stateFiltered =
    stateParam === undefined || stateParam === ""
      ? openResults
      : openResults.filter((r) => r.assessment.state === (stateParam as OwnershipState));

  const items: OwnershipListItem[] = stateFiltered.slice(0, limit).map((r) => ({
    id: r.issue.id,
    number: r.issue.number,
    repoFullName: r.issue.repoFullName,
    state: r.issue.state,
    assessment: r.assessment,
    evidence: r.evidence,
  }));

  // #1254 reconciliation read surface (§9 inspect-first): the pending release
  // intents (the §8.7 barrier state) and the confirmation-ladder candidates,
  // so an operator can see what the reconciler observed without introducing
  // another queue system. Tokens are never surfaced — only their presence.
  const [releaseIntents, ladderCandidates, stuckGuards] = await Promise.all([
    prisma.ownershipReleaseIntent.findMany({ where: { phase: "pending" }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.ownershipReconcileCandidate.findMany({ orderBy: { updatedAt: "desc" }, take: 50 }),
    // #1254: guards left `executing` by a crashed process are fail-closed and
    // only an operator can clear them (a maintainer force-claim overrides) —
    // surface them so "stuck" is observable rather than silent.
    prisma.issueMutationGuard.findMany({ where: { executing: true }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);

  return NextResponse.json({
    items,
    counts,
    examined: openResults.length,
    truncated,
    sourcesTruncated: {
      labeled: labeledTruncated,
      leased: leasedTruncated,
      working: workingTruncated,
    },
    limit,
    windows: {
      activeMs: ownershipActiveWindowMs(),
      longRunGraceMs: ownershipLongRunGraceMs(),
    },
    reconciliation: {
      mode: ownershipReconcileMode(),
      maxReclaims: reconcileMaxReclaims(),
      recheckIntervalMs: reconcileRecheckIntervalMs(),
      maxForgeRetries: reconcileMaxForgeRetries(),
      guardHeartbeatMs: GUARD_HEARTBEAT_MS,
      guardOverrideMinAgeMs: GUARD_OVERRIDE_MIN_AGE_MS,
      pendingIntents: releaseIntents.map((intent) => ({
        id: intent.id,
        issueId: intent.issueId,
        agentLabel: intent.agentLabel,
        attemptTokenPresent: intent.attemptToken !== null,
        phase: intent.phase,
        attempts: intent.attempts,
        parkedAt: intent.parkedAt,
        createdAt: intent.createdAt,
      })),
      candidates: ladderCandidates.map((candidate) => ({
        issueId: candidate.issueId,
        agentName: candidate.agentName,
        staleCount: candidate.staleCount,
        firstStaleAt: candidate.firstStaleAt,
        lastObservedAt: candidate.lastObservedAt,
        reclaimCount: candidate.reclaimCount,
        lastReclaimAt: candidate.lastReclaimAt,
        lastReasons: candidate.lastReasons,
      })),
      // Every in-flight guard, live or crashed — the operator reads SILENCE:
      // a live holder stamps `updatedAt` every GUARD_HEARTBEAT_MS (#1254
      // round 4), so `overrideEligible` says precisely whether a maintainer
      // force-claim may clear it. A NON-eligible guard that the operator
      // still believes stuck is a live-but-wedged holder: the recovery is
      // restarting its process, not stealing the anchor.
      executingGuards: stuckGuards.map((guard) => ({
        issueId: guard.issueId,
        operation: guard.operation,
        agentName: guard.agentName,
        ownerTokenPresent: guard.ownerToken !== "",
        createdAt: guard.createdAt,
        updatedAt: guard.updatedAt,
        silentMs: Date.now() - guard.updatedAt.getTime(),
        overrideEligible: Date.now() - guard.updatedAt.getTime() >= GUARD_OVERRIDE_MIN_AGE_MS,
      })),
    },
  });
}
