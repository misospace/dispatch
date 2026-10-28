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
 * recorded open blockers change); the store query excludes them and this pass
 * never marks them, so an anchored row is not re-groomed on a window while
 * nothing about its dependencies changed. The pass never auto-promotes an
 * issue to ready and never closes one: the stale mark is the reconsideration,
 * because stale results bypass the selector's blocked parking and get
 * re-groomed, where a fresh verdict re-decides.
 *
 * An anchorless row is reconsidered even when a candidate dependency is
 * still open. The pass cannot tell which dependency the verdict relied on —
 * an open candidate is not proof that the park still holds, so treating it as
 * such would strand the row forever. The re-groom re-reads the dependency
 * state and re-decides; it never unblocks the issue on its own.
 *
 * Fairness: the scan is capped per repository, so a row the pass cannot make
 * progress on (one it skips in memory, or one whose mark lost the race) must
 * not keep that cap to itself. Every row the scan reaches is stamped with the
 * time it was last considered and the scan orders least-recently-considered
 * first, so the cap rotates through the parked set instead of parking on its
 * oldest rows.
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

/**
 * How many parked blocked issues one pass scans per repository. The scan is
 * capped so one repository cannot monopolize a pass, and the cap rotates:
 * every row the scan reaches is stamped as considered, so the next pass reads
 * the least-recently-considered rows first.
 */
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
  /** When the pass last reached this row during a scan. Audit only. */
  blockedReconciliationAt: Date | null;
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
  /**
   * Record that the scan reached these rows, whether or not the pass could
   * act on them. Audit only: it orders the next scan's slice and is never a
   * freshness, admission or block predicate.
   */
  recordConsidered(rows: ParkedBlockedIssueRow[], at: Date): Promise<void>;
  recordAudit(repoFullName: string, row: ParkedBlockedIssueRow, mark: StaleMarkLike): Promise<void>;
}

export type ParkedBlockDecision =
  | { action: "mark"; reasons: GroomingStaleReason[]; detail: string }
  | { action: "defer"; reason: string }
  | { action: "none" };

/**
 * Whether the row carries a typed dependency anchor: the persisted
 * `groomedDependencyKeys` its verdict (or its body) recorded. Anchored rows
 * are the freshness pass's territory — it compares their recorded open blockers
 * against the current open set and marks them `dependency_changed` when they
 * change — so this pass never re-grooms them on a window.
 */
export function hasTypedDependencyAnchor(row: Pick<ParkedBlockedIssueRow, "groomedDependencyKeys">): boolean {
  return row.groomedDependencyKeys.length > 0;
}

/**
 * The store clause that keeps anchored rows out of this pass. The anchor —
 * not the recorded open-blocker set — decides ownership: a dependency that was
 * unknown or already closed at verdict time leaves the open-blocker set empty
 * while the anchor stands, and re-grooming such a row every window would be
 * model churn with nothing changed.
 */
export const NO_TYPED_DEPENDENCY_ANCHOR = { groomedDependencyKeys: { isEmpty: true } };

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
 * directly. Rows with a typed dependency anchor are the freshness pass's
 * territory (it compares their recorded open blockers against the current open
 * set), so they are never marked here; the store query excludes them as well.
 *
 * An anchorless row is reconsidered on the window whether or not a candidate
 * dependency is open: with no recorded anchor the pass cannot know which
 * dependency the verdict relied on, so an open one does not prove the park
 * still holds. The reconsideration is a re-groom, not an unblock — the fresh
 * verdict decides whether the issue stays blocked.
 */
export function evaluateParkedBlock(
  row: ParkedBlockedIssueRow,
  repoFullName: string,
  openKeys: Set<string>,
  now: Date,
  windowHours: number = BLOCKED_RECONSIDER_WINDOW_HOURS,
): ParkedBlockDecision {
  // An anchored row carries recorded dependency evidence: the freshness pass
  // owns it and re-grooming it on a window would spend a model call every
  // window while nothing about its dependencies changed.
  if (hasTypedDependencyAnchor(row)) return { action: "none" };

  const candidates = parkedBlockCandidateKeys(row, repoFullName);
  const openNow = candidates.filter((key) => openKeys.has(key)).sort();

  // No typed anchor was recorded at verdict time, so the load-bearing
  // prerequisite may live in the model's assessment rather than the body, and
  // the block may not be dependency-based at all. A candidate that is still
  // open is therefore not evidence that the park holds — the pass cannot tell
  // whether the verdict relied on it — so the bounded reconsideration runs
  // anyway: window-bounded, so an explicit hold keeps costing at most one
  // re-groom per window, and a fresh verdict re-decides instead of this pass
  // deciding on the model's behalf.
  if (row.groomedAt === null || row.groomedAt.getTime() < now.getTime() - windowHours * 3_600_000) {
    const considered =
      candidates.length > 0
        ? `considered: ${candidates.join(", ")}`
        : "no dependency candidates could be derived from the body, native blocked-by list or saved baseline";
    // The observed open set rides along in the audit detail: it says why a row
    // was reconsidered even though a prerequisite is still open.
    const open = openNow.length > 0 ? `open now: ${openNow.join(", ")}` : "no candidate dependency is open";
    return {
      action: "mark",
      reasons: ["evidence_incomplete"],
      detail: `dependency evidence incomplete (${considered}; ${open}); reconsideration is bounded to a ${windowHours}h window`,
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
    // Rows the pass actually reached. Every reached row is stamped afterwards,
    // so a row the pass cannot progress on rotates out of the next pass's
    // capped slice instead of holding it forever. Rows an error cut off
    // before they were reached stay unstamped and lead the next pass.
    const reached: ParkedBlockedIssueRow[] = [];
    try {
      const scanned = await store.findParkedBlockedIssues(repo.id, budget.maxIssuesPerRepo);
      const isReconsiderable = (row: ParkedBlockedIssueRow) =>
        row.state === "open" && isFreshnessTrackedStatus(row.labels) && !isRenovateIssue({ title: row.title, labels: row.labels });
      const rows = scanned.filter(isReconsiderable);
      // A row the scan reached but the pass skips in memory was still
      // considered: it must not pin the head of the order forever.
      reached.push(...scanned.filter((row) => !isReconsiderable(row)));
      result.issuesConsidered += rows.length;
      if (rows.length === 0) continue;

      // One openness lookup per repo pass: candidate keys are computed per
      // row first and every referenced number is collected across rows (rows
      // with zero candidates contribute none). The open set rides into the
      // audit detail — it records which prerequisites were still open when
      // the row was reconsidered, not whether the row may be reconsidered.
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
        reached.push(row);
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
    } finally {
      await stampConsidered(store, reached, now(), repo.fullName, result.warnings);
    }
  }
  return result;
}

/**
 * Stamp the rows the scan reached so the next pass's capped slice rotates
 * past them. Every reached row is stamped — including the rows the pass
 * skipped in memory (worker-owned statuses, renovate issues) — because a row
 * that cannot progress must not pin the head of the order forever and starve
 * a later parked issue out of reconsideration. Rows the scan never reached
 * (cut off by the cap) stay unstamped and lead the next pass.
 *
 * Best effort: a failed stamp is a warning, never a pass failure.
 */
async function stampConsidered(
  store: BlockedReconciliationStore,
  rows: ParkedBlockedIssueRow[],
  at: Date,
  repoFullName: string,
  warnings: string[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await store.recordConsidered(rows, at);
  } catch (err) {
    warnings.push(
      `blocked-reconciliation: ${repoFullName}: consideration stamp failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Prisma wiring
// ---------------------------------------------------------------------------

export function makePrismaBlockedReconciliationStore(client: typeof prisma = prisma): BlockedReconciliationStore {
  return {
    // Oldest groom first (never-groomed legacy rows first) within the
    // rotation. Already-stale rows are excluded: the selector re-grooms
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
            // Rows with a typed dependency anchor are the freshness pass's
            // territory (it compares their recorded open blockers against the
            // current open set and marks them `dependency_changed` when they
            // change). This pass only owns anchorless rows.
            NO_TYPED_DEPENDENCY_ANCHOR,
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
          blockedReconciliationAt: true,
        },
        // Least-recently-considered first: a row the scan reached last pass —
        // whether or not the pass could act on it — moves to the back of the
        // order, so the capped slice rotates through the parked set instead of
        // parking on the rows it could not progress on. Never-considered rows
        // lead (NULLS FIRST) and keep the never-groomed-first order among
        // themselves, so legacy parks are reconsidered first.
        orderBy: [
          { blockedReconciliationAt: { sort: "asc", nulls: "first" } },
          { groomedAt: { sort: "asc", nulls: "first" } },
          { number: "asc" },
        ],
        take,
      });
    },
    findOpenIssueKeys(numbers) {
      return findOpenIssueKeys(numbers, client);
    },
    // One bulk write per repo pass, scoped to rows that are still groomer-owned
    // parked blocks: a row that left the parked state meanwhile is not stamped
    // and leads the next pass. Writing through the Prisma client also advances
    // `updatedAt` (@updatedAt) on those rows; that bump is inherent to the
    // client and harmless here — the rotation read depends on
    // `blockedReconciliationAt` alone, and `updatedAt` stays informational
    // (never a freshness or ordering predicate).
    async recordConsidered(rows, at) {
      await client.issue.updateMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          blockedReason: { not: null },
          nextGroomingAction: "mark_blocked",
        },
        data: { blockedReconciliationAt: at },
      });
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
