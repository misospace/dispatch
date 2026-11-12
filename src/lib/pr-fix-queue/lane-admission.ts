import { Prisma } from "@prisma/client";
import { normalizePrFixType } from "@/types";
import { laneMatchesConfigured } from "../lane-config";
import { type ClaimantResolutionOptions } from "../pr-fix-ownership";
import { type PrFixQueueClient } from "./client";
import { enforcePrFixHandoutLaneExclusivity, getExplicitEscalationLane, handoutExclusivityFromParentClass, type LinkedIssueEscalationClassification } from "./escalation-lane";

/**
 * #1327 review: advisory transaction-lock key serializing REBASE lane
 * admission. One global key — the lane is concurrency 1 across ALL rows and
 * ALL agents, so every REBASE hand-out contends on exactly this lock.
 */
export const REBASE_LANE_ADVISORY_LOCK_KEY = 13270001327n;

/**
 * #1327: the rebase lane's worker pool is LOCAL-only by contract — git is its
 * tool surface and it must not consume paid cloud capacity. Dispatch has no
 * model/runner knowledge of agents, so the pool is operator-declared via
 * `DISPATCH_REBASE_AGENTS`: only the listed agent names (comma or whitespace
 * separated, case-insensitive) receive REBASE hand-outs; any other agent's
 * poll defers the REBASE candidate for an eligible poller (the item stays
 * QUEUED, the poll keeps serving other work).
 *
 * FAIL CLOSED: an unset, empty, or whitespace-only value admits NOBODY. #1327
 * exists to keep rebases on free local capacity, so a missing allowlist must
 * not hand the lane to every polling agent — the lane stays QUEUED until the
 * operator names workers. A bare `*` value is the explicit unrestricted
 * opt-in (debugging/backcompat): every polling agent is eligible. A `*`
 * mixed into a list is just an agent name that matches nothing — the opt-in
 * must be the entire value to count.
 */
export function parseRebaseAgentPool(raw: string | undefined): Set<string> | null {
  if (raw?.trim() === "*") return null;
  const names = (raw ?? "")
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return new Set(names);
}

/** Whether `agentName` may receive a REBASE lane hand-out (see `parseRebaseAgentPool`). */
export function isRebaseLaneAgent(agentName: string): boolean {
  const pool = parseRebaseAgentPool(process.env.DISPATCH_REBASE_AGENTS);
  return pool === null || pool.has(agentName.trim().toLowerCase());
}

/**
 * #1615: the operator-declared rebase-executor pool as a plain lowercase
 * name set, for CLAIMANT classification (distinct from lane eligibility).
 * A rebase executor is a mechanical-rebase worker by contract (#1327), so
 * it is not a fix-work owner: resolution and the hand-out gate use this set
 * to keep a rebase-executor identity off non-REBASE items.
 *
 * The bare `*` wildcard is a lane-ELIGIBILITY opt-in (every agent may poll
 * the rebase lane); it does not declare that every agent name is a rebase
 * executor, so it yields an empty set here — no name is excluded from
 * claimant resolution on a wildcard.
 */
export function rebaseExecutorAgentNames(
  raw: string | undefined = process.env.DISPATCH_REBASE_AGENTS,
): ReadonlySet<string> {
  return parseRebaseAgentPool(raw) ?? new Set();
}

/**
 * #1615: the claimant-resolution exclusion for a candidate with the given
 * dispatched lane: on a known non-REBASE item the rebase-executor pool is
 * not claimant evidence from ANY source, so its names are excluded and
 * resolution falls through to the next source (or "missing", which operator
 * stamping can recover). An absent/empty lane value returns undefined —
 * fail-open for a legacy row shape; the hand-out gate re-decides at
 * issuance.
 */
export function rebaseExecutorClaimantExclusion(
  fixType: string | null | undefined,
): ClaimantResolutionOptions | undefined {
  if (typeof fixType !== "string" || fixType.trim() === "" || normalizePrFixType(fixType) === "REBASE") {
    return undefined;
  }
  // An empty pool (unset env, or the bare `*` wildcard) excludes nothing —
  // a no-op exclusion must not read as an exclusion at all.
  const names = rebaseExecutorAgentNames();
  if (names.size === 0) return undefined;
  return { excludeClaimantNames: names };
}

/**
 * Run a REBASE hand-out admission (gate read + dispatch stamp + hand-out
 * push) SERIALIZED at the database boundary (#1327 review).
 *
 * The concurrency-1 gate is only sound if the liveness read and the
 * hand-out write commit together — a preflight read followed by separate
 * writes lets two concurrent polls both observe an idle lane and both
 * dispatch (the exact fan-out the lane forbids). This helper runs `run`
 * inside one transaction holding `pg_advisory_xact_lock`: a competing
 * admission blocks on the lock and, when it proceeds, the gate read inside
 * its transaction sees the first admission's COMMITTED hand-out and defers.
 * The lock is transaction-scoped, so commit, rollback, or a dead connection
 * all release it — it can never strand the lane the way a leaked row lock
 * would.
 *
 * FAIL CLOSED (#1327 review): the advisory lock is MANDATORY, not best
 * effort. If the lock cannot be taken — no raw SQL surface, a `lock_timeout`
 * on the wait, an aborted transaction — this helper throws and the caller
 * MUST defer the hand-out (the next poll retries it). There is deliberately
 * no unlocked fallback: an admission that ran the gate read and the
 * hand-out write outside the lock is the check-then-write the lane
 * forbids, and the review finding was exactly that fallback re-opening
 * the fan-out window. Deferring costs one poll; fanning out costs two
 * `--force-with-lease` pushes on one branch.
 *
 * `SET LOCAL lock_timeout` bounds the WAIT so even a pathologically long
 * lock holder cannot stall a poll beyond the timeout: the wait ends on the
 * PG side, the transaction aborts, and the caller fails closed.
 */
export async function withRebaseLaneAdmission<T>(
  client: PrFixQueueClient,
  run: (tx: PrFixQueueClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    if (typeof tx.$executeRaw !== "function") {
      // Fail closed: without the raw surface the advisory lock cannot be
      // taken, so the gate read and the hand-out write would run
      // UNSERIALIZED — the fan-out the lane forbids. Refuse the admission
      // instead of admitting an unlocked hand-out.
      throw new Error(
        "rebase lane admission requires a raw SQL surface to take the advisory lock",
      );
    }
    // `SET` accepts no bind parameters, so the interval is a literal.
    // 3s is deliberately BELOW Prisma's interactive-transaction timeout
    // (default 5s): the lock wait must end on the PG side — statement
    // cancelled, transaction aborted, caller fails closed — before Prisma
    // gives up on a connection still blocked inside the lock function,
    // where its rollback cannot land and the abandoned transaction would
    // transiently re-acquire and hold the lock the failing admission just
    // gave up on.
    await tx.$executeRaw(Prisma.raw("SET LOCAL lock_timeout = '3s'"));
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${REBASE_LANE_ADVISORY_LOCK_KEY})`);
    return run(tx);
  });
}

/**
 * Run a NON-rebase PR-fix hand-out issuance SERIALIZED against parent
 * reclassification with a LOCKING READ (#1503 review, the TOCTOU fix).
 *
 * The hand-out gate's defense-in-depth was check-then-write: it read
 * `Issue.currentLane`, then `confirmPrFixHandOut`/the append conditionals only
 * on the PR-fix row — so a parent NORMAL→frontier flip between the lookup and
 * the append let a declared-normal consumer take escalation work. This fence
 * makes the authority decision part of the issuance transaction itself: ONE
 * interactive transaction (DEFAULT isolation — see below) re-runs the SAME
 * `enforcePrFixHandoutLaneExclusivity` gate and, whenever the candidate has a
 * linked issue and an escalation lane is configured, takes a `SELECT ... FOR
 * SHARE` lock on the Issue row (`issue.findFirstLocked`) and re-derives the
 * verdict from the LOCKED read before running `issueHandout` (dispatch stamp +
 * hand-out append) on the same tx.
 *
 * WHY A ROW LOCK, NOT SERIALIZABLE ISOLATION: the fence only READS the Issue
 * row and WRITES the PrFixQueueItem row — a single read/write-antidependency
 * edge is a valid serialization order (fence→flip), so SSI does NOT abort the
 * issuance when a flip commits inside the read→write window (proven
 * empirically on PostgreSQL 18; a Serializable fence still leaked). `FOR
 * SHARE` is the actual boundary, held until the transaction commits:
 * - the flip COMMITS BEFORE the locked read → the fence sees `frontier`,
 *   refuses, and (queued row still unclaimed) applies the correction CAS;
 * - the flip is CONCURRENT with the open fence → the UPDATE BLOCKS on the
 *   share lock until the fence commits → the hand-out landed while the parent
 *   was genuinely NORMAL (valid at its commit); the next poll's gate observes
 *   the flip and refuses + corrects the queued row.
 * There is deliberately NO unlocked fallback — an issuance whose authority
 * read ran outside the fence is the check-then-write the review rejected —
 * mirroring `withRebaseLaneAdmission`.
 *
 * FAIL CLOSED: ANY error — a lock/statement timeout, an aborted transaction,
 * a client without the transaction surface, anything — logs and returns null
 * (defer; the next poll retries). So does a candidate WITH a linked issue
 * whose tx lacks `issue.findFirstLocked`: an unserializable authority read
 * must not authorize issuance. A deferred hand-out costs one poll; a NORMAL
 * issuance on frontier work re-creates the exact leak #1503 exists to close.
 *
 * Scope notes:
 * - REBASE candidates never enter this fence: the route's REBASE branch is the
 *   declared #1327 exception with its own advisory-lock boundary.
 * - `flushIssuance` (the #1491 durable ledger row) stays OUTSIDE the
 *   transaction at the call site — a ledger INSERT inside a possibly-aborted
 *   transaction would poison it (#1491).
 * - Residual same-generation multi-hand-out semantics are unchanged: they are
 *   settlement-arbitrated and pre-existing (#1503 gate docblock).
 */
export async function withHandoutLaneExclusivityFence<T>(
  client: PrFixQueueClient,
  candidate: {
    id: string;
    repo: string;
    pr: number;
    issue?: number | null;
    generation: number;
    lane?: string | null;
  },
  requestPrFixLane: "NORMAL" | "ESCALATED" | null | undefined,
  issueHandout: (tx: PrFixQueueClient) => Promise<T | null>,
): Promise<T | null> {
  try {
    return await client.$transaction(async (tx) => {
      // The authoritative decision re-made ATOMICALLY with issuance: the same
      // gate, now reading `Issue.currentLane` (and applying the correction
      // CAS, when it fires) inside the transaction the hand-out writes commit
      // in. A refusal defers the candidate — null, no hand-out.
      const exclusivity = await enforcePrFixHandoutLaneExclusivity(tx, candidate, requestPrFixLane);
      if (exclusivity.decision === "refuse") return null;
      // #1503 review: serialize the authority read against parent
      // reclassification with a locking read (SELECT ... FOR SHARE) held until
      // issuance commits — see the docblock for the two orderings this makes
      // impossible to exploit. A plain re-read immediately before the write
      // would NOT suffice (still check-then-write); the lock is the boundary.
      const escalationLane = getExplicitEscalationLane();
      if (candidate.issue !== null && candidate.issue !== undefined && escalationLane) {
        if (typeof tx.issue.findFirstLocked !== "function") {
          // Fail closed: an unserializable authority read must not authorize
          // issuance. Defer; the next poll retries.
          console.error(`[next-task-pr-fix] hand-out fence has no locked parent read for ${candidate.repo}#${candidate.pr}; deferring (fail closed, #1503)`);
          return null;
        }
        const lockedRow = await tx.issue.findFirstLocked(candidate.repo, candidate.issue);
        const lockedClass: LinkedIssueEscalationClassification = lockedRow
          ? (laneMatchesConfigured(lockedRow.currentLane ?? null, escalationLane.id) ? "ESCALATED" : "NOT_ESCALATED")
          : "NOT_ESCALATED"; // missing row = definitive read (see the lookup's docblock)
        const lockedVerdict = await handoutExclusivityFromParentClass(tx, candidate, requestPrFixLane, lockedClass);
        if (lockedVerdict.decision === "refuse") return null;
      }
      return issueHandout(tx);
    });
  } catch (error) {
    // Fail closed (see docblock): the locking authority read and the issuance
    // write must commit together or not at all. Defer; the next poll retries.
    console.error(
      `[next-task-pr-fix] hand-out lane-exclusivity fence failed for ${candidate.repo}#${candidate.pr}; deferring the hand-out (fail closed, #1503):`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
