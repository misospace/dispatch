import { Prisma } from "@prisma/client";

export type PrFixQueueClient = {
  issue: {
    findFirst: (args: any) => Promise<any>;
    // #1503 review: the hand-out fence's serialization boundary — a locking
    // read (`SELECT ... FOR SHARE OF "Issue"`) on the linked issue row, keyed
    // by (repo, issue number) case-insensitively, returning
    // `{ currentLane }` or null for a missing row. The narrow contract:
    // it MUST be issued on a transaction client (`asPrFixQueueTx` in
    // prisma.ts) so the share lock is held until that transaction commits —
    // a concurrent parent NORMAL→frontier write then either commits before
    // the locked read (the fence refuses) or blocks until after issuance
    // commits (issuance was valid at its commit; the next poll refuses and
    // corrects). OPTIONAL on the type for legacy/test clients; the production
    // transaction wrapper always provides it, and the fence fails CLOSED
    // when it is absent on a candidate with a linked issue.
    findFirstLocked?: (repo: string, issue: number) => Promise<{ currentLane: string | null } | null>;
  };
// #1419: agent-run liveness ledger for the dead-owner recovery probes.
// Optional so legacy/test clients without the model keep the fail-closed
// behavior — an absent surface resolves "live" and never authorizes a
// reclaim; the production client (asPrFixQueueClient) always provides it.
agentRun?: {
findFirst: (args: any) => Promise<any>;
};
  prFixQueueItem: {
    findUnique: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  prFixHistory: {
    create: (args: any) => Promise<any>;
    findMany?: (args: any) => Promise<any[]>;
  };
  // #1256: capacity-scoped cooldown rows. Optional so legacy/test clients
  // without the table still settle other outcomes; capacity-exhausted
  // settlement records the cooldown whenever the surface exists.
  capacityHandoff?: {
    create: (args: any) => Promise<any>;
    findMany?: (args: any) => Promise<any[]>;
  };
  // #495: CI park-and-resume lifecycle exactly-once ledger. Optional so
  // legacy/test clients without the table still work: without a surface the
  // lifecycle routes fall back to state-only writes where a repeated
  // same-key commit is a same-value idempotent re-apply (safe by
  // construction; the state itself is the replay witness), never a
  // double-apply.
  prFixCIParkLedger?: {
    findUnique: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
  };
  // #1491: fenced attempt-requeue replay ledger. Optional so legacy/test
  // clients without the table keep working: the attempt-requeue path itself
  // fails CLOSED (retryable 503) when the surface is absent — an
  // unprovable committed key must never degrade to double-apply.
  prFixRequeueSettlement?: {
    findUnique: (args: any) => Promise<any>;
    findFirst?: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  // #1491: durable issuance ledger. The fenced retry fence validates here
  // after the terminal report released the live receipt; absent surface
  // fails the fence closed (never an unfenced requeue).
  attemptIssuance?: {
    create: (args: any) => Promise<any>;
    findUnique: (args: any) => Promise<any>;
  };
  // #1249: durable per-item evidence ledger. Optional so legacy/test clients
  // without the table keep settling: with no surface the enqueue falls back to
  // the bounded `evidenceKeys` cache (identity-only, pre-#1249 semantics) and
  // settlement consults only the cached post-dispatch list.
  prFixEvidence?: {
    findFirst: (args: any) => Promise<any>;
    findMany: (args: any) => Promise<any[]>;
    upsert: (args: any) => Promise<any>;
  };
  // #1569: LIVE-LEASE read for ORIGINAL CLAIMANT resolution (a live Lease on
  // the linked issue is the strongest ownership record). Optional like the
  // other additive delegates: an absent surface resolves the claimant from
  // labels / the PR author only — it never fabricates a lease holder.
  lease?: {
    findFirst: (args: any) => Promise<any>;
  };
  // The parent-classification authority read runs as a MODELED findFirst;
  // `findFirstLocked` (below) is the fence's serialization boundary and is
  // only issued inside a transaction.
  $transaction: <T>(fn: (tx: PrFixQueueClient) => Promise<T>) => Promise<T>;
  // Raw SQL surface used by the #1327 rebase-lane advisory lock. Optional on
  // the type (legacy/test clients may omit it) but MANDATORY for a rebase
  // admission: `withRebaseLaneAdmission` REFUSES to admit without it, because
  // an admission that cannot take the advisory lock would run the gate read
  // and the hand-out write unlocked — the check-then-write fan-out the lane
  // forbids. Every real Prisma transaction client has it.
  $executeRaw?: (query: Prisma.Sql, ...values: unknown[]) => Promise<number>;
};
