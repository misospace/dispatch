import { normalizeAgentWorkState, normalizeAgentWorkCheckpoint, AgentWorkState, AgentWorkCheckpoint } from "@/types";
import { nonEmpty } from "./pr-fix-queue";
import { findCurrentClaimWork } from "./worker-ownership";

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
  const leaseDuration = 5 * 60 * 1000; // 5 minutes
  const leaseExpiresAt = new Date(now.getTime() + leaseDuration);

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
  const leaseDuration = 5 * 60 * 1000;

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
    const leaseExpiresAt = new Date(now.getTime() + leaseDuration);

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
 * #1350: a row still owed a claim release (`staleClaimReleasePending`) belongs
 * to the stale-work sweep's retry arm (`activeStateFamilies` in
 * `stale-work.ts` is the canon), so neither this scan nor its delete ever
 * consumes one — no path can drop the release the previous sweep decided on.
 * Live writers never leave the marker on an active-shaped row (the sweep
 * pairs it with the STALE mark), so the boundary is defence in depth on top
 * of the state filter.
 *
 * Returns the count of deleted records.
 */
export async function findAndReleaseStaleAgentWorkForIssue(
  prisma: any,
  issueId: string,
  repoFullName: string,
): Promise<number> {
  // Active lease agent names for this issue: non-expired, or a running park.
  const now = new Date();
  const activeLeases = await prisma.lease.findMany({
    where: {
      issueId,
      OR: [{ expiredAt: { gt: now } }, { retryAfter: { gt: now } }],
    },
    select: { agentName: true },
  });

  const activeAgentNames = Array.from(new Set(activeLeases.map((l: any) => l.agentName)));

  // Find active AgentWork records for this issue whose agent has no active lease.
  //
  // #1350: the pending-release boundary is shared with the stale-work sweep
  // (`activeStateFamilies` in `stale-work.ts`) — a row still owed a claim
  // release belongs to the sweep's retry arm, never to this cleanup. The state
  // filter already keeps a marked STALE row out; this conjunct additionally
  // refuses an active-shaped row that still owes its release, so a claim
  // attempt cannot hard-delete the release a previous sweep decided on.
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
  // the executing state family and the pending-release boundary, mirroring the
  // sweep's own CAS practice. A row that changed shape between the scan and
  // the delete — a writer outside the per-issue mutation guard, e.g. the
  // self-heal agent-work routes — is left for whoever now owns that shape, and
  // the audit (and the returned count) report exactly the rows the fence
  // actually consumed. The claim route runs this cleanup inside that guard, so
  // a fenced miss does not happen there; preserving the row is the safe
  // direction in every case.
  const deletedIds: string[] = [];
  await prisma.$transaction(async (tx: any) => {
    for (const work of staleWorks) {
      const deleted = await tx.agentWork.deleteMany({
        where: {
          id: work.id,
          state: { in: ["CLAIMED", "IN_PROGRESS"] },
          staleClaimReleasePending: false,
        },
      });
      if ((deleted?.count ?? 0) === 1) {
        deletedIds.push(work.id);
      }
    }

    if (deletedIds.length === 0) return;

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

  return deletedIds.length;
}
