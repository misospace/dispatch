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

export interface StartAgentWorkInput {
  agentName: string;
  issueId?: string | null;
  runId?: string | null;
  branch?: string | null;
}

export interface CheckpointAgentWorkInput {
  agentName: string;
  checkpoint: string;
  summary?: string | null;
  blockerReason?: string | null;
}

export interface FinishAgentWorkInput {
  agentName: string;
  state: string;
  summary?: string | null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseStartAgentWorkInput(body: unknown): StartAgentWorkInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName" };

  return {
    agentName: input.agentName.trim(),
    issueId: typeof input.issueId === "string" ? input.issueId : null,
    runId: typeof input.runId === "string" ? input.runId : null,
    branch: typeof input.branch === "string" ? input.branch : null,
  };
}

export function parseCheckpointAgentWorkInput(body: unknown): CheckpointAgentWorkInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName" };
  if (!nonEmpty(input.checkpoint)) return { error: "Missing required field: checkpoint" };
  if (!normalizeAgentWorkCheckpoint(input.checkpoint)) return { error: "Invalid checkpoint value" };

  return {
    agentName: input.agentName.trim(),
    checkpoint: normalizeAgentWorkCheckpoint(input.checkpoint) as AgentWorkCheckpoint,
    summary: typeof input.summary === "string" ? input.summary : null,
    blockerReason: typeof input.blockerReason === "string" ? input.blockerReason : null,
  };
}

export function parseFinishAgentWorkInput(body: unknown): FinishAgentWorkInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName" };
  if (!nonEmpty(input.state)) return { error: "Missing required field: state" };
  if (!normalizeAgentWorkState(input.state)) return { error: "Invalid state value" };

  return {
    agentName: input.agentName.trim(),
    state: normalizeAgentWorkState(input.state) as AgentWorkState,
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
 * Find and release AgentWork records for the given issue that have no
 * matching active Lease. This covers the crash/oom-kill scenario where an
 * agent leaves a CLAIMED/IN_PROGRESS AgentWork behind with no live lease.
 *
 * Returns the count of released records.
 */
export async function findAndReleaseStaleAgentWorkForIssue(
  prisma: any,
  issueId: string,
): Promise<number> {
  // Active lease IDs for this issue (non-expired)
  const activeLeases = await prisma.lease.findMany({
    where: { issueId, expiredAt: { gt: new Date() } },
    select: { agentName: true },
  });

  const activeAgentNames = new Set(activeLeases.map((l: any) => l.agentName));

  // Find active AgentWork records for this issue whose agent has no active lease
  const staleWorks = await prisma.agentWork.findMany({
    where: {
      issueId,
      state: { in: ["CLAIMED", "IN_PROGRESS"] },
      agentName: { notIn: Array.from(activeAgentNames) },
    },
  });

  if (staleWorks.length === 0) return 0;

  const now = new Date();
  await prisma.$transaction(
    staleWorks.map((w: any) =>
      prisma.agentWork.update({
        where: { id: w.id },
        data: { state: "STALE", leaseExpiresAt: now },
      })
    )
  );

  await prisma.$transaction(
    staleWorks.map((w: any) =>
      prisma.agentWorkHistory.create({
        data: { workId: w.id, action: "released_by_claim_cleanup" },
      })
    )
  );

  return staleWorks.length;
}
