// ─── Durable issue-handoff settlement replay (#1262) ─────────────────────────
//
// A successful `POST /api/issues/capacity-handoff` can lose its HTTP response,
// and the success audit row is best-effort. Without durable proof, a retry
// finds no lease and can only be refused — successful settlement was
// unprovable. This module owns the bounded completion record:
//
//   "release of claim token T on (agent, issue) under settlement key K
//    succeeded at S; replay that exact result until S + retention".
//
// The record is written BEFORE the lease CAS-delete (a crash between the two
// is resumed by the exact-token retry; the upsert is first-write-wins), and a
// replay is consulted only when the lease is gone: it is a report of a
// recorded past fact, never a substitute for live ownership verification, and
// it mutates nothing. Expired proofs are pruned lazily and refused — never
// replayed as synthetic success. Keys are opaque caller data persisted in the
// database; do not embed secrets in them.

/** Bounded retention for settlement proofs; expired proofs are refused. */
export const ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Maximum accepted length for a caller settlement key. */
export const MAX_SETTLEMENT_KEY_LENGTH = 200;

/** Minimal client surface for settlement persistence/reads (test-injectable). */
export interface IssueHandoffSettlementClient {
  issueHandoffSettlement: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
}

/**
 * Validate + normalize a settlement key from a request. Returns the trimmed
 * value, or null when absent/malformed. Routes validate before use; libs
 * trust the result.
 */
export function normalizeSettlementKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SETTLEMENT_KEY_LENGTH) return null;
  return trimmed;
}

/** Bounded retention deadline for a settlement recorded at `settledAt`. */
export function settlementExpiresAt(settledAt: Date): Date {
  return new Date(settledAt.getTime() + ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS);
}

export type SettlementLookup =
  | { state: "found"; record: any }
  | { state: "expired" }
  | { state: "absent" };

/**
 * Look up the settlement for an exact (agent, issue, key). An expired proof
 * is pruned (best-effort, single row) and reported as `"expired"` so callers
 * can refuse with a clear expiry note instead of a bare "no claim" message.
 */
export async function lookupIssueHandoffSettlement(
  client: IssueHandoffSettlementClient,
  where: { agentName: string; issueId: string; settlementKey: string },
  now: Date = new Date(),
): Promise<SettlementLookup> {
  let record: any;
  try {
    record = await client.issueHandoffSettlement.findUnique({ where: { agentName_issueId_settlementKey: where } });
  } catch {
    // A read failure must not mask the ownership path — report "absent" and
    // let the caller proceed fail-closed (lease fence / live-label checks).
    return { state: "absent" };
  }
  if (!record) return { state: "absent" };
  if (new Date(record.expiresAt).getTime() > now.getTime()) return { state: "found", record };
  try {
    await client.issueHandoffSettlement.deleteMany({
      where: { agentName_issueId_settlementKey: where, expiresAt: { lte: now } },
    });
  } catch {
    // Prune failure only delays dead-row removal; the proof stays expired.
  }
  return { state: "expired" };
}

export interface IssueHandoffSettlementRecord {
  agentName: string;
  issueId: string;
  /** The exact claim incarnation settled. */
  claimToken: string;
  settlementKey: string;
  capacity: string;
  labels: string[];
  status: string | null;
  statusNote: string | null;
  cooldownUntil: Date | null;
  settledAt: Date;
}

/**
 * Persist the completion record. First write wins: a crash-resumed retry
 * re-recording the same (agent, issue, key) can never rewrite the original
 * proof, so the replayed result is always the one the first caller earned.
 */
export async function recordIssueHandoffSettlement(
  client: IssueHandoffSettlementClient,
  record: IssueHandoffSettlementRecord,
): Promise<any> {
  return client.issueHandoffSettlement.upsert({
    where: { agentName_issueId_settlementKey: {
      agentName: record.agentName,
      issueId: record.issueId,
      settlementKey: record.settlementKey,
    } },
    create: {
      agentName: record.agentName,
      issueId: record.issueId,
      claimToken: record.claimToken,
      settlementKey: record.settlementKey,
      capacity: record.capacity,
      labels: record.labels,
      status: record.status,
      statusNote: record.statusNote,
      cooldownUntil: record.cooldownUntil,
      settledAt: record.settledAt,
      expiresAt: settlementExpiresAt(record.settledAt),
    },
    update: {},
  });
}
