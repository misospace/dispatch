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
  // rows — rather than inferred from a filled-up page.
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
  // (b) issues referenced by an active (non-expired) lease. Freshness keys on
  // `createdAt` FIRST, not `renewedAt`: `upsertLease`'s create path never sets
  // `renewedAt`, so every newly claimed lease is NULL there, and a nulls-last
  // primary key on `renewedAt` would sort those past the cap — keeping
  // long-renewed claims and dropping the newest ones, backwards for a "who owns
  // what right now" surface. `renewedAt` (nulls-last) then `id` break ties
  // deterministically so equal timestamps cannot reorder between runs.
  const leasedRows = await prisma.lease.findMany({
    where: { expiredAt: { gt: now } },
    select: { issueId: true },
    orderBy: [
      { createdAt: "desc" },
      { renewedAt: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ],
    take: SCAN_TAKE,
  });
  const activeLeased = leasedRows.slice(0, MAX_CANDIDATE_SCAN);
  const leasedTruncated = leasedRows.length > MAX_CANDIDATE_SCAN;
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
  });
}
