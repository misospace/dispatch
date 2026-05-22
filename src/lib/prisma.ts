import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrFixQueueClient } from "@/lib/pr-fix-queue";
import { AgentWorkClient } from "@/lib/agent-work";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://dispatch:dispatch@localhost:5432/dispatch";

const adapter = new PrismaPg(databaseUrl);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export function asPrFixQueueClient(client: PrismaClient): PrFixQueueClient {
  return {
    prFixQueueItem: client.prFixQueueItem,
    prFixHistory: client.prFixHistory,
    $transaction: (fn) => client.$transaction(fn as any) as any,
  };
}

export function asAgentWorkClient(client: PrismaClient): AgentWorkClient {
  return {
    agentWork: client.agentWork,
    agentWorkHistory: client.agentWorkHistory,
    $transaction: (fn) => client.$transaction(fn as any) as any,
  };
}
