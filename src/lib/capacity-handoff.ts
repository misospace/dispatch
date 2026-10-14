// ─── Capacity-scoped handoff cooldowns (#1256) ───────────────────────────────
//
// When a worker explicitly recognizes that its execution capacity cannot run a
// handed attempt, it settles the attempt with a fenced capacity handoff. The
// work item itself stays dispatchable to other compatible workers; this module
// only persists the bounded, capacity-SCOPED suppression:
//
//   "capacity C should not be re-handed <this issue / this PR> until T".
//
// A handoff is NOT a global wait: it never parks the item for every worker,
// never consumes task-repair budget (fixAttempts / generation are untouched),
// and never changes branch/PR identity. Workers whose declared capacity is
// unrelated keep receiving the work immediately.
//
// The capacity identifier is an opaque, worker-chosen string (for example a
// provider/model or runner-pool name). Dispatch is the authoritative owner of
// the handoff record; it does not interpret the capacity value and carries no
// coupling to any particular executor or source product.
//
// Consistency boundary: handoff rows are Dispatch-local dispatch state (like
// the lease and the queue cache), NOT mirrored to GitHub. GitHub remains the
// source of truth for labels/status; cooldown rows only shape WHO a Dispatch
// poll hands work to, and expire on their own.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type CapacityHandoffKind = "issue" | "pr_fix";

/** Maximum accepted length for a capacity identifier. */
export const MAX_CAPACITY_LENGTH = 200;

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const MIN_COOLDOWN_MS = 60 * 1000; // 1 minute
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Bounded cooldown applied to a capacity handoff. `DISPATCH_CAPACITY_COOLDOWN_MS`
 * overrides the default; the result is always clamped into [1m, 6h] so a
 * misconfigured value can never park work indefinitely or churn instantly.
 */
export function capacityCooldownMs(now = Date.now()): number {
  const raw = process.env.DISPATCH_CAPACITY_COOLDOWN_MS;
  const parsed = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COOLDOWN_MS;
  return Math.min(Math.max(value, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
}

/**
 * Validate + normalize a capacity identifier from a request. Returns the
 * trimmed value, or null when absent/malformed. Routes validate before use;
 * libs trust the result.
 */
export function normalizeCapacity(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CAPACITY_LENGTH) return null;
  return trimmed;
}

/** Fresh opaque token fencing one claim (issued on lease creation, #1256). */
export function newClaimToken(): string {
  return `claim_${randomUUID()}`;
}

/** Minimal client surface for handoff persistence/reads (test-injectable). */
export interface CapacityHandoffClient {
  capacityHandoff: {
    create: (args: any) => Promise<any>;
    findMany: (args: any) => Promise<any[]>;
    deleteMany?: (args: any) => Promise<{ count: number }>;
  };
}

export interface CapacityHandoffRecord {
  kind: CapacityHandoffKind;
  capacity: string;
  repoFullName: string;
  issueNumber?: number | null;
  prNumber?: number | null;
  agentName: string;
  issueId?: string | null;
  /** Attempt generation settled (pr_fix rows). */
  generation?: number | null;
  note?: string | null;
}

/**
 * Capacity matching is case-folded: the identifier is opaque, and a worker
 * that re-declares `Model-A` after handing off `model-a` IS the same
 * capacity. Everything else about the value stays opaque to Dispatch.
 */
export function capacityEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Persist a handoff with its bounded cooldown. Returns the row (including
 * `cooldownUntil`) so callers can echo the deadline to the worker.
 */
export async function recordCapacityHandoff(
  client: CapacityHandoffClient,
  record: CapacityHandoffRecord,
  now: Date = new Date(),
): Promise<{ cooldownUntil: Date }> {
  const cooldownUntil = new Date(now.getTime() + capacityCooldownMs(now.getTime()));
  await client.capacityHandoff.create({
    data: {
      kind: record.kind,
      capacity: record.capacity,
      repoFullName: record.repoFullName,
      issueNumber: record.issueNumber ?? null,
      prNumber: record.prNumber ?? null,
      agentName: record.agentName,
      issueId: record.issueId ?? null,
      generation: record.generation ?? null,
      cooldownUntil,
      note: record.note ?? null,
    },
  });
  return { cooldownUntil };
}

// Lazy-prune throttle: the prune is a write statement and next-task reads run
// on every worker poll, so at most one prune per minute per process. The
// active-row read still filters by cooldownUntil, so a skipped prune only
// delays dead-row removal; it never changes dispatch decisions.
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 60_000;

/** Active (not-yet-expired) handoffs, with throttled lazy pruning. */
export async function loadActiveCapacityHandoffs(
  client: CapacityHandoffClient,
  now: Date = new Date(),
): Promise<any[]> {
  if (client.capacityHandoff.deleteMany && now.getTime() - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = now.getTime();
    // Best-effort — a prune failure never blocks dispatch reads.
    try {
      await client.capacityHandoff.deleteMany({ where: { cooldownUntil: { lte: now } } });
    } catch {
      // ignore
    }
  }
  return client.capacityHandoff.findMany({ where: { cooldownUntil: { gt: now } } });
}

/**
 * Build the skip predicates a dispatcher (next-task) applies to a request that
 * declared `capacity` (undefined = the worker declared no capacity).
 *
 * Rule (fail-closed for undisclosed workers):
 * - a handoff for an item suppresses re-hand when the requester's declared
 *   capacity EQUALS the exhausted capacity;
 * - a requester that declared NO capacity is conservatively suppressed by ANY
 *   active handoff on the item, because Dispatch cannot prove it is not the
 *   exhausted capacity;
 * - an unrelated declared capacity is never suppressed — this is the whole
 *   point of scoping the cooldown to the exhausted capacity.
 *
 * Repo comparison is case-folded, matching queue repo normalization.
 */
export function buildCapacitySkip(
  handoffs: ReadonlyArray<{
    kind: string;
    capacity: string;
    repoFullName: string;
    issueNumber?: number | null;
    prNumber?: number | null;
  }>,
  requestedCapacity: string | undefined,
): { skipIssue: (repo: string | null | undefined, issueNumber: number) => boolean; skipPr: (repo: string, prNumber: number) => boolean } {
  const fold = (repo: string | null | undefined) => (repo ?? "").toLowerCase();
  const issueKeys = new Set<string>();
  const prKeys = new Set<string>();
  for (const h of handoffs) {
    const relevant = requestedCapacity === undefined || capacityEquals(h.capacity, requestedCapacity);
    if (!relevant) continue;
    if (h.kind === "issue" && h.issueNumber != null) {
      issueKeys.add(`${fold(h.repoFullName)}#${h.issueNumber}`);
    } else if (h.kind === "pr_fix" && h.prNumber != null) {
      prKeys.add(`${fold(h.repoFullName)}#${h.prNumber}`);
    }
  }
  return {
    skipIssue: (repo, issueNumber) => issueKeys.has(`${fold(repo)}#${issueNumber}`),
    skipPr: (repo, prNumber) => prKeys.has(`${fold(repo)}#${prNumber}`),
  };
}
