import { prisma } from "@/lib/prisma";
import { releaseIssueClaim, type IssueClaimClient } from "@/lib/issue-claim";
import { lifecycleDedupeKey } from "@/lib/issue-lifecycle";
import { withIssueMutationGuard } from "@/lib/issue-mutation-guard";

export const DEFAULT_STALE_WORK_MAX_AGE_MS = 5 * 60 * 1000;
export const DEFAULT_STALE_WORK_BATCH_SIZE = 50;

/**
 * Active `AgentWork` states whose staleness is HEARTBEAT-GATED: a row is
 * reclaimable when its `lastHeartbeatAt` OR its `leaseExpiresAt` fell past
 * the cutoff. These are executing rows — silence is the failure the sweep
 * exists to catch.
 */
const HEARTBEAT_GATED_STATES = ["CLAIMED", "IN_PROGRESS"] as const;

type WhereClause = Record<string, unknown>;

/** The stale/silent arm `{ [field]: { lt: cutoff } }`. */
function lt(field: string, cutoff: Date): WhereClause {
  return { [field]: { lt: cutoff } };
}

/**
 * The SQL three-valued complement of `lt(field, cutoff)` over a NULLABLE
 * column: TRUE exactly when the `lt` comparison is NOT TRUE — the column IS
 * NULL, or its value is at/after the cutoff. This is the one place the
 * NULL-polarity rule is spelled; the heartbeat-gated family's live arm is
 * derived from it.
 */
function notLt(field: string, cutoff: Date): WhereClause {
  return { OR: [{ [field]: null }, { [field]: { gte: cutoff } }] };
}

/**
 * The SQL three-valued complement of the "IS NULL OR lt" reclaim shape over a
 * NULLABLE column: TRUE exactly when the column IS NOT NULL AND its value is
 * at/after the cutoff.
 *
 * `notLt` cannot express it: `notLt` is TRUE on a NULL column, while this arm
 * must never be TRUE there — a NULL deadline means NO park, and such a row
 * must not shield a claim. The bare `{ gte }` comparison already excludes
 * NULL rows (SQL's `NULL >= cutoff` is UNKNOWN, never TRUE), so this builder
 * spells the `IS NOT NULL` conjunct out instead of leaning on that side
 * effect: the NULL polarity of the rule lives in the builder, not in a
 * comparison's behaviour. The blocked-park family's live arm is derived from
 * THIS builder; the two builders are the two polarities of the same rule,
 * side by side.
 */
function notNullNotLt(field: string, cutoff: Date): WhereClause {
  return { AND: [{ [field]: { not: null } }, { [field]: { gte: cutoff } }] };
}

/**
 * Is the claim's wait marker still RUNNING?
 *
 * A lease's `retryAfter` parks the claim until that deadline (#1316/#1334).
 * While the deadline is still in the future the park is running: the owner
 * recorded that it defers until then, so the silence of a parked worker is
 * NOT evidence of abandonment. The sweep must not reclaim such a row, delete
 * the lease the park was recorded on, or release the claim — the park
 * deadline decides when the work is reclaimable, not the heartbeat. Once the
 * deadline has passed the marker is spent and the normal reclaim path
 * applies.
 *
 * Both writers of the marker get this: a `blocked` ownership disposition
 * (which parks the settled row as well) and a renewal's `externalWait` (which
 * parks the lease only — the sweep reads the marker off the lease, so the
 * protection is uniform in the wait marker itself).
 */
function parkRunning(lease: { retryAfter?: Date | null } | null | undefined, now: Date): boolean {
  const retryAfter = lease?.retryAfter ?? null;
  return retryAfter !== null && retryAfter.getTime() > now.getTime();
}

/**
 * The (agent, issue) claims that are PARKED — a running wait marker on the
 * lease (`retryAfter` in the future).
 *
 * One query for the whole instance: `retryAfter > now` is exactly "a park
 * that is still running" (a NULL marker is not a park — `retryAfter > now`
 * is UNKNOWN for NULL, never TRUE).
 */
async function findParkedClaims(
  client: StaleWorkClient,
  now: Date,
): Promise<Array<{ agentName: string; issueId: string }>> {
  const leases = await client.lease.findMany({
    where: { retryAfter: { gt: now } },
    select: { agentName: true, issueId: true },
  });
  return leases.map((lease) => ({ agentName: lease.agentName, issueId: lease.issueId }));
}

/**
 * One active-state family's predicates, defined ONCE as a reclaim/live pair so
 * the sweeper's candidate clause and the live-sibling lookup cannot drift:
 * `reclaim` is what the candidate query and the mark CAS match against, and
 * `live` is its SQL three-valued complement over the same state family and
 * the same NON-PENDING boundary (a row is live exactly when the sweep would
 * NOT reclaim it AND it does not owe a claim release), used by
 * `findLiveSiblingWork`. Both queries consume the SAME objects built here,
 * and BOTH arms carry `staleClaimReleasePending: false`: an active-shaped row
 * still owed a release belongs to NEITHER arm — never a reclaim candidate,
 * never a claim-shielding live sibling.
 */
export interface ActiveStateFamilyPredicates {
  /** Family identity, for diagnostics and the complement property test. */
  name: "heartbeat-gated" | "blocked-park";
  reclaim: WhereClause;
  live: WhereClause;
}

/**
 * The two active families and their reclaim/live predicates.
 *
 * - `CLAIMED`/`IN_PROGRESS` (heartbeat-gated): reclaimable on silence (stale
 *   heartbeat) OR an elapsed lease expiry — executing rows, silence is the
 *   failure the sweep exists to catch. Live is the De Morgan complement
 *   `notLt(lastHeartbeatAt) AND notLt(leaseExpiresAt)`; `lastHeartbeatAt` is
 *   NOT NULL in the schema, so its complement collapses to the `{ gte }` arm,
 *   while the nullable `leaseExpiresAt` keeps both arms of `notLt` — a
 *   fresh-heartbeat row with a NULL expiry is NOT stale under the sweeper's
 *   own clause (SQL `NULL < cutoff` is UNKNOWN) and must count as live.
 * - `BLOCKED` (park-gated, #1316): a blocked worker is silent BY DESIGN, and
 *   a `blocked` ownership disposition parks the row as an external wait by
 *   moving its `leaseExpiresAt` to the park deadline (`retryAfter`). So it is
 *   reclaimable only once the park deadline elapsed OR when it never had one
 *   (`leaseExpiresAt IS NULL` — no deadline means no park, reclaimable even
 *   with a fresh heartbeat; a `blocked` disposition without `retryAfter`
 *   writes exactly that NULL in `dispositionOwnership` — no park instead of a
 *   park-shaped hold it had no deadline for). Reclaiming on the heartbeat instead would destroy
 *   the parked claim while the park is still running, deleting the lease the
 *   `blocked` disposition was recorded on. Live is the 3VL complement of
 *   `IS NULL OR lt` — `NOT IS NULL AND notLt` — derived through the sibling
 *   builder `notNullNotLt`, which spells the `IS NOT NULL` conjunct out: a
 *   NULL-deadline BLOCKED sibling is therefore FALSE (never TRUE) for the
 *   live arm and can never keep a claim alive forever.
 *
 * Both arms of both families share the pending boundary
 * `staleClaimReleasePending: false`. A row that still owes a claim release
 * belongs to neither arm: it is not a reclaim candidate (its release is
 * already owed, the dedicated `state: "STALE"` retry arm picks it up), and it
 * must not shield a claim as a live sibling either — shielding with it would
 * withhold the very release the previous sweep decided on. The complement
 * property therefore holds over NON-PENDING active rows, and a pending
 * active-shaped row is inert for both queries.
 *
 * Exported for the reclaim/live complement property test in
 * `stale-work.test.ts`, which evaluates both arms of every family against a
 * full truth grid so the coupling is pinned behaviorally, not just by
 * construction.
 */
export function activeStateFamilies(cutoff: Date): ActiveStateFamilyPredicates[] {
  return [
    {
      name: "heartbeat-gated",
      reclaim: {
        state: { in: [...HEARTBEAT_GATED_STATES] },
        staleClaimReleasePending: false,
        OR: [lt("lastHeartbeatAt", cutoff), lt("leaseExpiresAt", cutoff)],
      },
      live: {
        state: { in: [...HEARTBEAT_GATED_STATES] },
        staleClaimReleasePending: false,
        lastHeartbeatAt: { gte: cutoff },
        ...notLt("leaseExpiresAt", cutoff),
      },
    },
    {
      name: "blocked-park",
      reclaim: {
        state: "BLOCKED",
        staleClaimReleasePending: false,
        OR: [{ leaseExpiresAt: null }, lt("leaseExpiresAt", cutoff)],
      },
      live: {
        state: "BLOCKED",
        staleClaimReleasePending: false,
        ...notNullNotLt("leaseExpiresAt", cutoff),
      },
    },
  ];
}

export interface StaleWorkReport {
  examined: number;
  released: number;
  /**
   * Rows reclaimed whose claim release was WITHHELD because a live sibling
   * `AgentWork` row for the same (agent, issue) still owns the claim.
   * Such a row is counted here only — never as `released`, never as `skipped`.
   */
  claimRetained: number;
  /**
   * Rows the sweep did not reclaim this run. Two reasons: the per-issue
   * fence was held by another claim-path writer, or the claim is PARKED — a
   * running wait marker (`retryAfter` in the future, #1316/#1334) says the
   * owner defers until that deadline, so the row is left alone and reclaimed
   * through the normal path once the park elapses.
   */
  skipped: number;
  /**
   * Lease rows the sweep actually deleted through its claim-epoch CAS-fenced
   * delete (#1317 accounting). A retention deletes nothing and contributes
   * zero; only the pathological race where the CAS consumed a row yet a fresh
   * lease still stands on the pair reports a deletion alongside a retention.
   * A row reclaimed without a lease row at snapshot contributes zero.
   */
  leasesReleased: number;
  errors: Array<{ workId: string; error: string }>;
}

/**
 * The lease fields the sweep fences its delete on — the claim epoch.
 *
 * `claimToken` is minted per attempt (#1256): a released/pruned lease that is
 * claimed again gets a new row with a new token, so a token equality match can
 * never delete a NEWER attempt's receipt. `expiredAt` is moved by every renew
 * and by every (re-)claim, and `lastRenewalObservedAt` is moved by every
 * accepted ownership renewal (#1251). Together they identify "this exact claim
 * as of the snapshot read": any renew or re-claim that commits between the
 * snapshot and the delete changes at least one of them, and the fenced
 * `deleteMany` then matches nothing instead of destroying the live claim. A
 * fresh claim (a row created after the snapshot) is caught by the post-delete
 * existence recheck instead — no delete is attempted at all when the snapshot
 * saw no row. A terminal `disposition` write changes NONE of these fields, so
 * a worker cleanly disposing its claim never makes the sweep back off.
 *
 * `retryAfter` is NOT a fence field: it is read to decide whether the claim
 * is PARKED (a running wait marker, #1316/#1334) and is deliberately not
 * compared for equality — the delete's own condition excludes a running park
 * instead. The retry arm does not take a fresh epoch snapshot: a lease present
 * at retry time postdates the stale mark, which committed only after consuming
 * the marked lease and rechecking the pair empty (#1359). It must be refused,
 * not mistaken for the incarnation whose release is owed.
 */
interface ClaimEpochSnapshot {
  claimToken: string | null;
  expiredAt: Date;
  lastRenewalObservedAt: Date | null;
  retryAfter: Date | null;
}

interface StaleWorkTransactionClient {
  agentWork: {
    findFirst: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  lease: {
    findFirst: (args: any) => Promise<ClaimEpochSnapshot | null>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  agentWorkHistory: {
    create: (args: any) => Promise<unknown>;
  };
}

export interface StaleWorkClient {
  agentWork: {
    findMany: (args: any) => Promise<any[]>;
  };
  issue: IssueClaimClient["issue"];
  lease: {
    findMany: (args: any) => Promise<any[]>;
    findFirst: StaleWorkTransactionClient["lease"]["findFirst"];
    deleteMany: StaleWorkTransactionClient["lease"]["deleteMany"];
  };
  agentWorkHistory: {
    create: (args: any) => Promise<unknown>;
  };
  auditLog: {
    create: (args: any) => Promise<unknown>;
  };
  $transaction: <T>(fn: (tx: StaleWorkTransactionClient) => Promise<T>) => Promise<T>;
}

/**
 * What the mark transaction decided for one candidate row.
 *
 * `retained` means the row was reclaimed but its claim was NOT released:
 * - `live_sibling` — a live sibling `AgentWork` row still owns the claim.
 * - `claim_epoch_moved` — the lease's claim epoch changed between the sweep's
 *   snapshot read and its fenced delete (a renewal, a re-claim or a fresh
 *   claim committed inside the decision window), so the sweep backs off and
 *   leaves the lease, the label and the claim untouched.
 */
interface StaleWorkOutcome {
  marked: boolean;
  retained: boolean;
  retention?: "live_sibling" | "claim_epoch_moved";
  staleRetryRefusal?: boolean;
  liveSiblingId?: string | null;
  /**
   * Lease rows the fenced delete removed in this marked transaction
   * (#1317 accounting). Reported into `StaleWorkReport.leasesReleased`
   * once the transaction commits.
   */
  leasesDeleted?: number;
}

/**
 * Find a live sibling `AgentWork` row for the same (agent, issue) pair — a row
 * that still keeps the claim alive.
 *
 * The predicate is `OR` over `activeStateFamilies(cutoff)`'s `live` clauses —
 * the SAME family definitions the candidate query and the mark CAS consume for
 * their `reclaim` clauses. A sibling is live exactly when the sweeper's own
 * staleness test would NOT reclaim it for that state family, per state, in
 * SQL three-valued logic, and it does not owe a claim release (both arms
 * carry `staleClaimReleasePending: false`, so a pending active-shaped row is
 * never mistaken for a live shield — see `activeStateFamilies` / `notLt` for how each
 * family's live arm is derived as the 3VL complement of its reclaim arm and
 * why the NULL polarity differs per family). The structural coupling is the
 * point: one definition site, both consumers, so the two predicates cannot
 * drift apart.
 *
 * The row being processed is excluded (`id: { not: work.id }`). That exclusion
 * is defence in depth, not the load-bearing part: the live arms are the exact
 * complement of the sweeper's own candidate clause per state, so a candidate
 * row can never be live. The exclusion keeps the lookup correct even if the
 * candidate clause is ever widened.
 */
async function findLiveSiblingWork(
  tx: StaleWorkTransactionClient,
  work: { id: string; agentName: string; issueId: string | null },
  cutoff: Date,
): Promise<{ id: string } | null> {
  return tx.agentWork.findFirst({
    where: {
      agentName: work.agentName,
      issueId: work.issueId,
      id: { not: work.id },
      OR: activeStateFamilies(cutoff).map((family) => family.live),
    },
    select: { id: true },
  });
}

/**
 * Reclaim expired AgentWork rows. A row is first moved to STALE with a
 * retryable marker in the database, then its GitHub claim is released. If the
 * process dies between those steps, the next sweep retries the marked row.
 *
 * The release is claim-incarnation safe on two levels:
 *
 * 1. **Serialized fence.** Every release of an issue-scoped claim runs inside
 *    the same per-issue `IssueMutationGuard` fence (#1259) that claim, lease,
 *    ownership renewal and capacity release take. The lookup, the mark, the
 *    lease delete and the external GitHub label release all happen while the
 *    fence is held, so no writer can commit "between the check and the delete"
 *    — the TOCTOU the sibling lookup alone cannot close. A busy fence skips
 *    the row for this sweep (nothing is lost: the retry marker is only ever
 *    set inside the fenced window, and STALE+pending rows are sweep
 *    candidates again). A guard demoted to non-executing by a failed release
 *    is resumed by the next sweep of the same (issue, agent) — safe because
 *    every step is a conditional update or a deduped release. A guard left
 *    `executing` by a crashed process is never taken over automatically: it
 *    stays fail-closed (like a crashed claim guard) pending operator
 *    intervention.
 * 2. **Claim-epoch fence.** The mark-arm lease delete is a compare-and-delete
 *    against a snapshot of `{claimToken, expiredAt, lastRenewalObservedAt}`
 *    taken BEFORE the sibling lookup, rechecked after the delete for any
 *    lease left on the pair. If any renew, re-claim or fresh claim commits
 *    between the snapshot and the delete, the fence no longer matches (or a
 *    new row shows up) and the sweep backs off: the row is still reclaimed
 *    (STALE) but the claim, lease and label are reported retained, never
 *    released. This is the belt to the fence's braces — it also covers any
 *    future writer that forgets the mutation guard.
 * 3. **No retry re-snapshot (#1359).** The mark commits a pending release only
 *    after consuming the marked lease incarnation and rechecking that no lease
 *    remains. A lease found by a later retry therefore postdates the mark, even
 *    if it belongs to the same agent; the retry refuses to delete it or release
 *    its label. The lease stays untouched and the pending row is retired as a
 *    claim-epoch retention.
 *
 * A third rule sits in front of both: a PARKED claim is not stale work at
 * all. A running wait marker on the lease (`retryAfter` in the future,
 * #1316/#1334) says the owner defers until that deadline, so the sweep skips
 * the row — no STALE mark, no lease delete, no claim release — and the normal
 * reclaim path applies once the deadline elapses. The marker is written by
 * both a `blocked` ownership disposition and a renewal's `externalWait`, and
 * the sweep reads it off the lease, so the protection is uniform in the wait
 * marker itself.
 */
export async function sweepStaleWork(
  client: StaleWorkClient = prisma as unknown as StaleWorkClient,
  maxAgeMs = DEFAULT_STALE_WORK_MAX_AGE_MS,
  batchSize = DEFAULT_STALE_WORK_BATCH_SIZE,
): Promise<StaleWorkReport> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - maxAgeMs);

  // A PARKED claim is not reclaim work at all (#1334): a running wait marker
  // on the lease says the owner defers until that deadline. Parked claims are
  // excluded from the candidate query UP FRONT, because the query orders by
  // the oldest heartbeat first and a parked row's heartbeat is old BY
  // DEFINITION — without this, parked claims would fill the candidate batch
  // on every sweep and starve the genuinely stale rows behind them. The
  // in-transaction park check stays authoritative: a park that starts after
  // this read is caught there.
  const parkedClaims = await findParkedClaims(client, now);
  const reclaimClause = {
    OR: [
      ...activeStateFamilies(cutoff).map((family) => family.reclaim),
      { state: "STALE", staleClaimReleasePending: true },
    ],
  };
  const candidates = await client.agentWork.findMany({
    where:
      parkedClaims.length > 0
        ? { AND: [reclaimClause, { NOT: { OR: parkedClaims } }] }
        : reclaimClause,
    orderBy: { lastHeartbeatAt: "asc" },
    take: batchSize,
    include: {
      issue: {
        select: {
          id: true,
          number: true,
          state: true,
          labels: true,
          blockedReason: true,
          linkedPrNumber: true,
          repository: { select: { fullName: true } },
        },
      },
    },
  });

  const report: StaleWorkReport = {
    examined: candidates.length,
    released: 0,
    claimRetained: 0,
    skipped: 0,
    leasesReleased: 0,
    errors: [],
  };

  // One candidate's full reclaim pipeline: mark STALE, delete the claim's
  // lease (fenced on its epoch), release the GitHub claim, finalize the row.
  // For issue-scoped claims the whole pipeline runs inside the per-issue
  // mutation fence held by the caller.
  const reclaimStaleRow = async (work: any): Promise<void> => {
    // Claim the stale transition before external I/O. A heartbeat that
    // commits first makes the conditional update miss; a heartbeat after
    // this point sees a terminal STALE row and cannot revive it midway.
    const outcome = await client.$transaction(async (tx): Promise<StaleWorkOutcome> => {
      // The row's shape BEFORE this transaction writes anything: the restore
      // in the park branch below puts it back exactly as the sweep found it.
      const before = {
        state: work.state,
        leaseExpiresAt: work.leaseExpiresAt,
        staleClaimReleasePending: work.staleClaimReleasePending,
      };

      // Which arm this decision belongs to, captured BEFORE either CAS runs:
      // the retry update below requires exactly `state: "STALE"` plus the
      // pending marker, the mark update an active-shaped non-pending row —
      // disjoint predicates, so this pre-write snapshot decides the arm. The
      // mark CAS flips the row to STALE as a SIDE EFFECT, so the arm must
      // never be re-derived from the row state after it (#1359).
      const retryArm = work.state === "STALE";

      // Claim-epoch snapshot, taken BEFORE the sibling lookup: every write the
      // fenced delete below can no longer match is a write that committed
      // inside the decision window (snapshot → delete), i.e. exactly the
      // renewal / re-claim the lookup raced against.
      const epoch = work.issueId
        ? await tx.lease.findFirst({
            where: { agentName: work.agentName, issueId: work.issueId },
            select: { claimToken: true, expiredAt: true, lastRenewalObservedAt: true, retryAfter: true },
          })
        : null;

      // A RUNNING wait marker parks the claim until its deadline (#1316/#1334).
      // The owner recorded that it defers until then, so its silence is not
      // evidence of abandonment: the sweep leaves the row alone — no STALE
      // mark, no lease delete, no claim release — and the normal reclaim path
      // applies once the deadline elapses (the marker is spent by then, so the
      // row is reclaimed for good). This is the half of the park protection
      // the row-level park deadline cannot cover: a renewal's `externalWait`
      // parks the LEASE only, so the marker has to be read off the lease.
      if (parkRunning(epoch, now)) {
        return { marked: false, retained: false };
      }

      // Claim-incarnation guard. A live sibling row for the same (agent,
      // issue) still owns the claim, so this row's reclaim must not release
      // it. A row without an issue owns no claim at all (no lease, no
      // label), so there is nothing a sibling could be keeping alive.
      const liveSibling = work.issueId
        ? await findLiveSiblingWork(tx, work, cutoff)
        : null;

      if (work.state === "STALE") {
        const result = await tx.agentWork.updateMany({
          where: { id: work.id, state: "STALE", staleClaimReleasePending: true },
          // The retry marker is cleared in both cases: with a live sibling
          // the release is no longer owed, and without one the release is
          // about to happen below.
          data: liveSibling
            ? { leaseExpiresAt: now, staleClaimReleasePending: false }
            : { leaseExpiresAt: now },
        });
        if (result.count !== 1) return { marked: false, retained: false };
      } else {
        const result = await tx.agentWork.updateMany({
          where: {
            id: work.id,
            staleClaimReleasePending: false,
            OR: activeStateFamilies(cutoff).map((family) => family.reclaim),
          },
          // A live sibling owns the claim, so no release is owed for this
          // row: the marker stays down and the retry loop stops.
          data: liveSibling
            ? { state: "STALE", leaseExpiresAt: now, staleClaimReleasePending: false }
            : { state: "STALE", leaseExpiresAt: now, staleClaimReleasePending: true },
        });
        if (result.count !== 1) return { marked: false, retained: false };

        await tx.agentWorkHistory.create({
          data: { workId: work.id, action: "stale" },
        });
      }

      if (liveSibling) {
        // The claim stays with the live sibling: no lease delete, no
        // release, so the `agent/<name>` label survives untouched.
        return { marked: true, retained: true, retention: "live_sibling", liveSiblingId: liveSibling.id };
      }

      // Releasing the lease in the same transaction as the stale marker
      // keeps the database-side queue blockers consistent across retries.
      // The delete is CAS-fenced on the epoch snapshot: a lease that was
      // renewed or re-claimed after the snapshot no longer matches and stays
      // untouched. With NO snapshot row there is nothing legitimate to
      // delete at all, so no delete is even attempted — a fresh claim created
      // inside the window can only be a row that postdates the snapshot, and
      // the existence recheck below catches it (no clock comparison needed).
      let leasesDeleted = 0;
      if (work.issueId) {
        let epochMoved = false;
        if (epoch) {
          if (retryArm) {
            // #1359: the mark committed pending only after its CAS consumed the
            // marked lease incarnation and its recheck found the pair empty.
            // A lease read now is a newer claim incarnation (including a
            // same-agent re-claim in the crash window), so retry must not
            // consume it or release its agent label.
            epochMoved = true;
          } else {
            const deleted = await tx.lease.deleteMany({
              where: {
                agentName: work.agentName,
                issueId: work.issueId,
                claimToken: epoch.claimToken,
                expiredAt: epoch.expiredAt,
                lastRenewalObservedAt: epoch.lastRenewalObservedAt,
                // #1334: a RUNNING park is not evidence of abandonment, so the
                // delete must not consume the lease the park was recorded on.
                // Defence in depth: every writer of the marker takes the same
                // per-issue fence the sweep holds, so the lease cannot change
                // inside the decision window — but the sweep must not depend on
                // that to keep a park alive. A lease with no wait marker
                // (`retryAfter IS NULL`) or an elapsed one is reclaimable as
                // before.
                OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
              },
            });
            if ((deleted?.count ?? 0) !== 1) epochMoved = true;
            else leasesDeleted = deleted.count;
          }
        }
        // A lease on the pair at the end of the window that the sweep did not
        // consume — a fresh claim that raced in during the window, or behind
        // a successful delete — means the claim epoch moved.
        const remaining = await tx.lease.findFirst({
          where: { agentName: work.agentName, issueId: work.issueId },
          // The full epoch snapshot, so the row this returns is the shape the
          // type declares — the recheck answers "is the claim still there?"
          // and "is it parked?".
          select: { claimToken: true, expiredAt: true, lastRenewalObservedAt: true, retryAfter: true },
        });
        if (remaining && parkRunning(remaining, now)) {
          // A park is running on the claim now — it started inside the sweep's
          // decision window (or the snapshot read it too early). The claim is
          // parked, so this row must NOT be left reclaimed: the mark above
          // would retire the parked owner's row while its park still runs, and
          // the row would never be reclaimed again (the release it owed is
          // dropped) — the claim would leak. Restore the row to the shape the
          // sweep found it in and leave the claim alone; the park deadline,
          // not the sweep, decides when the work is reclaimable. A restore
          // that matched nothing leaves the row STALE with its release owed,
          // which the retry arm picks up once the park has elapsed.
          await tx.agentWork.updateMany({
            where: { id: work.id, state: "STALE" },
            data: {
              state: before.state,
              leaseExpiresAt: before.leaseExpiresAt,
              staleClaimReleasePending: before.staleClaimReleasePending,
            },
          });
          return { marked: false, retained: false };
        }
        if (remaining) epochMoved = true;
        if (epochMoved) {
          // A renewal, re-claim or fresh claim won the window. Back off — the
          // row stays reclaimed, but the lease, the label and the claim are
          // left alone, and the retry marker goes down so the next sweep does
          // not chase it. The next sweep re-decides against CURRENT state:
          // the fresh claim is then visible to the sibling lookup as well.
          const reverted = await tx.agentWork.updateMany({
            where: { id: work.id, state: "STALE" },
            data: { leaseExpiresAt: now, staleClaimReleasePending: false },
          });
          if (reverted.count !== 1) return { marked: false, retained: false };
          // In the pathological case where the CAS delete consumed a row AND
          // a recheck still found one, the consumed deletion is still real —
          // report it honestly even though this row is retained.
          return {
            marked: true,
            retained: true,
            retention: "claim_epoch_moved",
            staleRetryRefusal: retryArm,
            leasesDeleted,
          };
        }
      }
      return { marked: true, retained: false, liveSiblingId: null, leasesDeleted };
    });

    if (!outcome?.marked) {
      report.skipped++;
      return;
    }
    report.leasesReleased += outcome.leasesDeleted ?? 0;

    if (outcome.retained) {
      // The row was reclaimed, but the claim it could have released is live:
      // a sibling row still owns it, or the claim epoch moved under the
      // sweep. Recorded as a retention, not a release: the labels are
      // unchanged because nothing was released.
      report.claimRetained++;
      const issueRef = [work.issueId, work.issue?.number != null ? `#${work.issue.number}` : null]
        .filter((part): part is string => Boolean(part))
        .join(" ");
      const reason =
        outcome.retention === "claim_epoch_moved"
          ? outcome.staleRetryRefusal
            ? "a newer claim incarnation landed after the row's stale mark (#1359)"
            : "the claim epoch moved (renewal, re-claim or fresh claim committed inside the sweep's decision window)"
          : `live AgentWork ${outcome.liveSiblingId} still owns the claim`;
      // The retention decision is already committed and the row is no longer
      // a sweep candidate, so a failure here must NOT escape: it would leave
      // the mutation guard demoted with nothing left to resume it (resume is
      // only reachable from a candidate), freezing every claim-path write on
      // the issue. Surface the audit failure in the report instead.
      try {
        await client.auditLog.create({
          data: {
            actor: "system",
            action: "stale_agentwork_claim_retained",
            repoFullName: work.issue?.repository?.fullName ?? "",
            issueNumber: work.issue?.number ?? undefined,
            issueId: work.issueId ?? undefined,
            beforeLabels: work.issue?.labels ?? [],
            afterLabels: work.issue?.labels ?? [],
            success: true,
            notes: `Retained the claim of stale AgentWork ${work.id} (agent ${work.agentName}, issue ${issueRef}): ${reason}`,
          },
        });
      } catch (error) {
        report.errors.push({
          workId: work.id,
          error: `claim-retention audit failed (retention itself committed): ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (work.issue) {
      // The release is attributed to the sweep, not to the abandoned agent:
      // nobody chose to let this claim go, and a claim-to-merge read must be
      // able to tell a recovered stall apart from a worker's own unclaim
      // (#1202).
      await releaseIssueClaim({
        prisma: client,
        issue: work.issue,
        repoFullName: work.issue.repository.fullName,
        issueNumber: work.issue.number,
        agentName: work.agentName,
        options: {
          allowMissingAgent: true,
          preserveStatus: true,
          source: "stale-recovery",
          actor: "system",
          // This AgentWork row is this claim epoch, and it is stable across a
          // retry of the same sweep (the retry re-marks the same STALE row).
          // Keying the release on it means the release and the
          // already-released repair a retry has to take are one
          // `claim_released`, not two. A reclaimed issue gets a new row and
          // therefore a new key, so a genuine second release still counts.
          releaseKey: lifecycleDedupeKey("agent-work", work.id),
        },
      });
    }

    const finalized = await client.$transaction(async (tx) => {
      const result = await tx.agentWork.updateMany({
        where: { id: work.id, state: "STALE", staleClaimReleasePending: true },
        data: { staleClaimReleasePending: false },
      });
      return result.count === 1;
    });

    if (!finalized) {
      report.skipped++;
      return;
    }

    report.released++;
    // Same posture as the retention audit: the release is committed and the
    // row is finalized, so this audit must not escape and strand the guard
    // with no resumable candidate behind it.
    try {
      await client.auditLog.create({
        data: {
          actor: "system",
          action: "stale_agentwork_released",
          repoFullName: work.issue?.repository?.fullName ?? "",
          issueNumber: work.issue?.number ?? undefined,
          issueId: work.issueId ?? undefined,
          beforeLabels: work.issue?.labels ?? [],
          afterLabels: work.issue
            ? work.issue.labels.filter((label: string) => label !== `agent/${work.agentName}`)
            : [],
          success: true,
          notes: `Released stale AgentWork ${work.id} for agent ${work.agentName}`,
        },
      });
    } catch (error) {
      report.errors.push({
        workId: work.id,
        error: `release audit failed (release itself committed): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  for (const work of candidates) {
    try {
      if (work.issueId) {
        // Issue-scoped claim: run the whole decision-and-release pipeline
        // inside the per-issue mutation fence that claim, lease, ownership
        // renewal and capacity release take (#1259). Without it the sibling
        // lookup is a TOCTOU check: a renewal or fresh claim could commit
        // between the lookup and the delete, and the sweep would destroy a
        // live claim's lease and label. Busy means another claim-path writer
        // holds the issue: skip this row for this sweep — nothing is lost,
        // because a pending release is only ever owed from inside a fenced
        // window that completed far enough to owe one.
        const guarded = await withIssueMutationGuard(
          { issueId: work.issueId, operation: "stale-release", agentName: work.agentName },
          async () => ({ complete: true, value: await reclaimStaleRow(work) }),
        );
        if (guarded.status === "busy") report.skipped++;
      } else {
        // No issue: no lease, no label, nothing for a fence to protect.
        await reclaimStaleRow(work);
      }
    } catch (error) {
      report.errors.push({
        workId: work.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
