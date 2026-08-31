import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrFixQueueClient } from "@/lib/pr-fix-queue";
import { AgentWorkClient } from "@/lib/agent-work";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let _client: PrismaClient | undefined;

function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL ?? process.env.DISPATCH_DATABASE_URL;
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

  // Build the pg Pool from the URL so libpq-style `sslmode` query params
  // (require, verify-ca, verify-full, no-verify, disable) are honored.
  // `new PrismaPg(url)` passes the string straight to pg, which ignores
  // sslmode entirely - servers that require SSL reject the connection with
  // `no pg_hba.conf entry ... no encryption` (issue #898).
  const pool = new Pool({ connectionString: url });
  const adapter = new PrismaPg(pool);
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
export function asPrFixQueueClient(client: PrismaClient): PrFixQueueClient {
  return {
    prFixQueueItem: client.prFixQueueItem,
    prFixHistory: client.prFixHistory,
    $transaction: <T>(fn: (tx: PrFixQueueClient) => Promise<T>): Promise<T> =>
      client.$transaction(fn as (tx: Prisma.TransactionClient) => Promise<T>),
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
