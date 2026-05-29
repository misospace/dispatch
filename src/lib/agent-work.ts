import { normalizeAgentWorkState, normalizeAgentWorkCheckpoint, AgentWorkState, AgentWorkCheckpoint } from "@/types";

export type AgentWorkClient = {
  agentWork: {
    findUnique: (args: any) => Promise<any>;
    findFirst: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
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
 *
 * Response 200: Updated work object with final state set and lease expired
 * Response 400: { error: string } with details about which field failed validation
 * Response 401: { error: "Unauthorized" } when bearer token is missing/invalid
 * Response 404: { error: "No active work found for agent" } when agent has no active work
 *               (also cleans up orphaned leases automatically)
 */
export interface FinishAgentWorkInput {
  agentName: string;
  state: string;
  summary?: string | null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse and validate a request body for POST /api/agent-work/start.
 * Returns the parsed input object or { error: string } with a descriptive message.
 */
export function parseStartAgentWorkInput(body: unknown): StartAgentWorkInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body: expected an object" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName (string)" };
  if (typeof input.agentName === "string" && input.agentName.trim() !== input.agentName) {
    // Trimmed but original had whitespace — still accept it, just trim
  }

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
  if (typeof input.checkpoint === "object") return { error: "Invalid checkpoint value: expected a string, not an object" };
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
  if (typeof input.state === "object") return { error: "Invalid state value: expected a string, not an object" };
  if (typeof input.state !== "string") return { error: `Invalid state value: expected a string, got ${typeof input.state}` };
  if (input.state.trim().length === 0) return { error: "Missing required field: state (one of: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE)" };

  const normalized = normalizeAgentWorkState(input.state);
  if (!normalized) return { error: `Invalid state value: "${input.state}" (expected one of: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE)` };

  return {
    agentName: input.agentName.trim(),
    state: normalized,
    summary: typeof input.summary === "string" ? input.summary : null,
  };
}

export async function startAgentWork(client: AgentWorkClient, input: StartAgentWorkInput) {
  const now = new Date();
  const leaseDuration = 5 * 60 * 1000; // 5 minutes
  const leaseExpiresAt = new Date(now.getTime() + leaseDuration);

  return client.$transaction(async (tx) => {
    // Release any existing active work for this agent on the same issue
    if (input.issueId) {
      const existing = await tx.agentWork.findFirst({
        where: { agentName: input.agentName, issueId: input.issueId, state: { in: ["CLAIMED", "IN_PROGRESS"] } },
      });
      if (existing) {
        await tx.agentWork.update({
          where: { id: existing.id },
          data: { state: "RELEASED", leaseExpiresAt: now },
        });
        await tx.agentWorkHistory.create({
          data: { workId: existing.id, action: "released_by_new_claim" },
        });
      }
    }

    // Release any other active work for this agent (single work per agent)
    const otherActive = await tx.agentWork.findFirst({
      where: { agentName: input.agentName, state: { in: ["CLAIMED", "IN_PROGRESS"] }, ...(input.issueId ? { issueId: { not: input.issueId } } : {}) },
    });
    if (otherActive) {
      await tx.agentWork.update({
        where: { id: otherActive.id },
        data: { state: "RELEASED", leaseExpiresAt: now },
      });
      await tx.agentWorkHistory.create({
        data: { workId: otherActive.id, action: "released_by_new_claim" },
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
    const existing = await tx.agentWork.findFirst({
      where: { agentName: input.agentName, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
    });

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
    const existing = await tx.agentWork.findFirst({
      where: { agentName: input.agentName, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
    });

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

export async function releaseStaleWork(client: AgentWorkClient, maxAgeMs: number) {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return client.$transaction(async (tx) => {
    const stale = await tx.agentWork.findMany({
      where: {
        state: { in: ["CLAIMED", "IN_PROGRESS"] },
        OR: [
          { lastHeartbeatAt: { lt: cutoff } },
          { leaseExpiresAt: { lt: cutoff } },
        ],
      },
    });

    for (const work of stale) {
      await tx.agentWork.update({
        where: { id: work.id },
        data: { state: "STALE", leaseExpiresAt: new Date() },
      });
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
 * History entries are automatically cascaded via onDelete: Cascade.
 * An AuditLog entry is created for traceability.
 *
 * Returns the count of deleted records.
 */
export async function findAndReleaseStaleAgentWorkForIssue(
  prisma: any,
  issueId: string,
  repoFullName: string,
): Promise<number> {
  // Active lease agent names for this issue (non-expired)
  const activeLeases = await prisma.lease.findMany({
    where: { issueId, expiredAt: { gt: new Date() } },
    select: { agentName: true },
  });

  const activeAgentNames = Array.from(new Set(activeLeases.map((l: any) => l.agentName)));

  // Find active AgentWork records for this issue whose agent has no active lease
  const staleWorks = await prisma.agentWork.findMany({
    where: {
      issueId,
      state: { in: ["CLAIMED", "IN_PROGRESS"] },
      agentName: { notIn: activeAgentNames },
    },
    select: { id: true, agentName: true },
  });

  if (staleWorks.length === 0) return 0;

  const staleIds = staleWorks.map((w: any) => w.id);

  // Delete + audit atomically so a deletion is never left without its audit row.
  await prisma.$transaction(async (tx: any) => {
    await tx.agentWork.deleteMany({
      where: { id: { in: staleIds } },
    });

    await tx.auditLog.create({
      data: {
        actor: "system",
        action: "stale_agentwork_cleanup",
        repoFullName,
        issueId: issueId,
        success: true,
        notes: `Deleted ${staleWorks.length} stale AgentWork record(s) with no matching active Lease (agentWorkIds=[${staleIds.join(", ")}])`,
      },
    });
  });

  return staleWorks.length;
}
