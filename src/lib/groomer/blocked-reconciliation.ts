/**
 * Blocked verdict reconsideration (#1459).
 *
 * An issue the groomer parked with an explained block (`blockedReason`,
 * `status/blocked`) can stay parked forever after its named prerequisites
 * close: a legacy park has no freshness baseline so the freshness pass never
 * sees it, and a baselined park whose dependency evidence is incomplete
 * (nothing was saved for the body or the verdict) is skipped by the
 * freshness pass's dependency check. This module is the bounded native
 * reconciliation for those parked explained blocks.
 *
 * It reads only cached database state — no GitHub calls, no model. The only
 * stale reason it emits is `evidence_incomplete`: a parked block with no typed
 * dependency anchor is reconsidered on a bounded window
 * (BLOCKED_RECONSIDER_WINDOW_HOURS). Rows that DO have a typed anchor are the
 * freshness pass's territory (it marks them `dependency_changed` when the
 * recorded open blockers change), and the store query excludes them here. It
 * never auto-promotes an issue to ready and never closes one: the stale
 * mark is the reconsideration, because stale results bypass the selector's
 * blocked parking and get re-groomed, where a fresh verdict re-decides.
 */
import { prisma } from "@/lib/prisma";
import { findOpenIssueKeys } from "@/lib/issue-dependency-annotation";
import { dependencyKey, parseNativeBlockedBy } from "@/lib/issue-dependencies";
import { isRenovateIssue } from "@/lib/issue-filters";
import {
  dependencyKeysForIssue,
  isFreshnessTrackedStatus,
  MAX_BASELINE_DEPENDENCIES,
  parseDependencyKey,
  type GroomingStaleReason,
} from "./freshness";

export const BLOCKED_RECONCILIATION_ACTOR = "grooming-blocked-reconciliation";

/** How many parked blocked issues one pass evaluates per repository. */
export const DEFAULT_BLOCKED_RECONCILIATION_BUDGET: BlockedReconciliationBudget = { maxIssuesPerRepo: 200 };

/**
 * How long an evidence-incomplete parked block waits between
 * reconsiderations. Parked rows with a typed anchor are event-driven via the
 * freshness pass instead: the recorded open blockers changing is the trigger.
 */
export const BLOCKED_RECONSIDER_WINDOW_HOURS = 24;

export interface ParkedBlockedIssueRow {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  nativeBlockedBy: string[];
  groomedAt: Date | null;
  groomedRunId: string | null;
  groomedIssueFingerprint: string | null;
  groomedDependencyKeys: string[];
  groomedOpenBlockerKeys: string[];
}

export interface BlockedReconciliationBudget {
  maxIssuesPerRepo: number;
}

/** The shape the freshness store persists as a stale mark. */
export interface StaleMarkLike {
  reasons: GroomingStaleReason[];
  detail: string;
}

export interface BlockedReconciliationStore {
  findParkedBlockedIssues(repositoryId: string, take: number): Promise<ParkedBlockedIssueRow[]>;
  findOpenIssueKeys(numbers: number[]): Promise<Set<string>>;
  markStale(row: ParkedBlockedIssueRow, mark: StaleMarkLike, at: Date): Promise<boolean>;
  recordAudit(repoFullName: string, row: ParkedBlockedIssueRow, mark: StaleMarkLike): Promise<void>;
}

export type ParkedBlockDecision =
  | { action: "mark"; reasons: GroomingStaleReason[]; detail: string }
  | { action: "defer"; reason: string }
  | { action: "none" };

/**
 * Every dependency candidate a parked explained block could rely on: the
 * saved baseline keys, the body's `depends on #N` refs as of now, and the
 * native blocked-by list. Deduped first, then capped like the baseline —
 * the cap is why the baseline's own keys come first.
 */
export function parkedBlockCandidateKeys(row: ParkedBlockedIssueRow, repoFullName: string): string[] {
  const keys: string[] = [];
  for (const key of [
    ...row.groomedDependencyKeys,
    ...dependencyKeysForIssue(row.body, repoFullName, row.number),
    // `parseNativeBlockedBy` collapses same-repo refs to `repo: null`, so the
    // repo must be re-attached here or the key stays bare `#N` and can never
    // match the fully qualified open set.
    ...parseNativeBlockedBy(row.nativeBlockedBy, repoFullName).map((ref) => dependencyKey(ref.repo ?? repoFullName, ref.number)),
  ]) {
    if (keys.includes(key)) continue;
    keys.push(key);
    if (keys.length >= MAX_BASELINE_DEPENDENCIES) break;
  }
  return keys;
}

/**
 * Decide what this pass does with one parked explained block, against the
 * cached openness of its candidate dependencies. Pure; tests target it
 * directly. Callers must not feed it rows that carry a freshness baseline AND
 * a non-empty open-blocker anchor — those are the freshness pass's territory
 * (it compares dependency identity for them), and the store query excludes
 * them.
 */
export function evaluateParkedBlock(
  row: ParkedBlockedIssueRow,
  repoFullName: string,
  openKeys: Set<string>,
  now: Date,
  windowHours: number = BLOCKED_RECONSIDER_WINDOW_HOURS,
): ParkedBlockDecision {
  const candidates = parkedBlockCandidateKeys(row, repoFullName);
  const openNow = candidates.filter((key) => openKeys.has(key)).sort();

  // A candidate dependency is still open: the park plausibly holds on a
  // named, verifiable prerequisite. A NEW open dependency must never unblock
  // the issue, and with no recorded anchor there is no earlier open set to
  // compare against, so there is nothing to reconsider.
  if (openNow.length > 0) return { action: "none" };

  // No candidate dependency is open — but without a typed anchor recorded at
  // verdict time this is not proof the block is stale: the load-bearing
  // prerequisite may live in the model's assessment rather than the body, or
  // the block may not be dependency-based at all. Window-bounded
  // reconsideration so such a row is revisited on a schedule instead of
  // staying parked forever, while an explicit hold keeps costing at most one
  // re-groom per window.
  if (row.groomedAt === null || row.groomedAt.getTime() < now.getTime() - windowHours * 3_600_000) {
    const considered =
      candidates.length > 0
        ? `considered: ${candidates.join(", ")}`
        : "no dependency candidates could be derived from the body, native blocked-by list or saved baseline";
    return {
      action: "mark",
      reasons: ["evidence_incomplete"],
      detail: `dependency evidence incomplete (${considered}); reconsideration is bounded to a ${windowHours}h window`,
    };
  }
  return { action: "defer", reason: "dependency evidence incomplete; reconsideration window not elapsed" };
}

export interface BlockedReconciliationPassResult {
  issuesConsidered: number;
  markedStale: Array<{ repo: string; issueNumber: number; reasons: GroomingStaleReason[] }>;
  deferred: Array<{ repo: string; issueNumber: number; reason: string }>;
  warnings: string[];
}

/**
 * Evaluate every parked explained block in `repos` against cached dependency
 * state and mark the reconsiderable ones stale. Never throws for a single
 * issue or repo; failures become warnings.
 */
export async function runGroomingBlockedReconciliationPass(
  repos: Array<{ id: string; fullName: string }>,
  store: BlockedReconciliationStore = makePrismaBlockedReconciliationStore(),
  budget: BlockedReconciliationBudget = DEFAULT_BLOCKED_RECONCILIATION_BUDGET,
  now: () => Date = () => new Date(),
  windowHours: number = BLOCKED_RECONSIDER_WINDOW_HOURS,
): Promise<BlockedReconciliationPassResult> {
  const result: BlockedReconciliationPassResult = { issuesConsidered: 0, markedStale: [], deferred: [], warnings: [] };

  for (const repo of repos) {
    try {
      const rows = (await store.findParkedBlockedIssues(repo.id, budget.maxIssuesPerRepo)).filter(
        (row) => row.state === "open" && isFreshnessTrackedStatus(row.labels) && !isRenovateIssue({ title: row.title, labels: row.labels }),
      );
      result.issuesConsidered += rows.length;
      if (rows.length === 0) continue;

      // One openness lookup per repo pass: candidate keys are computed per
      // row first and every referenced number is collected across rows (rows
      // with zero candidates contribute none).
      const candidatesByRow = new Map<string, string[]>();
      const numbers = new Set<number>();
      for (const row of rows) {
        const candidates = parkedBlockCandidateKeys(row, repo.fullName);
        candidatesByRow.set(row.id, candidates);
        for (const key of candidates) {
          const parsed = parseDependencyKey(key);
          if (parsed) numbers.add(parsed.number);
        }
      }

      let openKeys: Set<string>;
      try {
        openKeys = numbers.size > 0 ? await store.findOpenIssueKeys([...numbers]) : new Set<string>();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.warnings.push(`blocked-reconciliation: ${repo.fullName}: openness check failed: ${message}`);
        for (const row of rows) {
          result.deferred.push({ repo: repo.fullName, issueNumber: row.number, reason: "openness check failed" });
        }
        continue;
      }

      for (const row of rows) {
        const decision = evaluateParkedBlock(row, repo.fullName, openKeys, now(), windowHours);
        if (decision.action === "mark") {
          const mark: StaleMarkLike = { reasons: decision.reasons, detail: decision.detail };
          const wrote = await store.markStale(row, mark, now());
          if (wrote) {
            result.markedStale.push({ repo: repo.fullName, issueNumber: row.number, reasons: mark.reasons });
            try {
              await store.recordAudit(repo.fullName, row, mark);
            } catch (err) {
              result.warnings.push(
                `blocked-reconciliation: ${repo.fullName}#${row.number} audit write failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        } else if (decision.action === "defer") {
          result.deferred.push({ repo: repo.fullName, issueNumber: row.number, reason: decision.reason });
        }
      }
    } catch (err) {
      result.warnings.push(`blocked-reconciliation: ${repo.fullName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Prisma wiring
// ---------------------------------------------------------------------------

export function makePrismaBlockedReconciliationStore(client: typeof prisma = prisma): BlockedReconciliationStore {
  return {
    // Oldest groom first (never-groomed legacy rows first), so a capped pass
    // rotates fairly. Already-stale rows are excluded: the selector re-grooms
    // them and the markStale CAS below would only no-op.
    findParkedBlockedIssues(repositoryId, take) {
      return client.issue.findMany({
        where: {
          repositoryId,
          state: "open",
          blockedReason: { not: null },
          // Only parks the groomer itself issued. An operator/worker block
          // written through the status route retires nextGroomingAction
          // (#1453) and is a deliberate human hold this pass must never
          // revisit.
          nextGroomingAction: "mark_blocked",
          admissionOverrideId: null,
          groomingStaleAt: null,
          AND: [
            { OR: [{ groomingRetryAfter: null }, { groomingRetryAfter: { lte: new Date() } }] },
            // Baselined rows with a non-empty open-blocker anchor are the
            // freshness pass's territory (it compares dependency identity for
            // them); this pass only sees rows with no baseline or no typed
            // anchor.
            {
              NOT: {
                AND: [{ groomedIssueFingerprint: { not: null } }, { groomedOpenBlockerKeys: { isEmpty: false } }],
              },
            },
          ],
        },
        select: {
          id: true,
          number: true,
          title: true,
          body: true,
          state: true,
          labels: true,
          nativeBlockedBy: true,
          groomedAt: true,
          groomedRunId: true,
          groomedIssueFingerprint: true,
          groomedDependencyKeys: true,
          groomedOpenBlockerKeys: true,
        },
        orderBy: [{ groomedAt: { sort: "asc", nulls: "first" } }, { number: "asc" }],
        take,
      });
    },
    findOpenIssueKeys(numbers) {
      return findOpenIssueKeys(numbers, client);
    },
    // Race guard: the write lands only while the read still describes the
    // issue — same baseline (groomedRunId, null matching IS NULL), no stale
    // mark yet, still parked, still a groomer-owned park and not operator
    // held. A concurrent groom that wrote a baseline, cleared the blocked
    // reason, or an operator hold written through the status route (which
    // retires nextGroomingAction) turns this into a no-op.
    async markStale(row, mark, at) {
      const updated = await client.issue.updateMany({
        where: {
          id: row.id,
          groomedRunId: row.groomedRunId,
          groomingStaleAt: null,
          blockedReason: { not: null },
          nextGroomingAction: "mark_blocked",
          admissionOverrideId: null,
        },
        data: { groomingStaleAt: at, groomingStaleReasons: mark.reasons, groomingStaleDetail: mark.detail },
      });
      return updated.count > 0;
    },
    async recordAudit(repoFullName, row, mark) {
      await client.auditLog.create({
        data: {
          actor: BLOCKED_RECONCILIATION_ACTOR,
          action: "grooming_stale",
          repoFullName,
          issueNumber: row.number,
          issueId: row.id,
          beforeLabels: row.labels,
          afterLabels: row.labels,
          success: true,
          notes: JSON.stringify({
            reasons: mark.reasons,
            detail: mark.detail,
            groomedRunId: row.groomedRunId,
            via: "blocked-reconciliation",
          }),
        },
      });
    },
  };
}

/**
 * Run the pass after a sync without ever failing it. Returns the summary, or
 * null when the pass itself blew up (logged).
 */
export async function runGroomingBlockedReconciliationPassBestEffort(
  repos: Array<{ id: string; fullName: string }>,
): Promise<BlockedReconciliationPassResult | null> {
  try {
    const result = await runGroomingBlockedReconciliationPass(repos);
    for (const warning of result.warnings) console.warn(`[groomer] ${warning}`);
    return result;
  } catch (err) {
    console.error("[groomer] grooming blocked reconciliation pass failed:", err);
    return null;
  }
}
