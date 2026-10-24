import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope, enforceWorkerBound } from "@/lib/worker-identity";
import { releaseLeaseByAgentAndIssue, releaseAllLeasesByAgent, releaseAgentWorkByAgentAndIssue, upsertLease } from "@/lib/lease";
import { AGENT_WORK_LEASE_DURATION_MS } from "@/lib/agent-work";
import { supersedeOwnershipReleaseIntent } from "@/lib/ownership-reconciliation";
import { enforceRateLimit } from "@/lib/rate-limit";
import { addIssueLabel } from "@/lib/github";
import { getLiveIssueLabels } from "@/lib/claim-gate";
import { releaseIssueClaim, fencedClaimClient, releaseIssueClaimWorstCaseCalls } from "@/lib/issue-claim";
import { recordClaimEvent } from "@/lib/issue-lifecycle";
import { buildNewLabels } from "@/lib/assignment-conflicts";
import { withIssueMutationGuard, fencedWriteTimeoutForCalls } from "@/lib/issue-mutation-guard";
import { AGENT_PREFIX } from "@/types";

export const dynamic = "force-dynamic";

interface AgentWorkItem {
  id: string;
  agentName: string;
  issueId: string | null;
  runId: string | null;
  state: string;
  checkpoint: string;
  branch: string | null;
  prUrl: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date;
  summary: string | null;
  blockerReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  issueNumber: number | null;
  issueTitle: string | null;
  repoFullName: string | null;
}

function toItem(w: any): AgentWorkItem {
  return {
    id: w.id,
    agentName: w.agentName,
    issueId: w.issueId,
    runId: w.runId,
    state: w.state,
    checkpoint: w.checkpoint,
    branch: w.branch,
    prUrl: w.prUrl,
    leaseExpiresAt: w.leaseExpiresAt,
    lastHeartbeatAt: w.lastHeartbeatAt,
    summary: w.summary,
    blockerReason: w.blockerReason,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    issueNumber: w.issue?.number ?? null,
    issueTitle: w.issue?.title ?? null,
    repoFullName: w.issue?.repository?.fullName ?? null,
  };
}

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const { searchParams } = new URL(request.url);
  const stateFilter = searchParams.get("state");
  const agentNameFilter = searchParams.get("agent");
  const includeStale = searchParams.get("include_stale") !== "false";

  // #1129: a bound worker may only list its own agent's work — the `?agent=`
  // filter can never widen its scope. An unbound legacy worker token is
  // refused here.
  const boundWorkerAgent =
    auth.authorized && auth.type === "bearer" ? auth.agentName : undefined;
  const unboundError = await enforceWorkerBound(auth);
  if (unboundError) return unboundError;
  if (boundWorkerAgent && agentNameFilter && agentNameFilter !== boundWorkerAgent) {
    const scopeError = await enforceWorkerAgentScope(auth, agentNameFilter);
    if (scopeError) return scopeError;
  }
  const effectiveAgentFilter = boundWorkerAgent ?? agentNameFilter;

  try {
    const where: Record<string, unknown> = {};

    if (stateFilter) {
      where.state = stateFilter;
    } else {
      where.OR = [
        { state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
        ...(includeStale ? [{ state: "STALE" }] : []),
      ];
    }

    if (effectiveAgentFilter) {
      where.agentName = effectiveAgentFilter;
    }

    const activeItems = await prisma.agentWork.findMany({
      where,
      orderBy: { lastHeartbeatAt: "desc" },
      include: {
        issue: {
          select: { number: true, title: true, repository: { select: { fullName: true } } },
        },
      },
    });

    const items: AgentWorkItem[] = activeItems.map(toItem);

    const now = new Date();
    // #1129: a bound worker's stale-lease view is scoped to its own agent too;
    // otherwise the listing would leak every other agent's leases.
    const leaseWhere: Record<string, unknown> = { expiredAt: { lte: now } };
    if (effectiveAgentFilter) leaseWhere.agentName = effectiveAgentFilter;
    const expiredLeases = await prisma.lease.findMany({
      where: leaseWhere,
      orderBy: { expiredAt: "asc" },
      take: 50,
      include: {
        issue: {
          select: { number: true, title: true, repository: { select: { fullName: true } } },
        },
      },
    });

    const staleLeases = expiredLeases.map((l: any) => ({
      id: `lease-${l.id}`,
      agentName: l.agentName,
      issueId: l.issueId,
      runId: null,
      state: "STALE",
      checkpoint: l.checkpoint,
      branch: l.branch,
      prUrl: l.prUrl,
      leaseExpiresAt: l.expiredAt,
      lastHeartbeatAt: l.renewedAt ?? l.createdAt,
      summary: null,
      blockerReason: "Lease expired",
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      issueNumber: l.issue?.number ?? null,
      issueTitle: l.issue?.title ?? null,
      repoFullName: l.issue?.repository?.fullName ?? null,
    }));

    return NextResponse.json({ activeWork: items, staleLeases });
  } catch (error) {
    return handleApiError("fetch agent work", error);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`agent-work:${auth.throttleKey}`, { limit: 30, windowMs: 10_000 });
  if (limited) return limited;

  try {
    const body = await request.json();
    const action = body.action as string;

    if (action === "release") {
      return await releaseAgentWork(body);
    } else if (action === "reassign") {
      return await reassignAgentWork(body);
    } else {
      return errorResponse("Unknown action", 400);
    }
  } catch (error) {
    console.error("Failed to process agent work action:", error);
    return errorResponse("Failed to process request", 500);
  }
}

async function releaseAgentWork(body: Record<string, unknown>) {
  const workId = typeof body.workId === "string" ? body.workId : null;
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : null;
  const agentName = typeof body.agentName === "string" ? body.agentName : null;
  const issueId = typeof body.issueId === "string" ? body.issueId : null;
  const releaseAll = body.releaseAll === true;
  const reason = typeof body.reason === "string" ? body.reason : "Released by operator";

  // Original release path by workId or leaseId (backward compatible)
  if (workId || leaseId) {
    try {
      let work = null;

      if (workId) {
        const existing = await prisma.agentWork.findUnique({ where: { id: workId } });
        if (!existing) {
          return errorResponse("Work item not found", 404);
        }
        // #1254: an operator release supersedes a pending reconciler release
        // intent (audited) instead of racing its Phase-B delete.
        if (existing.issueId) {
          await supersedeOwnershipReleaseIntent({ issueId: existing.issueId, actor: "operator", reason: "operator agent-work release" });
        }
        if (existing.state === "DONE" || existing.state === "RELEASED") {
          return errorResponse("Work is already completed or released", 400);
        }

        work = await prisma.$transaction(async (tx) => {
          const updated = await tx.agentWork.update({
            where: { id: workId },
            data: { state: "RELEASED", leaseExpiresAt: new Date() },
            include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
          });
          await tx.agentWorkHistory.create({
            data: { workId, action: "released", summary: reason },
          });
          return updated;
        });

        await prisma.auditLog.create({
          data: {
            actor: "operator",
            action: "agent_work_released",
            repoFullName: work.issue?.repository?.fullName ?? "",
            issueNumber: work.issue?.number,
            issueId: work.issueId,
            success: true,
            notes: `Released work for agent ${work.agentName}: ${reason}`,
          },
        });
      }

    if (leaseId) {
        const lease = await prisma.lease.findUnique({ where: { id: leaseId }, include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } } });
        if (!lease) {
          return errorResponse("Lease not found", 404);
        }

        // #1254: operator release supersedes a pending reconciler intent.
        await supersedeOwnershipReleaseIntent({ issueId: lease.issueId, actor: "operator", reason: "operator lease release" });
        await prisma.lease.delete({ where: { id: leaseId } });

        await prisma.auditLog.create({
          data: {
            actor: "operator",
            action: "lease_released",
            repoFullName: lease.issue?.repository?.fullName ?? "",
            issueNumber: lease.issue?.number,
            issueId: lease.issueId,
            success: true,
            notes: `Released lease for agent ${lease.agentName}: ${reason}`,
          },
        });
      }

      return NextResponse.json({ success: true, reason });
    } catch (error) {
      console.error("Failed to release agent work:", error);
      await prisma.auditLog.create({
        data: {
          actor: "operator",
          action: "agent_work_release_failed",
          repoFullName: "",
          success: false,
          errorMessage: String(error),
        },
      });
      return errorResponse("Failed to release agent work", 500);
    }
  }

  // New release path by agentName + issueId (operator recovery for orphaned work)
  if (!agentName) {
    return errorResponse("Missing workId, leaseId, or agentName", 400);
  }

  try {
    let releasedLeases = 0;
    let releasedWork = 0;
    let repoFullName = "";
    let issueNumber: number | null = null;

    if (issueId) {
      // #1254: operator release supersedes a pending reconciler intent.
      await supersedeOwnershipReleaseIntent({ issueId, actor: "operator", reason: "operator agent-work release" });
      // Release by agentName + issueId
      const [leasesReleased, workReleased] = await Promise.all([
        releaseLeaseByAgentAndIssue(agentName, issueId),
        releaseAgentWorkByAgentAndIssue(agentName, issueId),
      ]);
      releasedLeases = leasesReleased;
      releasedWork = workReleased;

      // Get issue details for audit log
      const issue = await prisma.issue.findUnique({
        where: { id: issueId },
        select: { number: true, repository: { select: { fullName: true } } },
      });
      if (issue) {
        repoFullName = issue.repository.fullName;
        issueNumber = issue.number;
      }
    } else if (releaseAll) {
      // Release all active work for an agent
      const [leasesReleased, workItems] = await Promise.all([
        releaseAllLeasesByAgent(agentName),
        prisma.agentWork.findMany({
          where: { agentName, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
          select: { id: true, issueId: true },
        }),
      ]);
      releasedLeases = leasesReleased;

      // Release each work item and collect repo info from the first one
      if (workItems.length > 0) {
        const now = new Date();
        await prisma.$transaction(
          workItems.map((w: any) =>
            prisma.agentWork.update({
              where: { id: w.id },
              data: { state: "RELEASED", leaseExpiresAt: now },
            })
          )
        );
        await prisma.$transaction(
          workItems.map((w: any) =>
            prisma.agentWorkHistory.create({
              data: { workId: w.id, action: "released_by_operator", summary: `Released all work for agent ${agentName}: ${reason}` },
            })
          )
        );
        releasedWork = workItems.length;

        // Get repo info from the first issue that has one
        const firstIssue = await prisma.agentWork.findFirst({
          where: { id: workItems[0].id },
          include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
        });
        if (firstIssue?.issue) {
          repoFullName = firstIssue.issue.repository.fullName;
          issueNumber = firstIssue.issue.number;
        }
      }
    } else {
      return errorResponse("Missing required field: issueId, or set releaseAll: true", 400);
    }

    await prisma.auditLog.create({
      data: {
        actor: "operator",
        action: "orphan_work_released",
        repoFullName,
        issueNumber: issueNumber ?? undefined,
        issueId: issueId ?? undefined,
        success: true,
        notes: `Released ${releasedLeases} lease(s) and ${releasedWork} work item(s) for agent ${agentName}: ${reason}`,
      },
    });

    return NextResponse.json({
      success: true,
      reason,
      releasedLeases,
      releasedWork,
    });
  } catch (error) {
    console.error("Failed to release agent work:", error);
    await prisma.auditLog.create({
      data: {
        actor: "operator",
        action: "orphan_work_release_failed",
        repoFullName: "",
        success: false,
        errorMessage: String(error),
      },
    });
    return errorResponse("Failed to release agent work", 500);
  }
}

type ReassignWorkTx = Prisma.TransactionClient;

/**
 * The AgentWork-row half of the handover: retire the old owner's row, free
 * the new agent's other active work (single work per agent), and rewrite the
 * row `CLAIMED` for the new owner. Local writes only — the claim half (the
 * `Lease` row and the `agent/*` label) moves in `reassignAgentWork` around
 * this.
 */
async function reassignWorkRowsTx(tx: ReassignWorkTx, workId: string, newAgentName: string, reason: string) {
  // One instant for the whole handover: the old owner's lease expires now,
  // and the new owner's claim starts from the same instant.
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + AGENT_WORK_LEASE_DURATION_MS);

  // Release old agent's work
  await tx.agentWork.update({
    where: { id: workId },
    data: { state: "RELEASED", leaseExpiresAt: now },
  });
  await tx.agentWorkHistory.create({
    data: { workId, action: "reassigned", summary: `${reason} -> ${newAgentName}` },
  });

  // Release all existing active work for the new agent (single work per agent)
  const newAgentActive = await tx.agentWork.findMany({
    where: { agentName: newAgentName, state: { in: ["CLAIMED", "IN_PROGRESS"] } },
  });
  for (const active of newAgentActive) {
    await tx.agentWork.update({
      where: { id: active.id },
      data: { state: "RELEASED", leaseExpiresAt: now },
    });
    await tx.agentWorkHistory.create({
      data: { workId: active.id, action: "released_by_reassignment" },
    });
  }

  return tx.agentWork.update({
    where: { id: workId },
    // #1391: settle the marker the sweep's mark leaves when it parks a
    // row for its retry arm (`state: "STALE"`,
    // `staleClaimReleasePending: true`). Reassigning rewrites the row to
    // `CLAIMED` for the new owner, so carrying the marker over would
    // strand the owed release on a live-shaped row: the sweep's reclaim
    // arms require the marker cleared and its retry arm requires
    // `state: "STALE"`, which this write no longer satisfies — no
    // component could advance it. The operator's reassignment supersedes the sweep's
    // decision on the row, so the rewrite settles it here; the sweep
    // stays the single owner of retiring an owed release elsewhere.
    //
    // PR #1393 review: the rewrite must also leave the row with a LIVE
    // lease. The RELEASED write above stamps `leaseExpiresAt` with `now`,
    // so a rewrite that left the field alone would carry an expiry that
    // is already in the past into the `CLAIMED` shape — a shape no claim
    // path produces. The sweep's reclaim arm
    // (`src/lib/stale-work.ts:161`) fires on
    // `lastHeartbeatAt < cutoff OR leaseExpiresAt < cutoff`, so an expiry
    // that is not ahead of the heartbeat lets the EXPIRY arm fire at the
    // same instant as the heartbeat arm instead of strictly after it.
    // The handover is a fresh claim, so it carries the claim path's lease
    // horizon (`AGENT_WORK_LEASE_DURATION_MS`, the same value
    // `startAgentWork`/`checkpointAgentWork` stamp): the expiry stays
    // ahead of the heartbeat, the reclaim stays governed by the heartbeat
    // window — exactly like a row from `startAgentWork` — and the field
    // never shrinks under the new owner.
    data: {
      agentName: newAgentName,
      state: "CLAIMED",
      lastHeartbeatAt: now,
      leaseExpiresAt,
      staleClaimReleasePending: false,
    },
    include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
  });
}

async function reassignAgentWork(body: Record<string, unknown>) {
  const workId = typeof body.workId === "string" ? body.workId : null;
  const newAgentName = typeof body.newAgentName === "string" ? body.newAgentName : null;
  const reason = typeof body.reason === "string" ? body.reason : "Reassigned by operator";

  if (!workId) {
    return errorResponse("Missing workId", 400);
  }
  if (!newAgentName) {
    return errorResponse("Missing newAgentName", 400);
  }

  try {
    const existing = await prisma.agentWork.findUnique({
      where: { id: workId },
      include: { issue: { select: { number: true, repository: { select: { fullName: true } } } } },
    });

    if (!existing) {
      return errorResponse("Work item not found", 404);
    }

    // #1395: a work row with no issue has no claim (no Lease row, no
    // `agent/*` label) — the row half of the handover is all there is.
    if (!existing.issueId) {
      const work = await prisma.$transaction((tx) => reassignWorkRowsTx(tx, workId, newAgentName, reason));
      await prisma.auditLog.create({
        data: {
          actor: "operator",
          action: "agent_work_reassigned",
          repoFullName: work.issue?.repository?.fullName ?? "",
          issueNumber: work.issue?.number,
          issueId: work.issueId,
          success: true,
          notes: `Reassigned work from ${existing.agentName} to ${newAgentName}: ${reason}`,
        },
      });
      return NextResponse.json({ success: true, work, claimMoved: false });
    }

    const issueId = existing.issueId;
    const oldAgentName = existing.agentName;
    const newAgentLabel = `${AGENT_PREFIX}${newAgentName}`;

    // #1395: move the CLAIM with the work row. Before this, a handover from
    // A to B left A's `Lease` row live (so B's `POST /api/issues/claim` was
    // refused 409 until it expired), left B's reassigned `AgentWork` row
    // lease-less (so the claim route's stale cleanup deleted it along with
    // its checkpoint/branch/prUrl), and left A's `agent/*` label on the
    // issue (so the board still listed the work under A). The whole
    // handover runs under the per-issue mutation anchor, and every remote
    // OWNERSHIP write runs inside the fenced write, exactly like the claim,
    // unclaim and capacity-release paths that guard the same anchor.
    const guarded = await withIssueMutationGuard(
      { issueId, operation: "reassign", agentName: newAgentName },
      async (_tx, { runFencedRemoteWrite }): Promise<{ complete: boolean; value: Response }> => {
        // The audit targets: canonical once the issue is read, empty until
        // then (a read failure still audits the attempt).
        let auditRepoFullName = "";
        let auditIssueNumber: number | undefined;

        // The callback catches its own failures so the guard is released on
        // EVERY handled path (same posture as the unclaim route, #1361): a
        // reassign guard has no resume branch, so a demoted row would wedge
        // every writer on the issue. Even the issue re-read runs INSIDE the
        // try — a transient failure there must land in this catch, not
        // escape into the guard's demote path.
        try {
          const issue = await prisma.issue.findUnique({
            where: { id: issueId },
            include: { repository: true },
          });
          if (!issue) {
            return { complete: true, value: errorResponse("Issue not found in local cache", 404) };
          }
          const repoFullName = issue.repository.fullName;
          const issueNumber = issue.number;
          auditRepoFullName = repoFullName;
          auditIssueNumber = issueNumber;
          // The operator handover supersedes a pending reconciler release
          // intent (audited) instead of racing its Phase-B delete — the same
          // exemption the operator release and force-claim paths take (#1254).
          await supersedeOwnershipReleaseIntent({
            issueId,
            actor: "operator",
            reason: "operator agent-work reassign",
          });

          // The ownership decision is made against the labels GitHub
          // currently has, not the cache (#1037). Fail closed: no intent
          // supersede beyond the audited one above, no label write, no lease.
          let liveLabels: string[];
          try {
            liveLabels = await getLiveIssueLabels(repoFullName, issueNumber);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            return {
              complete: true,
              value: errorResponse(`Could not verify live GitHub labels: ${errorMessage}`, 503),
            };
          }

          // A plain handover moves the claim from the work row's owner to
          // the new owner. If a THIRD agent holds the live claim, moving
          // would either stack `agent/*` labels or silently evict a claim the
          // operator did not name — refuse instead; resolve that claim first.
          const foreignAgentLabel = liveLabels.find(
            (label) =>
              label.startsWith(AGENT_PREFIX) &&
              label !== newAgentLabel &&
              label !== `${AGENT_PREFIX}${oldAgentName}`,
          );
          if (foreignAgentLabel) {
            return {
              complete: true,
              value: errorResponse(
                `Issue is assigned to ${foreignAgentLabel.slice(AGENT_PREFIX.length)}; resolve that claim before reassigning`,
                409,
              ),
            };
          }

          // The release's dedupe identity is ONE CLAIM EPOCH, not the work
          // row's lifetime: a later handover cycle can release the SAME
          // `agent/<old>` label on the SAME issue in a different epoch (A→B,
          // B→A, A→B on one row), and an identity keyed only off the work row
          // would upsert that later release onto the first epoch's
          // `claim_released` row and swallow it. The old owner's lease row IS
          // the epoch, and step 5's transaction destroys it as part of every
          // COMPLETED handover, so the next epoch of the same agent re-mints
          // a fresh row/token and can never re-read this identity. A failed
          // handover keeps the row (and this identity) intact, so its retry
          // converges on the same evidence row. ONE exception: a same-owner
          // replay (`newAgentName === oldAgentName`) renews the same row and
          // its token survives, so the replay's release and a LATER real
          // handover of that owner share this key and the later
          // `claim_released` upserts onto the replay's row (audit stream
          // only — the replay releases and re-adds the same label, and every
          // lease/label/row end state stays correct). Once the row is
          // already gone an attempt keyed off the work row still converges
          // its OWN retries onto one row (at worst, a retry that runs after
          // the teardown records a second, explicitly-labelled
          // already-released row — noise, not a swallowed release).
          const oldClaim = await prisma.lease.findFirst({
            where: { agentName: oldAgentName, issueId },
            orderBy: { expiredAt: "desc" },
            select: { id: true, claimToken: true },
          });
          const releaseKey = `agent-work-reassign:${workId}:${oldClaim?.claimToken ?? oldClaim?.id ?? "no-lease"}`;

          // 1. Release the old owner's claim THROUGH the shared claim-release
          // path, so the `agent/*` removal, the cache mirror and the
          // `claim_released` evidence row commit inside the fenced
          // transaction (issue #1395 note: a plain label edit would bypass
          // the anchor and the lifecycle stream). `preserveStatus`: the work
          // CONTINUES under the new owner — the issue must not fall back to
          // ready as part of a handover. `allowMissingAgent`: a cache/live
          // divergence where the label is already gone is a repair (the
          // DELETE is idempotent), not a failure that blocks the handover.
          const released = await runFencedRemoteWrite(
            (tx) =>
              releaseIssueClaim({
                prisma: fencedClaimClient(tx),
                issue: {
                  id: issue.id,
                  state: issue.state,
                  labels: liveLabels,
                  blockedReason: issue.blockedReason,
                  linkedPrNumber: issue.linkedPrNumber,
                },
                repoFullName,
                issueNumber,
                agentName: oldAgentName,
                options: {
                  allowMissingAgent: true,
                  preserveStatus: true,
                  // A handover MOVES the claim: the old owner's label must go
                  // even when the new owner's label is ALREADY on the issue (a
                  // retry of the same handover, or a half-applied one). The
                  // shared release refuses that case by default — it reads the
                  // FIRST `agent/*` label, so it refuses whenever the new
                  // owner's label comes first — and the refusal would leave
                  // BOTH labels on GitHub (#1407 review). The foreign-agent
                  // check above is what proves the other label belongs to the
                  // intended new owner.
                  allowOtherAgentPresent: true,
                  source: "api:unclaim",
                  actor: "operator",
                  releaseKey,
                },
              }),
            {
              timeoutMs: fencedWriteTimeoutForCalls(
                releaseIssueClaimWorstCaseCalls(liveLabels),
              ),
            },
          );
          if (released.status === "guard-lost") {
            try {
              await prisma.auditLog.create({
                data: {
                  actor: "operator",
                  action: "agent_work_reassign_failed",
                  repoFullName,
                  issueNumber,
                  issueId,
                  beforeLabels: issue.labels,
                  afterLabels: [],
                  success: false,
                  errorMessage:
                    "Reassign was superseded by an operator override before the remote claim release",
                },
              });
            } catch {
              // Audit log failure should not mask the 409
            }
            return {
              complete: true,
              value: errorResponse(
                "Reassign was superseded by an operator override before the remote claim release; retry shortly",
                409,
              ),
            };
          }

          // The release must have ACTUALLY released the old owner's claim. A
          // refused release (another agent's label present) leaves the old
          // owner's `agent/*` label on GitHub, and the add below would stack a
          // second one next to the new owner's — two owners on one issue, the
          // exact invariant the claim move exists to keep (#1407 review). Fail
          // closed instead: no lease teardown, no lease mint, no label add.
          //
          // Defence in depth: the move's opt-in above lets the shared release
          // touch a label set that carries another agent's label, so the
          // release's own refusal path cannot fire for the label set this
          // route passes. The check stands so a future release-side refusal
          // (or a label set that slips past the foreign-agent check) can never
          // be silently ignored — the handover would then stack two owners on
          // one issue.
          if (!released.value.released) {
            const skipReason = released.value.skipReason ?? "the claim release was refused";
            try {
              await prisma.auditLog.create({
                data: {
                  actor: "operator",
                  action: "agent_work_reassign_failed",
                  repoFullName,
                  issueNumber,
                  issueId,
                  beforeLabels: liveLabels,
                  afterLabels: [],
                  success: false,
                  errorMessage: `Claim release refused: ${skipReason}`,
                },
              });
            } catch {
              // Audit log failure should not mask the 409
            }
            return {
              complete: true,
              value: errorResponse(
                `Reassign refused: ${skipReason}; resolve that claim before reassigning`,
                409,
              ),
            };
          }

          // 2. The old owner's lease rows are NOT torn down here (#1407
          // review): the work row still belongs to the old owner until step
          // 4 moves it, and a `CLAIMED`/`IN_PROGRESS` row whose agent has no
          // active lease is exactly what
          // `findAndReleaseStaleAgentWorkForIssue` deletes — with its
          // checkpoint, branch and prUrl. Deleting the old lease before the
          // label add and the row move succeed would recreate that data-loss
          // failure on every failed handover (a lost add guard, a failed
          // GitHub write, a failed row-move transaction), which is the same
          // failure mode #1395 exists to eliminate. The UNCONDITIONAL
          // teardown (expired rows included — `upsertLease` renews a
          // surviving row keeping its id AND claim token, so an expired
          // survivor would hand a later epoch of the same agent the SAME
          // epoch identity this release just recorded; the expiry-filtered
          // `releaseLeaseByAgentAndIssue` operator helper is deliberately NOT
          // reused) therefore happens inside step 5's transaction, ATOMIC
          // with the row move (excluding the receipt step 3 mints — a
          // same-owner replay renews the same row): there is no window in
          // which the row is active and lease-less, and a failed handover
          // leaves the old owner's lease (and the operator's retry) intact.

          // 3. Mint the new owner's claim intent — the Lease row — BEFORE the
          // remote label add, the same §8.7 claim-side ordering the claim
          // route uses. This is also what keeps the reassigned `AgentWork`
          // row from being lease-less: the claim route's
          // `findAndReleaseStaleAgentWorkForIssue` deletes every
          // `CLAIMED`/`IN_PROGRESS` row whose agent has no active lease, and
          // it would otherwise take the handed-over row's checkpoint,
          // branch and prUrl with it (#1395). The branch/prUrl carry over so
          // the new owner's resume context survives the move.
          const receipt = await upsertLease({
            agentName: newAgentName,
            issueId,
            checkpoint: "issue_claimed",
            branch: existing.branch ?? undefined,
            prUrl: existing.prUrl ?? undefined,
            mutationGuardHeld: true,
          });

          // 4. Land the new owner's label inside the fenced write. The add is
          // idempotent, so a retry after a lost race converges. On a lost
          // guard delete ONLY a receipt this attempt minted (claim-route
          // rule: a renewal echoed a live attempt's own token, and that row
          // belongs to that attempt).
          const deleteMintedReceipt = async () => {
            if (!receipt.mintedToken) return;
            try {
              await prisma.lease.deleteMany({
                where: {
                  id: receipt.lease.id,
                  claimToken: receipt.lease.claimToken ?? null,
                  renewedAt: receipt.lease.renewedAt ?? null,
                },
              });
            } catch {
              // Best-effort: a failed cleanup must not mask the failure.
            }
          };

          const added = await (async () => {
            try {
              return await runFencedRemoteWrite(async () => {
                await addIssueLabel(repoFullName, issueNumber, newAgentLabel);
                return true;
              });
            } catch (error) {
              // The label write FAILED (a GitHub error, not a lost guard). The
              // new owner's lease receipt was minted BEFORE the add, so it
              // must not survive a failed add: a lease with no `agent/*` label
              // on the issue blocks every other agent's claim with a 409 until
              // it expires, and the new owner never got the claim. The
              // cleanup runs OUTSIDE the fenced region — the region rolled
              // back with the failed add.
              await deleteMintedReceipt();
              throw error;
            }
          })();
          if (added.status === "guard-lost") {
            await deleteMintedReceipt();
            try {
              await prisma.auditLog.create({
                data: {
                  actor: "operator",
                  action: "agent_work_reassign_failed",
                  repoFullName,
                  issueNumber,
                  issueId,
                  beforeLabels: liveLabels,
                  afterLabels: [],
                  success: false,
                  errorMessage:
                    "Reassign was superseded by an operator override before the remote label write",
                },
              });
            } catch {
              // Audit log failure should not mask the 409
            }
            return {
              complete: true,
              value: errorResponse(
                "Reassign was superseded by an operator override before the remote label write; retry shortly",
                409,
              ),
            };
          }

          // 5. Move the AgentWork row, retire the old owner's lease rows,
          // mirror the moved label in the cache, and record the new owner's
          // claim evidence — the cache mirror and the `claim` event commit
          // together (#1202), so the lifecycle stream never misses a
          // hand-over that already landed on GitHub. The old-owner lease
          // teardown is part of THIS transaction (#1407 review, step 2
          // above): the row changes owner and the old lease disappears in
          // one commit, so the work row is never left active and lease-less
          // for the stale cleanup to delete — not even on a failed add or a
          // failed row move, both of which roll the teardown back.
          //
          // The teardown EXCLUDES the receipt row step 3 just minted or
          // renewed: a same-owner replay (`newAgentName === oldAgentName`,
          // e.g. a duplicate POST after a completed handover) re-enters with
          // the new owner as the "old" one, and `upsertLease` RENEWS that
          // same row — deleting it here by agentName would leave the row
          // with its label back on GitHub but no lease, the exact
          // stale-cleanup data-loss shape (#1407 review, second round). On a
          // normal A→B move the exclusion is inert: the receipt belongs to B
          // and can never be one of A's rows.
          const updatedLabels = buildNewLabels(liveLabels, "assign_agent", newAgentLabel);
          const work = await prisma.$transaction(async (tx) => {
            await tx.lease.deleteMany({
              where: { agentName: oldAgentName, issueId, id: { not: receipt.lease.id } },
            });
            const moved = await reassignWorkRowsTx(tx, workId, newAgentName, reason);
            await tx.issue.update({
              where: { id: issueId },
              data: { labels: updatedLabels, lastSyncedAt: new Date() },
            });
            await recordClaimEvent(tx, {
              issueId,
              repoFullName,
              issueNumber,
              kind: "claim",
              source: "api:claim",
              actor: "operator",
              agentName: newAgentName,
              before: liveLabels,
              after: updatedLabels,
              // Same reasoning as the claim route: the GitHub writes are
              // outside this transaction, so the cached row (still the
              // pre-handover set here) supplies the before-state a retry of
              // this attempt is missing.
              mirroredBefore: issue.labels,
              metadata: { reassignedFrom: oldAgentName },
            });
            return moved;
          });

          await prisma.auditLog.create({
            data: {
              actor: "operator",
              action: "agent_work_reassigned",
              repoFullName: work.issue?.repository?.fullName ?? repoFullName,
              issueNumber: work.issue?.number ?? issueNumber,
              issueId: work.issueId,
              beforeLabels: liveLabels,
              afterLabels: updatedLabels,
              success: true,
              notes: `Reassigned work from ${oldAgentName} to ${newAgentName}: ${reason} | claim moved (lease + agent label)`,
            },
          });

          return { complete: true, value: NextResponse.json({ success: true, work, claimMoved: true }) };
        } catch (error) {
          console.error("Failed to reassign agent work:", error);
          try {
            await prisma.auditLog.create({
              data: {
                actor: "operator",
                action: "agent_work_reassign_failed",
                repoFullName: auditRepoFullName,
                issueNumber: auditIssueNumber,
                issueId,
                success: false,
                errorMessage: String(error),
              },
            });
          } catch {
            // A failing audit write must not escape the callback: an escaped
            // throw demotes the guard to a row no writer can resume (#1361).
          }
          return { complete: true, value: errorResponse("Failed to reassign agent work", 500) };
        }
      },
    );

    if (guarded.status === "busy") {
      return errorResponse("Issue mutation is in progress; retry shortly", 409);
    }
    return guarded.value;
  } catch (error) {
    console.error("Failed to reassign agent work:", error);
    await prisma.auditLog.create({
      data: {
        actor: "operator",
        action: "agent_work_reassign_failed",
        repoFullName: "",
        success: false,
        errorMessage: String(error),
      },
    });
    return errorResponse("Failed to reassign agent work", 500);
  }
}
