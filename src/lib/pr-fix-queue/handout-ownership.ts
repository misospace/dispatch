import { ownershipAuthorizesHandout, prFixOwnershipEvidence, claimantIsHumanOwned, type PrFixOwnershipEvidence, resolveIngestionClaimant } from "../pr-fix-ownership";
import { normalizePrFixType } from "@/types";
import { rebaseExecutorAgentNames, rebaseExecutorClaimantExclusion } from "./lane-admission";
import { type PrFixQueueClient } from "./client";
import { normalizeQueueRepo } from "./shared";

// ─── PR-fix ownership enforcement (#1569) ──────────────────────────────────
/**
 * Rollout mode for the #1569 ownership gate at issuance.
 *
 * The AUTHORIZATION is mode-independent: a row whose ownership is unresolved
 * ("missing", "ambiguous", or a legacy row with no recorded claimant) is
 * REFUSED to every automatic hand-out path (next-task, including unfiltered
 * and REBASE dispatches) in EVERY mode. The issue's rule is absolute —
 * missing or ambiguous ownership never authorizes an automatic hand-out — so
 * no rollout mode may hand an unresolved row out. The mode selects the
 * side effects around that refusal, never the refusal itself:
 * - "enforce" (DEFAULT): refuse; the issuance-side lazy backfill runs (a
 *   resolved claimant is written back, so legacy rows self-heal on first
 *   contact); the refusal is logged.
 * - "audit": refuse exactly like "enforce"; the refusal is logged with an
 *   AUDIT marker so an operator can enumerate the rows that still need a
 *   claimant. Migration window for operators — it observes the unresolved
 *   population, it does not dispatch it.
 * - "off": refuse exactly like "enforce"; the issuance-side lazy backfill
 *   does NOT run, so Dispatch performs no issuance-side write on the row.
 *   Recovery is then entirely operator-driven (re-ingestion, operator
 *   requeue, or `POST /api/pr-fix-queue/claimant`). Ingestion-side capture
 *   — the claimant columns and the provenance they record — keeps running,
 *   and a negotiated poll still receives the evidence object.
 *
 * Unresolved rows are NOT silently stranded: outside "off", the gate first
 * attempts a lazy re-resolution from the authoritative records (live Lease,
 * issue agent/owner labels, PR author) and backfills a resolved claimant
 * before deciding — that lazy pass is the bulk recovery path for rows
 * created before this contract. Operator recovery for the rest:
 * `POST /api/pr-fix-queue/claimant` or an operator requeue (which
 * re-resolves). Invalid values run "enforce" (fail closed).
 */
export type PrFixOwnershipMode = "off" | "audit" | "enforce";

export function prFixOwnershipMode(env: NodeJS.ProcessEnv = process.env): PrFixOwnershipMode {
  const raw = (env.DISPATCH_PR_FIX_OWNERSHIP_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "audit") return raw;
  return "enforce";
}

/**
 * #1615: the operator-declared PR-fix worker identity space — the agent
 * names a PR-fix claimant may carry for the row to remain auto-offerable.
 * Comma or whitespace separated, case-insensitive, duplicates collapse.
 *
 * Fail-open by design (deliberately unlike the rebase lane's pool): an
 * unset or empty value leaves the set empty, classification is unavailable,
 * and NO claimant is ever refused for being outside it — the pre-#1615
 * behavior. Declaring the space is the operator's opt-in to the #1615
 * withholds, because an incomplete list would silently strand items whose
 * claimant is a real connector missing from it.
 */
export function prFixWorkerAgentIdentitySet(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const raw = env.DISPATCH_PR_FIX_AGENTS ?? "";
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The row fields the ownership gate reads (subset of a queue row). */
export type PrFixOwnershipRow = {
  id?: string;
  repo: string;
  pr: number;
  generation?: number;
  lane?: string | null;
  issue?: number | null;
  author?: string | null;
  claimant?: string | null;
  claimantSource?: string | null;
  /**
   * #1615: the row's DISPATCHED lane (`attemptType`, falling back to `type`
   * — the same derivation the rebase gate and settlement key on). The
   * rebase-executor claimant arm applies only to a known non-REBASE value;
   * an absent value skips the arm (fail-open for a legacy row shape).
   */
  fixType?: string | null;
};

/**
 * The refusal classes of the ownership gate. `null` on an eligible row;
 * otherwise the arm that refused:
 * - "unresolved" — missing/ambiguous/legacy ownership (#1569);
 * - "human-owned" — a label/author-sourced claimant outside the declared
 *   PR-fix worker identity space (#1615 Part A);
 * - "rebase-executor-claimant" — a rebase-executor claimant on a non-REBASE
 *   item (#1615 Part B): the rebase executor is not a fix-work owner.
 */
export type PrFixOwnershipRefusal = "unresolved" | "human-owned" | "rebase-executor-claimant" | null;

/**
 * The ownership arm of the hand-out gate (#1569). Applies to EVERY
 * dispatchable candidate — NORMAL, ESCALATED, unfiltered, and REBASE alike:
 * the REBASE exemption (#1327) exempts the LANE-classification column, never
 * the ownership evidence. Returns the versioned evidence regardless of
 * decision so the caller can ship it on a granted hand-out and log it on a
 * refusal.
 *
 * Fail closed: unresolved ownership ("missing"/"ambiguous"/"legacy") never
 * authorizes an automatic hand-out, in ANY rollout mode (#1569's rule is
 * absolute). The mode selects the side effects around the refusal — the
 * "audit" log marker and the issuance-side lazy backfill that "off"
 * disables — never the decision itself. The unfiltered operator poll (#1046)
 * is NOT an exemption for ownership: it is still an automatic hand-out, and
 * an operator who means to dispatch an unresolved row stamps it explicitly
 * (recovery endpoint), which is the auditable act.
 *
 * #1615 adds two REFUSAL arms for RESOLVED claimants that no connector can
 * own, both operator-config-derived (Dispatch never invents identity lists):
 * - "human-owned" — a label/PR-author-sourced claimant outside the declared
 *   PR-fix worker identity space (`DISPATCH_PR_FIX_AGENTS`; the arm is inert
 *   while that space is undeclared). The item stays QUEUED as the human's
 *   queue entry instead of being offered, declined, and park-looped.
 * - "rebase-executor-claimant" — a claimant in the rebase-executor pool
 *   (`DISPATCH_REBASE_AGENTS`) on an item whose non-empty dispatched lane
 *   does not normalize to REBASE (any other value, known type or not).
 *   Resolution keeps the pool off new rows (see `ClaimantResolutionOptions`);
 *   this arm stops an already-recorded poison claimant from re-entering the
 *   decline loop.
 * Both arms refuse in EVERY rollout mode, exactly like the unresolved arm.
 */
export function evaluatePrFixHandoutOwnership(
  row: PrFixOwnershipRow,
  mode: PrFixOwnershipMode = prFixOwnershipMode(),
  /**
   * #1615: the declared PR-fix worker identity space. Defaults from
   * `DISPATCH_PR_FIX_AGENTS`; an empty set disables the human-owned arm.
   */
  workerAgents: ReadonlySet<string> = prFixWorkerAgentIdentitySet(),
): { decision: "eligible" | "refuse"; evidence: PrFixOwnershipEvidence; refusal: PrFixOwnershipRefusal } {
  const evidence = prFixOwnershipEvidence(row);
  if (ownershipAuthorizesHandout(evidence)) {
    // #1615 Part A: a RESOLVED claimant can still be un-ownable — a human's
    // board claim (agent/owner label) or PR authorship that names nobody in
    // the declared worker identity space. The row belongs to that human;
    // offering it only burns attempt budget on offers no connector may
    // accept. Refused like an unresolved row: no stamp, no hand-out, no
    // attempt.
    if (claimantIsHumanOwned(evidence, workerAgents)) {
      const logFields = {
        repoFullName: row.repo,
        pullRequestNumber: row.pr,
        generation: row.generation ?? null,
        claimant: evidence.originalClaimant,
        ownershipProvenance: evidence.provenance,
      };
      if (mode === "audit") {
        console.info("[next-task-pr-fix] AUDIT: refusing PR-fix hand-out with HUMAN-OWNED claimant (#1615)", logFields);
      } else {
        console.info("[next-task-pr-fix] refusing PR-fix hand-out with HUMAN-OWNED claimant (#1615)", logFields);
      }
      return { decision: "refuse", evidence, refusal: "human-owned" };
    }
    // #1615 Part B (recorded rows): a rebase-executor claimant on a
    // non-REBASE item is structurally un-routable — every fix connector
    // declines the lane-mismatched identity. Resolution keeps the pool off
    // new rows; this arm stops an already-recorded poison claimant from
    // re-entering the decline loop.
    if (
      typeof row.fixType === "string" &&
      row.fixType.trim() !== "" &&
      normalizePrFixType(row.fixType) !== "REBASE" &&
      rebaseExecutorAgentNames().has((evidence.originalClaimant ?? "").trim().toLowerCase())
    ) {
      const logFields = {
        repoFullName: row.repo,
        pullRequestNumber: row.pr,
        generation: row.generation ?? null,
        claimant: evidence.originalClaimant,
        ownershipProvenance: evidence.provenance,
        dispatchedLane: normalizePrFixType(row.fixType),
      };
      if (mode === "audit") {
        console.info("[next-task-pr-fix] AUDIT: refusing PR-fix hand-out with a REBASE-EXECUTOR claimant on a non-REBASE item (#1615)", logFields);
      } else {
        console.info("[next-task-pr-fix] refusing PR-fix hand-out with a REBASE-EXECUTOR claimant on a non-REBASE item (#1615)", logFields);
      }
      return { decision: "refuse", evidence, refusal: "rebase-executor-claimant" };
    }
    return { decision: "eligible", evidence, refusal: null };
  }
  // #1569: NO mode hands an unresolved row out. "audit" keeps its
  // migration-window observability (a distinguishable log marker), "off"
  // keeps its no-issuance-write posture — both still refuse.
  const logFields = {
    repoFullName: row.repo,
    pullRequestNumber: row.pr,
    generation: row.generation ?? null,
    ownershipProvenance: evidence.provenance,
  };
  if (mode === "audit") {
    console.info("[next-task-pr-fix] AUDIT: refusing PR-fix hand-out with UNRESOLVED ownership (#1569)", logFields);
  } else {
    console.info("[next-task-pr-fix] refusing PR-fix hand-out with UNRESOLVED ownership (#1569)", logFields);
  }
  return { decision: "refuse", evidence, refusal: "unresolved" };
}

/**
 * Lazy claimant resolution at the issuance boundary (#1569): a row whose
 * claimant is unresolved is re-resolved from the authoritative records
 * (live Lease / single agent label / single owner label / PR author). A
 * resolved value is backfilled with a conditional write pinned on
 * `claimant IS NULL` — it can never overwrite a recorded claimant, and a
 * concurrent backfill is idempotent (same conditional shape). An
 * unresolved row records NOTHING here (repeated issuance polls must not
 * churn writes); the failure state is persisted by ingestion.
 * Returns the row's effective claimant pair after the attempt (the input
 * value when one was already recorded, else the freshly resolved one).
 * When the conditional write loses a concurrent race (a sibling backfill or
 * the operator stamp persisted first), the persisted claimant is re-read and
 * echoed — a rejected local resolution is never reported as effective — and
 * a failed re-read resolves to nothing (fail closed).
 */
export async function backfillPrFixClaimant(
  client: PrFixQueueClient,
  row: {
    id: string;
    repo: string;
    issue?: number | null;
    author?: string | null;
    claimant?: string | null;
    claimantSource?: string | null;
    /**
     * #1615: the row's dispatched lane (`attemptType ?? type`). On a known
     * non-REBASE value, the rebase-executor pool is excluded as claimant
     * evidence — a rebase executor is not a fix-work owner, so its name
     * (agent label or a live lease) falls through to the next source
     * instead of propagating an un-routable claimant onto the row.
     */
    fixType?: string | null;
  },
): Promise<{ claimant: string | null; claimantSource: string | null }> {
  if (typeof row.claimant === "string" && row.claimant.trim() !== "") {
    // Already recorded: no facts read, no write. The row's OWN provenance is
    // echoed, so a caller deriving evidence from this return value can never
    // report a recorded lease/operator/agent claimant as "legacy".
    return { claimant: row.claimant, claimantSource: row.claimantSource ?? null };
  }
  // #1615: on a known non-REBASE item the rebase-executor pool is not
  // claimant evidence. An unknown/absent lane value skips the exclusion
  // (fail-open for a legacy row shape — the gate re-decides at issuance).
  const resolution = await resolveIngestionClaimant(
    client,
    row.repo,
    row.issue ?? null,
    row.author,
    new Date(),
    rebaseExecutorClaimantExclusion(row.fixType),
  );
  if (resolution.state !== "resolved") return { claimant: null, claimantSource: null };
  try {
    const { count } = await client.prFixQueueItem.updateMany({
      where: { id: row.id, claimant: null },
      data: { claimant: resolution.claimant, claimantSource: resolution.source },
    });
    if (count === 1) {
      console.info(`[pr-fix-queue] backfilled PR-fix claimant ${resolution.claimant} via ${resolution.source} (${row.repo} ${row.id}) (#1569)`);
      return { claimant: resolution.claimant, claimantSource: resolution.source };
    }
    // Lost the write race: a concurrent writer (operator stamp, sibling
    // backfill) recorded a claimant between this read and the conditional
    // write. The locally resolved identity was REJECTED — it is not persisted,
    // so it must never be returned as the row's effective claimant (the caller
    // would authorize and transport an identity the row does not carry).
    console.info(`[pr-fix-queue] claimant backfill lost the write race for ${row.repo}/${row.id} (#1569); echoing the persisted claimant`);
  } catch (error) {
    // Best-effort: a failed backfill leaves the row unresolved for THIS
    // poll (the gate refuses); the next poll or ingestion retries.
    console.warn(
      `[pr-fix-queue] claimant backfill failed for ${row.repo}/${row.id} (#1569):`,
      error instanceof Error ? error.message : error,
    );
  }
  // Either the write lost the race or failed outright: the only claimant this
  // caller may report is one actually persisted on the row. A failed re-read
  // resolves to nothing — fail closed, the gate refuses an unresolved row.
  try {
    const persisted = await client.prFixQueueItem.findUnique({
      where: { id: row.id },
      select: { claimant: true, claimantSource: true },
    });
    return {
      claimant: persisted?.claimant ?? null,
      claimantSource: persisted?.claimantSource ?? null,
    };
  } catch (error) {
    console.warn(
      `[pr-fix-queue] claimant re-read failed for ${row.repo}/${row.id} (#1569):`,
      error instanceof Error ? error.message : error,
    );
    return { claimant: null, claimantSource: null };
  }
}

/**
 * Operator recovery (#1569): explicitly stamp the ORIGINAL CLAIMANT of a
 * PR-fix row. This is the auditable act that resolves "missing" and
 * "ambiguous" rows; provenance becomes "operator" and no ingestion path may
 * overwrite it. The claimant is a plain identity string (agent name or
 * login) — Dispatch never maps it to lanes or tiers.
 *
 * Preservation rule: an already-recorded claimant is NEVER transferred. The
 * write is a `claimant IS NULL` conditional update, and the successful stamp
 * plus its PrFixHistory note commit in ONE transaction — there is no window
 * where a stamped row exists without its audit row, and a concurrent
 * resolution can never be clobbered. A stamp that finds an existing
 * claimant is refused (`reason: "already_set"`), not silently applied.
 */
export async function setPrFixClaimant(
  client: PrFixQueueClient,
  input: { repo: string; pr: number; claimant: string },
): Promise<{ updated: boolean; reason?: "not_found" | "already_set" }> {
  const repo = normalizeQueueRepo(input.repo);
  const claimant = input.claimant.trim();
  if (claimant === "") return { updated: false, reason: "not_found" };
  return client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({
      where: { repo_pr: { repo, pr: input.pr } },
      select: { id: true },
    });
    if (!existing) return { updated: false, reason: "not_found" } as const;
    const { count } = await tx.prFixQueueItem.updateMany({
      where: { id: existing.id, claimant: null },
      data: { claimant, claimantSource: "operator" },
    });
    if (count !== 1) return { updated: false, reason: "already_set" } as const;
    await tx.prFixHistory.create({
      data: {
        itemId: existing.id,
        action: "mark",
        note: `#1569 operator claimant stamp: (unset) -> ${claimant} (provenance "operator").`,
      },
    });
    return { updated: true } as const;
  });
}
