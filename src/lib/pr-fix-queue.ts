import { normalizePrFixLane, normalizePrFixStatus, normalizePrFixType, PrFixLane, PrFixStatus, PrFixType, PR_FIX_TYPE_PRIORITY } from "@/types";
import { surfacePrFixBlocked } from "./pr-fix-surfacing";

export type PrFixQueueClient = {
  prFixQueueItem: {
    findUnique: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  prFixHistory: {
    create: (args: any) => Promise<any>;
  };
  $transaction: <T>(fn: (tx: PrFixQueueClient) => Promise<T>) => Promise<T>;
};

export interface EnqueuePrFixInput {
  repo: string;
  pr: number;
  lane?: string | null;
  type?: string | null;
  reason: string;
  feedback: string;
  evidenceKey: string;
  issue?: number | null;
  branch?: string | null;
  url?: string | null;
  title?: string | null;
  headSha?: string | null;
  author?: string | null;
}

export interface MarkPrFixInput {
  repo: string;
  pr: number;
  status: string;
  note?: string | null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseEnqueuePrFixInput(body: unknown): EnqueuePrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  if (!nonEmpty(input.reason)) return { error: "Missing required field: reason" };
  if (!nonEmpty(input.feedback)) return { error: "Missing required field: feedback" };
  if (!nonEmpty(input.evidenceKey)) return { error: "Missing required field: evidenceKey" };

  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    lane: typeof input.lane === "string" ? input.lane : undefined,
    type: typeof input.type === "string" ? input.type : undefined,
    reason: input.reason.trim(),
    feedback: input.feedback.trim(),
    evidenceKey: input.evidenceKey.trim(),
    issue: input.issue === undefined || input.issue === null ? null : Number(input.issue),
    branch: typeof input.branch === "string" ? input.branch : null,
    url: typeof input.url === "string" ? input.url : null,
    title: typeof input.title === "string" ? input.title : null,
    headSha: typeof input.headSha === "string" ? input.headSha : null,
    author: typeof input.author === "string" ? input.author : null,
  };
}

export function parseMarkPrFixInput(body: unknown): MarkPrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  if (!nonEmpty(input.status)) return { error: "Missing required field: status" };
  if (!normalizePrFixStatus(input.status)) return { error: "Invalid status" };
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    status: normalizePrFixStatus(input.status) as PrFixStatus,
    note: typeof input.note === "string" ? input.note : null,
  };
}

function uniqueAppend(values: string[], value: string, maxItems: number): string[] {
  const next = values.includes(value) ? values : [...values, value];
  return next.slice(-maxItems);
}

/**
 * Build a Prisma update patch from enqueue input.
 * `issue` maps to Prisma PrFixQueueItem.issue (Int?) which stores the linked GitHub issue number.
 */
function metadataPatch(input: EnqueuePrFixInput): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({
    issue: input.issue ?? undefined,
    branch: input.branch ?? undefined,
    url: input.url ?? undefined,
    title: input.title ?? undefined,
    headSha: input.headSha ?? undefined,
    author: input.author ?? undefined,
  })) {
    if (value !== undefined && value !== null && value !== "") patch[key] = value as string | number;
  }
  return patch;
}

export async function enqueuePrFixItem(client: PrFixQueueClient, input: EnqueuePrFixInput) {
  const lane = normalizePrFixLane(input.lane);
  const type = normalizePrFixType(input.type);
  const nextStatus: PrFixStatus = lane === "NEEDS_HUMAN" ? "BLOCKED" : "QUEUED";

  let previousStatus: PrFixStatus | undefined;
  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    previousStatus = existing?.status;
    if (existing) {
      const updated = await tx.prFixQueueItem.update({
        where: { id: existing.id },
        data: {
          lane,
          type,
          status: nextStatus,
          reason: input.reason,
          feedback: uniqueAppend(existing.feedback ?? [], input.feedback, 12),
          evidenceKeys: uniqueAppend(existing.evidenceKeys ?? [], input.evidenceKey, 40),
          ...metadataPatch(input),
        },
      });
      await tx.prFixHistory.create({
        data: { itemId: updated.id, action: "enqueue", reason: input.reason, evidenceKey: input.evidenceKey },
      });
      return updated;
    }

    const created = await tx.prFixQueueItem.create({
      data: {
        repo: input.repo,
        pr: input.pr,
        lane,
        type,
        status: nextStatus,
        reason: input.reason,
        feedback: [input.feedback],
        evidenceKeys: [input.evidenceKey],
        ...metadataPatch(input),
      },
    });
    await tx.prFixHistory.create({
      data: { itemId: created.id, action: "enqueue", reason: input.reason, evidenceKey: input.evidenceKey },
    });
    return created;
  });

  if (previousStatus !== "BLOCKED" && item.status === "BLOCKED") {
    await surfacePrFixBlocked({ repo: input.repo, pr: input.pr, reason: item.reason, latestNote: null });
  }
  return item;
}

export async function listQueuedPrFixItems(client: PrFixQueueClient, options: { lane?: string | null; includeBlocked?: boolean; prioritizeByType?: boolean } = {}) {
  const lane = options.lane ? normalizePrFixLane(options.lane) : undefined;
  const status = options.includeBlocked ? { in: ["QUEUED", "BLOCKED"] } : "QUEUED";
  
  const items = await client.prFixQueueItem.findMany({
    where: { status, ...(lane ? { lane } : {}) },
  });
  
  // Sort by type priority first, then by queuedAt
  if (options.prioritizeByType !== false) {
    items.sort((a, b) => {
      const aPriority = PR_FIX_TYPE_PRIORITY[normalizePrFixType(a.type)] ?? 3;
      const bPriority = PR_FIX_TYPE_PRIORITY[normalizePrFixType(b.type)] ?? 3;
      if (aPriority !== bPriority) return aPriority - bPriority;
      // Within same type, oldest first
      return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime();
    });
  } else {
    items.sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());
  }
  
  return items;
}

export async function markPrFixItem(client: PrFixQueueClient, input: MarkPrFixInput) {
  const nextStatus = normalizePrFixStatus(input.status) as PrFixStatus | null;
  if (!nextStatus) throw new Error("Invalid status");

  let previousStatus: PrFixStatus | undefined;
  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    if (!existing) return null;
    previousStatus = existing.status;
    const updated = await tx.prFixQueueItem.update({ where: { id: existing.id }, data: { status: nextStatus } });
    await tx.prFixHistory.create({ data: { itemId: updated.id, action: "mark", status: nextStatus, note: input.note ?? undefined } });
    return updated;
  });

  if (item && previousStatus !== "BLOCKED" && item.status === "BLOCKED") {
    await surfacePrFixBlocked({ repo: input.repo, pr: input.pr, reason: item.reason, latestNote: input.note ?? null });
  }
  return item;
}

/**
 * Mark queued pr-fix items as stale when the upstream PR is merged or closed.
 *
 * This is a deterministic cleanup that catches the failure mode where
 * pr-followup/sync enqueues items without checking the upstream PR's state,
 * leaving merged/closed PRs in the worker queue. The data source is whatever
 * caller passes in — the issues/reconcile route already builds a
 * `mergedOrClosedPrsByRepo` map per tracked repo, so we just consume it.
 *
 * Returns counts for logging/audit. No model judgment.
 */
export async function reconcileStalePrFixItems(
  client: PrFixQueueClient,
  mergedOrClosedPrsByRepo: Map<string, Set<number>>,
  prStateByRepo: Map<string, Map<number, "merged" | "closed">>,
): Promise<{ checked: number; markedStale: number; errored: number }> {
  let checked = 0;
  let markedStale = 0;
  let errored = 0;

  for (const [repo, prNumbers] of mergedOrClosedPrsByRepo) {
    if (prNumbers.size === 0) continue;
    const queued = await client.prFixQueueItem.findMany({
      where: {
        repo,
        pr: { in: Array.from(prNumbers) },
        status: "QUEUED",
      },
    });
    checked += queued.length;
    for (const item of queued) {
      try {
        const state = prStateByRepo.get(repo)?.get(item.pr) ?? "merged";
        await client.$transaction(async (tx) => {
          await tx.prFixQueueItem.update({
            where: { id: item.id },
            data: { status: "STALE" },
          });
          await tx.prFixHistory.create({
            data: {
              itemId: item.id,
              action: "mark",
              status: "STALE",
              note: `Upstream PR state=${state} at reconcile time`,
            },
          });
        });
        markedStale++;
      } catch (err) {
        errored++;
      }
    }
  }

  return { checked, markedStale, errored };
}

export function toAgentQueuePrFixItem(item: any) {
  const fixType = normalizePrFixType(item.type);
  return {
    type: "pr-review-fix",
    fixType,
    id: item.id,
    repo: item.repo,
    pr: item.pr,
    issue: item.issue,
    branch: item.branch,
    url: item.url,
    title: item.title,
    lane: item.lane,
    status: item.status,
    reason: item.reason,
    feedback: item.feedback ?? [],
    evidenceKeys: item.evidenceKeys ?? [],
    headSha: item.headSha,
    author: item.author,
    queuedAt: item.queuedAt,
    updatedAt: item.updatedAt,
    rankingReason: `queued PR review-fix item (${fixType})`,
  };
}
