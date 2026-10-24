import { normalizeAgentWorkState, normalizeAgentWorkCheckpoint, AgentWorkState, AgentWorkCheckpoint } from "@/types";
import { nonEmpty } from "./pr-fix-queue";
import { findCurrentClaimWork } from "./worker-ownership";

/**
 * The lease horizon the CLAIM PATH stamps on an active AgentWork row: how
 * long the claim stays live without a heartbeat. `startAgentWork` stamps it
 * on every start and `checkpointAgentWork` on every checkpoint, so the
 * field's horizon is stable across a claim's writes. Writers outside the
 * claim path use their own horizons on purpose (the ownership renewal writes
 * its configurable renew TTL, a `blocked` disposition writes the park
 * deadline), so this constant names the claim path's horizon only — a writer
 * that stamped a different expiry would shrink the lease under the worker,
 * and one that left the field at a past timestamp would hand the sweep an
 * already-expired claim.
 */
export const AGENT_WORK_LEASE_DURATION_MS = 5 * 60 * 1000;

export type AgentWorkClient = {
  agentWork: {
    findUnique: (args: any) => Promise<any>;
    findFirst: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  agentWorkHistory: {
    create: (args: any) => Promise<any>;
  };
  $transaction: <T>(fn: (tx: AgentWorkClient) => Promise<T>) => Promise<T>;
};

/**
 * Canonical request schema for POST /api/agent-work/start
 * @body agentName (string, required) - Worker identifier, e.g. "saffron"
 * @body issueId (string, optional) - GitHub issue ID, e.g. "GH_issue_abc123"
 * @body runId (string, optional) - Agent run identifier for traceability
 * @body branch (string, optional) - Git branch name the worker will use
 *
 * Response 201: Created work object with state="CLAIMED", checkpoint="CLAIMED"
 * Response 400: { error: string } when required fields are missing or invalid
 * Response 401: { error: "Unauthorized" } when bearer token is missing/invalid
 */
export interface StartAgentWorkInput {
  agentName: string;
  issueId?: string | null;
  runId?: string | null;
  branch?: string | null;
}

/**
 * Canonical request schema for POST /api/agent-work/checkpoint
 *
 * The checkpoint value MUST be one of the valid AgentWorkCheckpoint values.
 * Workers should use the exact canonical value — no nesting, no casing variations.
 *
 * Valid checkpoints: CLAIMED, REPO_PREPARED, BRANCH_CREATED, CHANGES_MADE,
 *                    TESTS_RUNNING, PR_OPENED, DONE, BLOCKED
 *
 * @body agentName (string, required) - Worker identifier matching the active work record
 * @body checkpoint (string, required) - One of the valid checkpoint values listed above
 * @body summary (string, optional) - Human-readable description of progress made
 * @body blockerReason (string, optional) - Required when checkpoint is "BLOCKED"; explains why work cannot proceed
 *
 * Response 200: Updated work object reflecting new state/checkpoint and extended lease
 * Response 400: { error: string } with details about which field failed validation
 * Response 401: { error: "Unauthorized" } when bearer token is missing/invalid
 * Response 404: { error: "No active work found for agent" } when agent has no active work
 *               (also cleans up orphaned leases automatically)
 */
export interface CheckpointAgentWorkInput {
  agentName: string;
  checkpoint: string;
  summary?: string | null;
  blockerReason?: string | null;
  /**
   * Optional GitHub issue ID identifying the checkpoint's issue (#1328).
   * When present, selection is scoped to this issue's active rows so a
   * checkpoint can never heartbeat another issue's active work.
   */
  issueId?: string | null;
}

/**
 * Canonical request schema for POST /api/agent-work/finish
 *
 * The state value MUST be one of the valid AgentWorkState values.
 * Workers should use the exact canonical value — no nesting, no casing variations.
 *
 * Valid states: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE
 * Common finish states: DONE (work completed), BLOCKED (cannot proceed)
 *
 * @body agentName (string, required) - Worker identifier matching the active work record
 * @body state (string, required) - One of the valid state values listed above
 * @body summary (string, optional) - Final summary of what was accomplished or why blocked
 * @body issueId (string, optional) - GitHub issue ID this finish belongs to
 *                                   (POST /api/agent-work/finish); scopes selection
 *                                   to that issue's active rows (#1331)
 *
 * Response 200: Updated work object with final state set and lease expired
 * Response 400: { error: string } with details about which field failed validation
 * Response 401: { error: "Unauthorized" } when bearer token is missing/invalid
 * Response 404: { error: "No active work found for agent" } when agent has no active work
 *               (also cleans up orphaned leases automatically). When the request
 *               identified an issue, the message names it —
 *               { error: "No active work found for agent (issueId: …)" } — and the
 *               agent's other issues' work is never settled as a fallback.
 */
export interface FinishAgentWorkInput {
  agentName: string;
  state: string;
  summary?: string | null;
  /**
   * Optional GitHub issue ID identifying the finish's issue (#1331).
   * When present, selection is scoped to this issue's active rows so a
   * finish can never settle another issue's active work.
   *
   * Workers that know their issue should send it: without it the finish
   * settles the agent's FRESHEST active row, and a renewal on another issue
   * can reorder that pick — only the issue-scoped pick names the intended
   * attempt for certain.
   */
  issueId?: string | null;
}

/**
 * Parse and validate a request body for POST /api/agent-work/start.
 * Returns the parsed input object or { error: string } with a descriptive message.
 */
export function parseStartAgentWorkInput(body: unknown): StartAgentWorkInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body: expected an object" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName (string)" };

  return {
    agentName: input.agentName.trim(),
    issueId: typeof input.issueId === "string" ? input.issueId : null,
    runId: typeof input.runId === "string" ? input.runId : null,
    branch: typeof input.branch === "string" ? input.branch : null,
  };
}

/**
 * Parse and validate a request body for POST /api/agent-work/checkpoint.
 * Returns the parsed input object or { error: string } with a descriptive message.
 *
 * Valid checkpoint values: CLAIMED, REPO_PREPARED, BRANCH_CREATED, CHANGES_MADE,
 *                    TESTS_RUNNING, PR_OPENED, DONE, BLOCKED
 */
export function parseCheckpointAgentWorkInput(body: unknown): CheckpointAgentWorkInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body: expected an object with agentName and checkpoint" };
  const input = body as Record<string, unknown>;

  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName (string)" };
  if (typeof input.checkpoint !== "string") return { error: `Invalid checkpoint value: expected a string, got ${typeof input.checkpoint}` };
  if (input.checkpoint.trim().length === 0) return { error: "Missing required field: checkpoint (one of: CLAIMED, REPO_PREPARED, BRANCH_CREATED, CHANGES_MADE, TESTS_RUNNING, PR_OPENED, DONE, BLOCKED)" };

  const normalized = normalizeAgentWorkCheckpoint(input.checkpoint);
  if (!normalized) return { error: `Invalid checkpoint value: "${input.checkpoint}" (expected one of: CLAIMED, REPO_PREPARED, BRANCH_CREATED, CHANGES_MADE, TESTS_RUNNING, PR_OPENED, DONE, BLOCKED)` };

  // blockerReason is required (and must be a non-empty string) when BLOCKED.
  if (normalized === "BLOCKED") {
    if (input.blockerReason !== undefined && typeof input.blockerReason !== "string") {
      return { error: "Invalid blockerReason: expected a string when checkpoint is BLOCKED" };
    }
    if (!nonEmpty(input.blockerReason)) {
      return { error: "Missing required field: blockerReason (string) is required when checkpoint is BLOCKED" };
    }
  }

  return {
    agentName: input.agentName.trim(),
    checkpoint: normalized,
    summary: typeof input.summary === "string" ? input.summary : null,
    blockerReason: typeof input.blockerReason === "string" ? input.blockerReason : null,
    issueId: typeof input.issueId === "string" && nonEmpty(input.issueId.trim()) ? input.issueId.trim() : null,
  };
}

/**
 * Parse and validate a request body for POST /api/agent-work/finish.
 * Returns the parsed input object or { error: string } with a descriptive message.
 *
 * Valid state values: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE
 */
export function parseFinishAgentWorkInput(body: unknown): FinishAgentWorkInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body: expected an object with agentName and state" };
  const input = body as Record<string, unknown>;

  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName (string)" };
  if (typeof input.state !== "string") return { error: `Invalid state value: expected a string, got ${typeof input.state}` };
  if (input.state.trim().length === 0) return { error: "Missing required field: state (one of: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE)" };

  const normalized = normalizeAgentWorkState(input.state);
  if (!normalized) return { error: `Invalid state value: "${input.state}" (expected one of: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE)` };

  return {
    agentName: input.agentName.trim(),
    state: normalized,
    summary: typeof input.summary === "string" ? input.summary : null,
    issueId: typeof input.issueId === "string" && nonEmpty(input.issueId.trim()) ? input.issueId.trim() : null,
  };
}

export async function startAgentWork(client: AgentWorkClient, input: StartAgentWorkInput) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + AGENT_WORK_LEASE_DURATION_MS);

  return client.$transaction(async (tx) => {
    // Release all existing active work for this agent (single work per agent)
    const active = await tx.agentWork.findMany({
      where: { agentName: input.agentName, state: { in: ["CLAIMED", "IN_PROGRESS"] } },
    });
    for (const existing of active) {
      await tx.agentWork.update({
        where: { id: existing.id },
        data: { state: "RELEASED", leaseExpiresAt: now },
      });
      await tx.agentWorkHistory.create({
        data: { workId: existing.id, action: "released_by_new_claim" },
      });
    }

    const work = await tx.agentWork.create({
      data: {
        agentName: input.agentName,
        issueId: input.issueId ?? undefined,
        runId: input.runId ?? undefined,
        state: "CLAIMED",
        checkpoint: "CLAIMED",
        branch: input.branch ?? undefined,
        leaseExpiresAt,
        lastHeartbeatAt: now,
      },
    });

    await tx.agentWorkHistory.create({
      data: { workId: work.id, action: "start", state: "CLAIMED", checkpoint: "CLAIMED" },
    });

    return work;
  });
}

export async function checkpointAgentWork(client: AgentWorkClient, input: CheckpointAgentWorkInput) {
  const now = new Date();

  return client.$transaction(async (tx) => {
    // #1328: select the current claim's work through the shared deterministic
    // rule (freshest lastHeartbeatAt, then createdAt, then id), scoped to the
    // checkpoint's issue when the request identifies one. An unordered
    // findFirst could land on an older active sibling (e.g. a surviving
    // BLOCKED row) and stamp it with the freshest heartbeat while the real
    // attempt stays behind it; without issueId scoping it could heartbeat a
    // different issue's active row entirely.
    const existing = await findCurrentClaimWork(tx, input.agentName, input.issueId ?? undefined);

    if (!existing) {
      return null;
    }

    // Extend lease on heartbeat
    const leaseExpiresAt = new Date(now.getTime() + AGENT_WORK_LEASE_DURATION_MS);

    const updateData: Record<string, unknown> = {
      lastHeartbeatAt: now,
      leaseExpiresAt,
      checkpoint: input.checkpoint,
    };

    if (input.checkpoint === "BLOCKED") {
      updateData.state = "BLOCKED";
      updateData.blockerReason = input.blockerReason ?? existing.blockerReason;
    } else if (input.checkpoint === "DONE") {
      updateData.state = "DONE";
    } else if (existing.state === "CLAIMED" && input.checkpoint !== "CLAIMED") {
      updateData.state = "IN_PROGRESS";
    }

    if (input.summary) {
      updateData.summary = input.summary;
    }

    const work = await tx.agentWork.update({
      where: { id: existing.id },
      data: updateData,
    });

    await tx.agentWorkHistory.create({
      data: {
        workId: work.id,
        action: "checkpoint",
        state: updateData.state ? (updateData.state as AgentWorkState) : undefined,
        checkpoint: input.checkpoint,
        summary: input.summary ?? undefined,
        blockerReason: input.blockerReason ?? undefined,
      },
    });

    return work;
  });
}

export async function finishAgentWork(client: AgentWorkClient, input: FinishAgentWorkInput) {
  const now = new Date();
  const state = input.state as AgentWorkState;

  return client.$transaction(async (tx) => {
    // #1316 review / #1331: select the current claim's work through the
    // shared deterministic rule (freshest lastHeartbeatAt, then createdAt,
    // then id) instead of an unordered pick, scoped to the finish's issue when
    // the request identifies one. A `blocked` disposition parks its row as an
    // external wait that survives `startAgentWork` (which releases only
    // CLAIMED/IN_PROGRESS rows), so an unordered findFirst could terminalize
    // another issue's parked row while the attempt actually being finished
    // stays active — the same hazard #1328 closed for checkpoints. Without
    // issueId scoping the pick could also settle a different issue's active
    // row entirely.
    const existing = await findCurrentClaimWork(tx, input.agentName, input.issueId ?? undefined);

    if (!existing) {
      return null;
    }

    const work = await tx.agentWork.update({
      where: { id: existing.id },
      data: {
        state,
        leaseExpiresAt: now,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(state === "DONE" ? { checkpoint: "DONE" } : {}),
      },
    });

    await tx.agentWorkHistory.create({
      data: {
        workId: work.id,
        action: "finish",
        state,
        summary: input.summary ?? undefined,
      },
    });

    return work;
  });
}

export async function getActiveWorkByAgent(client: AgentWorkClient, agentName: string) {
  return client.agentWork.findMany({
    where: { agentName, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
    orderBy: { lastHeartbeatAt: "desc" },
  });
}

/**
 * Legacy simplified reclaim (transaction-only, no claim release). The live
 * sweeper is `sweepStaleWork` (`stale-work.ts`); this predicate mirrors its
 * per-state gate (#1316): `CLAIMED`/`IN_PROGRESS` rows are heartbeat-gated,
 * while a `BLOCKED` row is gated on its park deadline only — reclaimable
 * once `leaseExpiresAt` elapsed or when it never had one (NULL) — so a
 * parked blocked claim is never destroyed here either.
 */
function reclaimGateClauses(cutoff: Date) {
  return [
    {
      state: { in: ["CLAIMED", "IN_PROGRESS"] },
      OR: [{ lastHeartbeatAt: { lt: cutoff } }, { leaseExpiresAt: { lt: cutoff } }],
    },
    {
      state: "BLOCKED",
      OR: [{ leaseExpiresAt: { lt: cutoff } }, { leaseExpiresAt: null }],
    },
  ];
}

export async function releaseStaleWork(client: AgentWorkClient, maxAgeMs: number) {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return client.$transaction(async (tx) => {
    const stale = await tx.agentWork.findMany({
      where: {
        OR: reclaimGateClauses(cutoff),
      },
    });

    for (const work of stale) {
      const updated = await tx.agentWork.updateMany({
        where: {
          id: work.id,
          OR: reclaimGateClauses(cutoff),
        },
        data: { state: "STALE", leaseExpiresAt: new Date() },
      });
      if (updated.count !== 1) continue;
      await tx.agentWorkHistory.create({
        data: { workId: work.id, action: "stale" },
      });
    }

    return stale;
  });
}

/**
 * Find and delete AgentWork records for the given issue that have no
 * matching active Lease. This covers the crash/oom-kill scenario where an
 * agent leaves a CLAIMED/IN_PROGRESS AgentWork behind with no live lease.
 *
 * A lease carrying a still-running park (`retryAfter` in the future) protects
 * its agent here even after the ownership TTL elapsed: an `externalWait`
 * renewal parks the claim on the wait deadline while the row it heartbeats
 * stays CLAIMED/IN_PROGRESS, so deleting that row would erase a running park
 * through the claim path — exactly what the stale-work sweep's parked-claim
 * exclusion holds off (#1316, #1334). SQL 3VL: a NULL `retryAfter` matches
 * neither future arm. Once the park deadline passes the marker is spent and
 * the row follows the normal cleanup, as after the sweep.
 *
 * History entries are automatically cascaded via onDelete: Cascade.
 * An AuditLog entry is created for traceability.
 *
 * #1350: a row still owed a claim release (`staleClaimReleasePending`) is
 * never consumed here — neither the scan nor the delete takes one. This
 * cleanup is the repository's only `agentWork.deleteMany` (the sweep only
 * MARKS rows STALE), so leaving a pending row out of it is what keeps the
 * release the previous sweep decided on from being dropped. The sweep's own
 * boundary (`activeStateFamilies` in `stale-work.ts` is the canon) is
 * `staleClaimReleasePending: false`, mirrored here.
 *
 * The marker conjunct is LOAD-BEARING, not redundant with the state filter:
 * the operator reassign route rewrites a row to `state: "CLAIMED"` without
 * clearing the marker, so a sweep-marked `STALE` row can arrive here as an
 * ACTIVE-SHAPED row that still owes its release, and the state filter alone
 * would not keep it. Who retires it differs by shape: the sweep's retry arm
 * (`state: "STALE"`, `staleClaimReleasePending: true`) retires the owed
 * release of a STALE row, but an ACTIVE-SHAPED pending row belongs to NO
 * sweep arm — its reclaim arms require `staleClaimReleasePending: false` and
 * its retry arm requires `state: "STALE"` — so the sweep cannot retire it
 * either. This boundary is what keeps such a row, and the owed release it
 * carries, alive instead of dropping it; the stranded-release side of that
 * shape is tracked in #1391.
 *
 * The delete is fenced on the same conjuncts the scan matched, ownership
 * included: a row whose owner changed between the scan and the delete
 * (reassigned to another agent) is left to its new owner instead of being
 * deleted out from under it.
 *
 * #1390: a lease taken between the scan and the delete (the agent resumes
 * its work, or a force-claim takes the issue) keeps its row, through three
 * layers:
 *
 * 1. SCAN exclusion (`agentName: { notIn: activeAgentNames }`) — leases
 *    committed before the scan.
 * 2. IN-TRANSACTION RE-READ + per-candidate DECLINE — the protecting-lease
 *    set is re-derived inside the cleanup `$transaction` with the same
 *    predicate as the scan; a candidate whose agent holds a protecting lease
 *    at re-read time is not deleted, the count stays as-is, and no audit row
 *    claims the deletion. Declines are logged so they are not invisible.
 * 3. POST-CONSUME VERIFICATION + ROLLBACK — after the deletes, before the
 *    audit, the protecting-lease set is read a third time (fresh READ
 *    COMMITTED snapshot, so it observes every lease commit up to that
 *    statement). If any agent whose row WAS consumed now holds a protecting
 * lease, the whole transaction throws and rolls back: the delete lands
 * nowhere, no audit row is written, and the row is back exactly where it
 * started. The claim route (the only production caller) converts this
 * rejection into a retryable 503 INSIDE its guarded callback — an escaping
 * throw would demote the claim guard to `executing: false` and wedge every
 * other writer on the issue, the #1361/#1367 class — so a decline never
 * strands the anchor.
 *
 * The remaining window between the verification read and the COMMIT is
 * closed by SYNCHRONIZATION, not by snapshot timing: every lease-granting
 * writer holds the per-issue mutation guard ACROSS its lease commit —
 * `upsertLease` renews/creates under the guard (`lease.ts`; the claim route
 * passes `mutationGuardHeld` because it already holds it) and the ownership
 * renew/disposition paths run under `withOwnershipGuard` →
 * `withIssueMutationGuard`. The claim route — this cleanup's only production
 * caller — holds that same guard for the whole guarded region containing
 * this cleanup, so a guard-respecting lease acquisition cannot COMMIT inside
 * any window of the cleanup: it is `busy` before it ever writes, and a
 * renewal racing the guard fails as `mutation_busy`. The only residual is
 * the maintainer force-claim OVERRIDE of a guard whose holder has gone silent
 * past `GUARD_OVERRIDE_MIN_AGE_MS` (a live claim holder stamps every
 * `GUARD_HEARTBEAT_MS`, so this never hits an in-flight cleanup of a healthy
 * process) — the repo-wide accepted cost of the deliberate override,
 * documented in `issue-mutation-guard.ts`. The #1350 delete-fence conjuncts
 * above stay the last line of defense for non-lease shape changes, same as
 * before.
 *
 * Returns the count of deleted records.
 */
export async function findAndReleaseStaleAgentWorkForIssue(
  prisma: any,
  issueId: string,
  repoFullName: string,
): Promise<number> {
  // The protecting-lease predicate, shared by the scan, the in-transaction
  // re-read, and the post-consume verification (#1390): non-expired, or a
  // running park. Byte-identical arms keep the SQL-3VL NULL behavior
  // identical at every read.
  const protectingLeaseWhere = (asOf: Date) => ({
    issueId,
    OR: [{ expiredAt: { gt: asOf } }, { retryAfter: { gt: asOf } }],
  });

  // Active lease agent names for this issue: non-expired, or a running park.
  const now = new Date();
  const activeLeases = await prisma.lease.findMany({
    where: protectingLeaseWhere(now),
    select: { agentName: true },
  });

  const activeAgentNames = Array.from(new Set(activeLeases.map((l: any) => l.agentName)));

  // Find active AgentWork records for this issue whose agent has no active lease.
  //
  // #1350: the pending-release boundary is shared with the stale-work sweep
  // (`activeStateFamilies` in `stale-work.ts` is the canon) — a row still owed
  // a claim release is never this cleanup's to take. The state filter already
  // keeps a marked STALE row out; this conjunct additionally refuses an
  // active-shaped row that still owes its release, so a claim attempt cannot
  // hard-delete the release a previous sweep decided on.
  const staleWorks = await prisma.agentWork.findMany({
    where: {
      issueId,
      state: { in: ["CLAIMED", "IN_PROGRESS"] },
      staleClaimReleasePending: false,
      agentName: { notIn: activeAgentNames },
    },
    select: { id: true, agentName: true },
  });

  if (staleWorks.length === 0) return 0;

  // Delete + audit atomically so a deletion is never left without its audit
  // row. Each delete is fenced on the SAME conjuncts the scan matched (#1350):
  // the executing state family, the pending-release boundary, and the scanned
  // ownership fields (`issueId`, `agentName`), mirroring the sweep's own CAS
  // practice. A row that changed shape between the scan and the delete is
  // left for whoever now owns that shape, and the audit (and the returned
  // count) report exactly the rows the fence actually consumed.
  //
  // The claim route (this function's only production caller) runs this cleanup
  // inside the per-issue mutation guard, but the writers it races with do NOT
  // take that guard: the operator agent-work routes (release / release-all /
  // reassign — `src/app/api/agent-work/route.ts`), the operator unclaim path
  // (`releaseAgentWorkByAgentAndIssue` — `src/lib/lease.ts`, called from
  // `src/app/api/issues/unclaim/route.ts` AFTER its guarded block) and the
  // worker agent-work start / checkpoint / finish paths (`src/lib/agent-work.ts`).
  // The fence (not the guard) is therefore the load-bearing protection here;
  // preserving the row is the safe direction in every case. The stale-work
  // sweep — the only writer that SETS the pending marker — does take the
  // guard, so it normally cannot interleave with the claim path (a maintainer
  // force-claim may override that guard); either way the fence's pending
  // conjunct refuses a row that became pending after the scan, so the
  // reachable pending shape is one that ARRIVES pending (the operator
  // reassign route's leftover marker).
  // One CAS delete per candidate row (N = the issue's leftover rows), all
  // inside the transaction: a failure rolls the whole cleanup back, so a
  // partial delete without its audit row is not reachable.
  const deletedIds: string[] = [];
  const consumedAgentNames: string[] = [];
  const declinedAgentNames: string[] = [];

  await prisma.$transaction(async (tx: any) => {
    // #1390 layer 2: re-read the protecting-lease set inside the transaction.
    // The scan's exclusion was evaluated at scan time; a lease taken after it
    // (agent resume, force-claim) must protect its row, and the fenced
    // delete's own conjuncts cannot observe it.
    const txNow = new Date();
    const liveLeases = await tx.lease.findMany({
      where: protectingLeaseWhere(txNow),
      select: { agentName: true },
    });
    const liveAgentNames = new Set<string>(liveLeases.map((l: any) => l.agentName));

    for (const work of staleWorks) {
      if (liveAgentNames.has(work.agentName)) {
        declinedAgentNames.push(work.agentName);
        continue;
      }
      const deleted = await tx.agentWork.deleteMany({
        where: {
          id: work.id,
          issueId,
          agentName: work.agentName,
          state: { in: ["CLAIMED", "IN_PROGRESS"] },
          staleClaimReleasePending: false,
        },
      });
      if ((deleted?.count ?? 0) === 1) {
        deletedIds.push(work.id);
        consumedAgentNames.push(work.agentName);
      }
    }

    if (deletedIds.length === 0) return;

    // #1390 layer 3: post-consume verification. This read takes a fresh READ
    // COMMITTED snapshot, so it observes every lease commit that landed up to
    // this statement — including one that raced in BETWEEN the re-read above
    // and the deletes. A lease for an agent whose row was just consumed means
    // the cleanup raced live work it must not clobber, so the whole
    // transaction ABORTS: the deletes roll back, no audit row is written, and
    // the caller fails closed. The residual commit-after-verification window
    // is closed by the per-issue mutation guard (docblock), not by this read.
    const verifyNow = new Date();
    const finalLeases = await tx.lease.findMany({
      where: protectingLeaseWhere(verifyNow),
      select: { agentName: true },
    });
    const finalLiveAgentNames = new Set<string>(finalLeases.map((l: any) => l.agentName));
    const racedAgentNames = Array.from(new Set(consumedAgentNames.filter((a) => finalLiveAgentNames.has(a))));
    if (racedAgentNames.length > 0) {
      throw new Error(
        `[agent-work] stale cleanup aborted for issue ${issueId}: a protecting lease was taken for consumed agent(s) [${racedAgentNames.join(", ")}] after the in-transaction re-read; rolling back so the live work's row stays (#1390)`,
      );
    }

    await tx.auditLog.create({
      data: {
        actor: "system",
        action: "stale_agentwork_cleanup",
        repoFullName,
        issueId: issueId,
        success: true,
        notes: `Deleted ${deletedIds.length} stale AgentWork record(s) with no matching active Lease (agentWorkIds=[${deletedIds.join(", ")}])`,
      },
    });
  });

  if (declinedAgentNames.length > 0) {
    console.info(
      `[agent-work] stale cleanup declined ${declinedAgentNames.length} candidate(s) after a lease was taken mid-flight on issue ${issueId} (agents=[${declinedAgentNames.join(", ")}])`,
    );
  }

  return deletedIds.length;
}
