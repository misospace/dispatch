import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrFixQueueClient } from "@/lib/pr-fix-queue";
import { AgentWorkClient } from "@/lib/agent-work";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let _client: PrismaClient | undefined;

function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL ?? process.env.DISPATCH_DATABASE_URL;
}

/**
 * Build a `PrismaPg` adapter from the connection URL.
 *
 * `pg-connection-string` (the parser used by `@prisma/adapter-pg` and
 * `pg.Pool`) only recognises libpq's standard `sslmode` values:
 * `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`.
 * The README documents `sslmode=no-verify` (TLS on, certificate not
 * verified) but `no-verify` is not one of those, so it falls through and
 * `pg.Pool` ends up with no `ssl` config — the server then rejects the
 * connection with `no pg_hba.conf entry ... no encryption`. Detect the
 * documented alias, strip it from the URL, and hand PrismaPg an explicit
 * `ssl: { rejectUnauthorized: false }` so node-postgres requires TLS
 * without validating the certificate.
 */
function buildAdapter(url: string): PrismaPg {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new PrismaPg(url);
  }
  if (parsed.searchParams.get("sslmode") !== "no-verify") {
    return new PrismaPg(url);
  }
  parsed.searchParams.delete("sslmode");
  return new PrismaPg({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: false },
  });
}

function initClient(): PrismaClient {
  if (_client) return _client;
  if (globalForPrisma.prisma) {
    _client = globalForPrisma.prisma;
    return _client;
  }

  const url = databaseUrl();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Please set DATABASE_URL or DISPATCH_DATABASE_URL before starting the application.",
    );
  }

  const adapter = buildAdapter(url);
  const client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  // Cache on globalThis in non-production to preserve connection pooling
  // across HMR reloads (Next.js dev server) and to keep the previously
  // created instance visible to vitest workers that re-evaluate this module.
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }
  _client = client;
  return client;
}

/**
 * Lazy Prisma client.
 *
 * Defers `PrismaPg`/`PrismaClient` construction (and the `DATABASE_URL`
 * presence check) until the first property access on the client. This lets
 * route handlers, pages, and other modules `import { prisma } from
 * "@/lib/prisma"` at build time without throwing when `DATABASE_URL` is
 * intentionally absent - for example, during `next build` page-data
 * collection in CI or local dev.
 *
 * The first call to any model delegate or `$transaction`/`$queryRaw`/etc.
 * during a real request will still surface a clear error if the env var is
 * missing. This matches the build-time contract documented in AGENTS.md.
 *
 * The Proxy is typed as `PrismaClient` and forwards every property access
 * to the lazily-constructed underlying client, binding methods so `this`
 * stays correct.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = initClient();
    const value = (client as unknown as Record<PropertyKey, unknown>)[
      prop as PropertyKey
    ];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(client)
      : value;
  },
  has(_target, prop) {
    return prop in (initClient() as unknown as object);
  },
  ownKeys() {
    return Reflect.ownKeys(initClient() as unknown as object);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(
      initClient() as unknown as object,
      prop,
    );
  },
});

/**
 * Internal: reset the cached client. Intended for tests that need to
 * re-evaluate the env between cases. Not part of the stable surface used
 * by route handlers.
 */
export function __resetPrismaClientForTests(): void {
  _client = undefined;
  globalForPrisma.prisma = undefined;
}

// The adapter interfaces type the interactive-transaction callback's `tx` as
// the narrowed client (PrFixQueueClient / AgentWorkClient), whereas Prisma types
// it as Prisma.TransactionClient. The two are structurally compatible for the
// model delegates these callbacks actually use; cast the callback once (rather
// than `as any`) so the transaction's return type T is still checked.

/**
 * Build the narrow queue-client surface a `$transaction` callback runs on
 * (#1503 review): the same delegate list as `asPrFixQueueClient`, taken from
 * the raw transaction client, PLUS the fence's serialization boundary —
 * `issue.findFirstLocked`, a `SELECT ... FOR SHARE` read on the linked Issue
 * row that must be issued through the tx so the share lock is held until the
 * transaction commits.
 *
 * `issue.findFirst` stays the plain modeled read (the pre-gate and the
 * classification helper use it unlocked); every other surface is a straight
 * delegate passthrough, and `$executeRaw` forwards so the #1327 REBASE
 * advisory lock keeps working through a wrapped tx. There is deliberately no
 * `findFirstLocked` on the TOP-LEVEL client: a lock outside a transaction is
 * meaningless, and only the fence holds one.
 */
function asPrFixQueueTx(tx: Prisma.TransactionClient): PrFixQueueClient {
  return {
    issue: {
      findFirst: (args: any) => tx.issue.findFirst(args),
      // #1503 review: the issuance fence's locking read — SELECT ... FOR SHARE
      // OF "Issue", bound parameters via Prisma.sql. LOWER()=LOWER() mirrors
      // the classification lookup's case-insensitive repo match (the queue
      // folds repo casing, Issue.repository.fullName keeps GitHub casing);
      // ILIKE would treat `_` as a wildcard, so it is deliberately avoided.
      // A found row carries its `currentLane`; a missing row is a definitive
      // NOT_ESCALATED read (null); a thrown read aborts the transaction and
      // the fence defers.
      findFirstLocked: async (repo: string, issue: number) => {
        const rows = await tx.$queryRaw<{ currentLane: string | null }[]>(
          Prisma.sql`
            SELECT i."currentLane" AS "currentLane"
            FROM "Issue" i
            JOIN "Repository" r ON r."id" = i."repositoryId"
            WHERE LOWER(r."fullName") = LOWER(${repo}) AND i."number" = ${issue}
            FOR SHARE OF i
          `,
        );
        return rows[0] ?? null;
      },
    },
    prFixQueueItem: tx.prFixQueueItem,
    prFixHistory: tx.prFixHistory,
    // #1419: the dead-owner recovery probes read agent-run liveness off this
    // delegate; without it they fail closed (treat every acked attempt as
    // live) instead of reclaiming blind.
    agentRun: tx.agentRun,
    capacityHandoff: tx.capacityHandoff,
    // #1249: without this delegate every route handler's queue client was
    // ledger-inert — `readEvidenceLedgerView`/`recordEvidenceTransition` no-op
    // and settlement falls back to the bounded #1119 cache.
    prFixEvidence: tx.prFixEvidence,
    // #495: the CI park lifecycle's exactly-once ledger runs off this
    // delegate; without it the lifecycle routes degrade to the state-only
    // writes (same-value idempotent re-applies instead of the ledger).
    prFixCIParkLedger: tx.prFixCIParkLedger,
    // #1491: the fenced attempt-requeue settlement ledger and the durable
    // issuance history; both fail closed when absent (never unfenced, never
    // double-applied).
    prFixRequeueSettlement: tx.prFixRequeueSettlement,
    attemptIssuance: tx.attemptIssuance,
    // #1327: the REBASE advisory lock is issued through the raw surface of
    // whichever client the admission runs on; forward it from the tx.
    $executeRaw: (query: Prisma.Sql, ...values: unknown[]) => tx.$executeRaw(query, ...values),
    $transaction: <T>(fn: (tx: PrFixQueueClient) => Promise<T>): Promise<T> =>
      tx.$transaction(fn as (tx: Prisma.TransactionClient) => Promise<T>),
  };
}

export function asPrFixQueueClient(client: PrismaClient): PrFixQueueClient {
  return {
    issue: client.issue,
    prFixQueueItem: client.prFixQueueItem,
    prFixHistory: client.prFixHistory,
    agentRun: client.agentRun,
    capacityHandoff: client.capacityHandoff,
    prFixEvidence: client.prFixEvidence,
    prFixCIParkLedger: client.prFixCIParkLedger,
    prFixRequeueSettlement: client.prFixRequeueSettlement,
    attemptIssuance: client.attemptIssuance,
    $transaction: <T>(fn: (tx: PrFixQueueClient) => Promise<T>): Promise<T> =>
      client.$transaction((tx) => fn(asPrFixQueueTx(tx))),
  };
}

export function asAgentWorkClient(client: PrismaClient): AgentWorkClient {
  return {
    agentWork: client.agentWork,
    agentWorkHistory: client.agentWorkHistory,
    $transaction: <T>(fn: (tx: AgentWorkClient) => Promise<T>): Promise<T> =>
      client.$transaction(fn as (tx: Prisma.TransactionClient) => Promise<T>),
  };
}
