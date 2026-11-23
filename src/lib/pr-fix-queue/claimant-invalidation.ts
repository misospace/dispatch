import { splitClaimantLabels } from "../pr-fix-ownership";
import type { PrFixQueueClient } from "./client";
import { normalizeQueueRepo } from "./shared";

/**
 * #1695: Re-verify agent-label ownership whenever the reconciled Issue label
 * cache changes. Direct ownership-reconciler label writes, report-close.ts,
 * the operator label/unlabel routes, and the single-issue refresh converge
 * through the next full sync. Only agent-label evidence is re-verifiable; all
 * other provenance remains untouched. Invalidation applies to every status,
 * including FIXED: it is a recoverable tombstone, and requeue resolves only
 * while the claimant is NULL, so skipping terminal rows would resurrect stale
 * evidence. The invalidation note in PrFixHistory names the invalidated
 * identity (there is no ingestion-time capture note). If an agent label moves,
 * #1615 poison evidence is no longer true; enforce/audit backfill re-resolves
 * while still excluding rebase agents, and off mode leaves recovery to the
 * operator.
 *
 * Sync's mergeLabels preserves lease-backed agent labels, but the webhook
 * applies unlabeled removals directly; a live-lease claimant can therefore be
 * invalidated by the webhook. The churn is bounded and self-heals: the
 * issuance backfill re-reads the live Lease directly and re-resolves from the
 * stronger source; in off mode the row waits for operator recovery.
 */
export async function invalidateStaleAgentLabelClaimants(
  client: PrFixQueueClient,
  input: { repo: string; issue: number; labelsAfter: readonly string[] },
): Promise<{ invalidated: number }> {
  const repo = normalizeQueueRepo(input.repo);
  const supportedNames = splitClaimantLabels(input.labelsAfter).agentLabelNames;
  const supported = new Set(supportedNames.map((name) => name.trim().toLowerCase()));
  const rows = await client.prFixQueueItem.findMany({
    where: { repo, issue: input.issue, claimantSource: "agent-label", claimant: { not: null } },
    select: { id: true, claimant: true },
  });
  let invalidated = 0;
  const identities: string[] = [];
  for (const row of rows) {
    if (typeof row.claimant !== "string" || supported.has(row.claimant.trim().toLowerCase())) continue;
    const claimant = row.claimant;
    await client.$transaction(async (tx) => {
      const result = await tx.prFixQueueItem.updateMany({
        where: { id: row.id, claimant, claimantSource: "agent-label" },
        data: { claimant: null, claimantSource: null },
      });
      if (result.count !== 1) return;
      await tx.prFixHistory.create({
        data: {
          itemId: row.id,
          action: "mark",
          note: `#1695 claimant invalidated: agent/${claimant} is no longer on the issue's reconciled labels; ownership returns to unresolved pending re-resolution.`,
        },
      });
      invalidated++;
      identities.push(claimant);
    });
  }
  if (invalidated > 0) {
    console.info(`[pr-fix-queue] invalidated stale agent-label claimants for ${repo}#${input.issue}: ${identities.join(", ")} (#1695)`);
  }
  return { invalidated };
}
