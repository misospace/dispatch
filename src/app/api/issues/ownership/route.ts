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
 * Bounded: the label sweep is capped and only the first `MAX_INSPECTED`
 * candidates are derived; `truncated: true` says candidates were dropped, so
 * `counts`/`examined` describe the inspected set, not the whole population.
 *
 * Operator-only: worker-tier callers get 403 by the central tiering (this
 * route is not in `WORKER_ALLOWLIST`), not by any local check.
 *
 * Query params:
 * - `state` — filter by derived ownership state; must be one of
 *   `OWNERSHIP_STATES` (400 otherwise).
 * - `limit` — cap on returned items (default 50, clamped to 1..200).
 *
 * Response: `{ items, counts, examined, truncated, limit, windows }`, where
 * `counts` and `examined` reflect the inspected (open) population before the
 * state filter and limit are applied.
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

  // Bounded scan: this is an operator inspection surface, not an index. The
  // open-issue sweep is capped (most recently updated first) and the total
  // number of per-candidate derivations is capped with chunked concurrency so
  // one maintainer request cannot amplify into an unbounded query storm.
  const MAX_CANDIDATE_SCAN = 1000;
  const MAX_INSPECTED = 500;
  const INSPECT_CONCURRENCY = 25;

  // (a) open issues holding an agent/* label (cached set)
  const openLabeled = await prisma.issue.findMany({
    where: { repository: { enabled: true }, state: "open" },
    select: { id: true, labels: true },
    orderBy: { updatedAt: "desc" },
    take: MAX_CANDIDATE_SCAN,
  });
  // (b) issues referenced by an active (non-expired) lease
  const activeLeased = await prisma.lease.findMany({
    where: { expiredAt: { gt: now } },
    select: { issueId: true },
  });
  // (c) issues with an active AgentWork row
  const activeWorking = await prisma.agentWork.findMany({
    where: { issueId: { not: null }, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
    select: { issueId: true },
  });

  // Seed the Set with the STRONGEST ownership signals first so the bounded
  // `cappedIds` slice below drops label-only candidates before ever dropping
  // an issue with an active lease or active AgentWork (both are naturally
  // bounded by the number of live claims).
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
    limit,
    windows: {
      activeMs: ownershipActiveWindowMs(),
      longRunGraceMs: ownershipLongRunGraceMs(),
    },
  });
}
