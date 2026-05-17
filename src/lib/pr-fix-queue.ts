/**
 * PR Fix Queue Module
 *
 * Core data access for the PR-fix assignment queue.
 * Used by PR follow-up ingestion and other components to manage
 * queued fix items and their history.
 */

import { PrismaClient } from "@prisma/client";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PrFixLane = "NORMAL" | "NEEDS_HUMAN" | "ESCALATED";
export type PrFixStatus = "QUEUED" | "IN_PROGRESS" | "FIXED" | "BLOCKED" | "STALE" | "CANCELLED";

export interface EnqueuePrFixInput {
  repo: string;
  pr: number;
  lane: PrFixLane;
  reason: string;
  feedback: string;
  evidenceKey?: string;
  issue?: number | null;
  branch?: string | null;
  url?: string | null;
  title?: string | null;
  author?: string | null;
}

/**
 * Minimal client interface for PR fix queue operations.
 * Accepts both the real PrismaClient and a mock for testing.
 */
export interface PrFixQueueClient {
  prFixQueueItem: {
    findUnique: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
  };
  prFixHistory: {
    create: (args: any) => Promise<any>;
  };
}

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Enqueue a PR fix item. If an item for the same repo+pr already exists,
 * it is updated (merged feedback and evidence keys).
 * Returns the item ID.
 */
export async function enqueuePrFixItem(
  client: PrFixQueueClient,
  input: EnqueuePrFixInput,
): Promise<string> {
  const where = { repo_pr: { repo: input.repo, pr: input.pr } };

  // Check if item already exists (dedup by repo+pr)
  const existing = await client.prFixQueueItem.findUnique({ where });

  if (existing) {
    // Update existing item — merge feedback and evidence keys
    const updatedFeedback = [...new Set([...existing.feedback, input.feedback])];
    const updatedEvidenceKeys = [
      ...new Set([
        ...(existing.evidenceKeys ?? []),
        ...(input.evidenceKey ? [input.evidenceKey] : []),
      ]),
    ];

    const updated = await client.prFixQueueItem.update({
      where: { id: existing.id },
      data: {
        lane: input.lane,
        status: input.lane === "NEEDS_HUMAN" ? ("BLOCKED" as any) : undefined,
        reason: input.reason,
        feedback: updatedFeedback,
        evidenceKeys: updatedEvidenceKeys,
        updatedAt: new Date(),
      },
    });

    // Record history
    await client.prFixHistory.create({
      data: {
        itemId: existing.id,
        action: "updated",
        actor: "system",
        details: `Updated lane to ${input.lane}: ${input.reason}`,
      },
    });

    return existing.id;
  }

  // Create new item
  const evidenceKeys = input.evidenceKey ? [input.evidenceKey] : [];

  const item = await client.prFixQueueItem.create({
    data: {
      repo: input.repo,
      pr: input.pr,
      lane: input.lane,
        status: input.lane === "NEEDS_HUMAN" ? ("BLOCKED" as any) : undefined,
      reason: input.reason,
      feedback: [input.feedback],
      evidenceKeys,
      issue: input.issue ?? undefined,
      branch: input.branch ?? undefined,
      url: input.url ?? undefined,
      title: input.title ?? undefined,
      author: input.author ?? undefined,
    },
  });

  // Record history
  await client.prFixHistory.create({
    data: {
      itemId: item.id,
      action: "created",
      actor: "system",
      details: `Queued ${input.lane} lane: ${input.reason}`,
    },
  });

  return item.id;
}

/**
 * Get a PR fix queue item by repo and PR number.
 */
export async function getPrFixQueueItem(
  client: PrFixQueueClient,
  repo: string,
  pr: number,
): Promise<any | null> {
  return client.prFixQueueItem.findUnique({
    where: { repo_pr: { repo, pr } },
  });
}

/**
 * List PR fix queue items filtered by status.
 */
export async function listPrFixQueueItems(
  client: PrFixQueueClient,
  filter?: { status?: PrFixStatus; lane?: PrFixLane },
): Promise<any[]> {
  const where: Record<string, any> = {};
  if (filter?.status) where.status = filter.status;
  if (filter?.lane) where.lane = filter.lane;

  return client.prFixQueueItem.findMany({
    where,
    orderBy: { queuedAt: "asc" },
  });
}

/**
 * Mark a PR fix queue item as fixed.
 */
export async function markPrFixFixed(
  client: PrFixQueueClient,
  itemId: string,
  note?: string,
): Promise<any> {
  const updated = await client.prFixQueueItem.update({
    where: { id: itemId },
    data: { status: "FIXED", updatedAt: new Date() },
  });

  await client.prFixHistory.create({
    data: {
      itemId,
      action: "fixed",
      actor: "system",
      details: note ?? "Marked as fixed",
    },
  });

  return updated;
}

/**
 * Mark a PR fix queue item as blocked.
 */
export async function markPrFixBlocked(
  client: PrFixQueueClient,
  itemId: string,
  note?: string,
): Promise<any> {
  const updated = await client.prFixQueueItem.update({
    where: { id: itemId },
    data: { status: "BLOCKED", updatedAt: new Date() },
  });

  await client.prFixHistory.create({
    data: {
      itemId,
      action: "blocked",
      actor: "system",
      details: note ?? "Marked as blocked",
    },
  });

  return updated;
}

/**
 * Create a Prisma-backed client instance.
 * Lazy-loaded to avoid connecting during test imports.
 */
let _prismaClient: PrismaClient | undefined;

export function createPrismaQueueClient(): PrFixQueueClient {
  if (!_prismaClient) {
    _prismaClient = new PrismaClient();
  }
  return _prismaClient as unknown as PrFixQueueClient;
}
