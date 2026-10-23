// ─── Fenced capacity-exhaustion recovery for issues (#1256) ──────────────────
//
// A worker that has CLAIMED an issue but discovers its execution capacity
// cannot run the task needs a way to hand the work back that is safe under
// races. Plain unclaim accepts only (issue identity, agent name): a stale
// worker can release a claim it no longer holds the moment another agent (or
// a human reassignment) moves the label, and lease expiry alone never clears
// the `agent/*` label or guarantees rediscovery.
//
// A durable, nonexpiring issue mutation guard excludes cooperating claim
// and lease writers throughout remote cleanup. Failed cleanup retains the
// lease and guard for exact-token retry; a crashed executor requires operator
// recovery. GitHub itself provides no label CAS against external mutations.

import { AGENT_PREFIX, getAgentFromLabels } from "@/types";
import { removeIssueLabel } from "./github";
import { getLiveIssueLabels } from "./claim-gate";
import { releaseIssueClaim, fencedClaimClient, releaseIssueClaimWorstCaseCalls } from "./issue-claim";
import { recordCapacityHandoff, capacityCooldownMs, type CapacityHandoffClient } from "./capacity-handoff";
import {
  lookupIssueHandoffSettlement,
  recordIssueHandoffSettlement,
  ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS,
} from "./issue-handoff-settlement";
import {
  withIssueMutationGuard,
  fencedWriteTimeoutForCalls,
  type FencedRemoteWriteOptions,
  type FencedRemoteWriteResult,
} from "./issue-mutation-guard";

/**
 * The fenced-write capability the per-issue guard hands to its callback.
 */
type FencedRemoteWrite = <T>(
  fn: (tx: any) => Promise<T>,
  options?: FencedRemoteWriteOptions,
) => Promise<FencedRemoteWriteResult<T>>;

// `fencedClaimClient` lives in `./issue-claim` next to the release it feeds
// (shared with the unclaim route, #1367); imported above.

export interface IssueCapacityHandoffClient extends CapacityHandoffClient {
  issue: {
    findUnique: (args: any) => Promise<any>;
    update: (args: any) => Promise<unknown>;
  };
  lease: {
    findUnique: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  agentWork: {
    findMany: (args: any) => Promise<any[]>;
    update: (args: any) => Promise<unknown>;
  };
  agentWorkHistory: {
    create: (args: any) => Promise<unknown>;
  };
  auditLog: {
    create: (args: any) => Promise<unknown>;
  };
  issueHandoffSettlement: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
}

export type IssueCapacityHandoffInput = {
  client: IssueCapacityHandoffClient;
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  agentName: string;
  claimToken: string;
  capacity: string;
  /** Caller settlement idempotency key (#1262). Optional: when present the
   *  release is recorded durably and an identical retry (same key + original
   *  claim token) replays the recorded success; when absent the behavior is
   *  exactly the pre-#1262 path. Opaque caller data — never a secret. */
  settlementKey?: string | null;
  note?: string | null;
  /** Audit actor identity (token-derived for bound workers). */
  actor: string;
  now?: Date;
};

export type IssueCapacityHandoffResult =
  | {
      ok: true;
      labels: string[];
      status: string | null;
      statusNote: string | null;
      /** null only when the best-effort post-release cooldown write failed. */
      cooldownUntil: Date | null;
      /** true when this response replays a durable settlement record (#1262):
       *  the recorded past success is echoed verbatim with zero mutation. */
      replayed: boolean;
    }
  | {
      ok: false;
      /** HTTP status to surface. */
      httpStatus: number;
      /** Machine-readable refusal class. */
      code:
        | "issue_not_found"
        | "identity_mismatch"
        | "issue_closed"
        | "issue_done"
        | "human_hold"
        | "no_active_claim"
        | "stale_claim_token"
        | "claim_expired"
        | "ownership_changed"
        | "handoff_race_lost"
        | "settlement_key_conflict"
        | "settlement_unavailable"
        | "github_unavailable"
        | "release_failed";
      message: string;
    };

/**
 * Fenced capacity-exhaustion recovery for a claimed issue. See file header for
 * the ownership/human-hold semantics. Never consumes task-repair budget and
 * never touches PR/branch identity (branch/PR metadata stays on the lease
 * history and AgentWork rows; the issue itself only loses its claim).
 */
export async function recoverIssueCapacityHandoff(
  input: IssueCapacityHandoffInput,
): Promise<IssueCapacityHandoffResult> {
  const guarded = await withIssueMutationGuard({
    issueId: input.issueId,
    operation: "capacity-release",
    agentName: input.agentName,
    claimToken: input.claimToken,
  }, async (_tx, { resuming, runFencedRemoteWrite }) => {
    // #1254: the fenced-write capability travels INTO the release path: the
    // remote ownership writes below run inside the guard's row lock, so a
    // maintainer force-claim can neither take this holder's guard between
    // the check and the write nor land its own claim while the write is in
    // flight.
    const value = await recoverIssueCapacityHandoffUnlocked(input, resuming, runFencedRemoteWrite);
    return { complete: !(value.ok === false && (value.code === "release_failed" || value.code === "github_unavailable" || value.code === "settlement_unavailable")), value };
  });
  if (guarded.status === "busy") {
    // Same #1129 identity gate as the release path: every write — including
    // the best-effort replay audit row — must carry verified repo/number
    // identity.
    const issue = await input.client.issue.findUnique({
      where: { id: input.issueId },
      include: { repository: true },
    });
    if (!issue) return { ok: false, httpStatus: 404, code: "issue_not_found", message: "Issue not found in local cache" };
    if (issue.repository?.fullName !== input.repoFullName || issue.number !== input.issueNumber) {
      return {
        ok: false,
        httpStatus: 400,
        code: "identity_mismatch",
        message: `issueId does not match repoFullName/issueNumber; expected ${issue.repository?.fullName}#${issue.number}`,
      };
    }
    // A recorded settlement makes the answer definitive even while the guard
    // is held: after a post-release crash the orphaned executing guard would
    // otherwise hide a durably completed release behind a busy 409. The
    // replay is a pure read gated on lease absence — while a release is
    // genuinely in flight the lease is still present and this returns null.
    const outcome = await replayIssueHandoffSettlement(input.client, input, undefined, input.now);
    if (outcome?.kind === "replayed") return outcome.result;
    return {
      ok: false, httpStatus: 409, code: "handoff_race_lost",
      message: "Issue mutation is in progress; retry after recovery completes",
    };
  }
  return guarded.value;
}

type ReplayOutcome =
  | { kind: "replayed"; result: IssueCapacityHandoffResult }
  | { kind: "foreign" }
  | { kind: "expired" }
  | null;

/**
 * Read-only replay of a recorded settlement (#1262). Returns `replayed` only
 * for the exact (agent, issue, key, claimToken) while the lease row is gone —
 * the one state in which the release is durably complete: the record is
 * written after remote cleanup and before the lease CAS, and a CAS miss
 * retracts it. (Between a record write and a CAS-miss retraction a bypassing
 * lease deletion can therefore replay while the settler itself reports
 * race-lost: the claim IS released in that state — labels were cleaned before
 * the record exists — and only the bounded, self-expiring cooldown row is
 * missing.) `foreign` marks a settled key presented under a different claim
 * token, `expired` a proof past its retention deadline; every other case
 * returns null and the caller proceeds fail-closed. The lookup runs before
 * the lease gate so an expired proof is pruned and a resumed release
 * re-records a fresh one (self-heal) even under a live lease — that lazy
 * prune is a write performed outside the guard on this path. Otherwise replay
 * mutates no ownership state; the only other writes are the best-effort
 * replay audit row and (when inside the guard) the transient guard row.
 *
 * `lease` sentinel: `undefined` = read the lease row here (busy path; a read
 * failure fails closed to null → busy 409); `null` = known absent; a row =
 * known live, replay gated off.
 */
async function replayIssueHandoffSettlement(
  client: IssueCapacityHandoffClient,
  input: IssueCapacityHandoffInput,
  lease?: { claimToken: string | null } | null,
  now: Date = new Date(),
): Promise<ReplayOutcome> {
  if (!input.settlementKey) return null;
  const { agentName, issueId, claimToken } = input;
  const lookup = await lookupIssueHandoffSettlement(
    client,
    { agentName, issueId, settlementKey: input.settlementKey },
    now,
  );
  if (lookup.state === "error") {
    // Nothing verifiable: announce nothing. The key-conflict fence below
    // re-reads and refuses retryably if the failure persists.
    return null;
  }
  if (lookup.state === "expired") return { kind: "expired" };
  let leaseRow = lease;
  if (leaseRow === undefined) {
    try {
      leaseRow = await client.lease.findUnique({ where: { agentName_issueId: { agentName, issueId } } });
    } catch {
      // Fail closed: without a verified lease state, announce nothing.
      return null;
    }
  }
  if (leaseRow) return null;
  if (lookup.state !== "found") return null;
  if (lookup.record.claimToken !== claimToken) return { kind: "foreign" };
  try {
    await client.auditLog.create({
      data: {
        actor: input.actor,
        action: "issue_capacity_handoff",
        repoFullName: input.repoFullName,
        issueNumber: input.issueNumber,
        issueId,
        beforeLabels: [],
        afterLabels: lookup.record.labels,
        success: true,
        notes:
          `replayed from durable settlement record ${lookup.record.id}; capacity=${lookup.record.capacity}; ` +
          `settledAt=${new Date(lookup.record.settledAt).toISOString()}; zero mutation`,
      },
    });
  } catch {
    // Replay visibility is best-effort; the recorded result stands.
  }
  return {
    kind: "replayed",
    result: {
      ok: true,
      labels: lookup.record.labels,
      status: lookup.record.status ?? null,
      statusNote: lookup.record.statusNote ?? null,
      cooldownUntil: lookup.record.cooldownUntil ? new Date(lookup.record.cooldownUntil) : null,
      replayed: true,
    },
  };
}

async function recoverIssueCapacityHandoffUnlocked(
  input: IssueCapacityHandoffInput,
  resuming: boolean,
  fencedWrite: FencedRemoteWrite,
): Promise<IssueCapacityHandoffResult> {
  const { client, issueId, repoFullName, issueNumber, agentName, claimToken, capacity } = input;
  const now = input.now ?? new Date();
  const agentLabel = `${AGENT_PREFIX}${agentName}`;

  // ── 1. Identity + non-negotiable issue state (cache is fine here) ────────
  const issue = await client.issue.findUnique({
    where: { id: issueId },
    include: { repository: true },
  });
  if (!issue) {
    return { ok: false, httpStatus: 404, code: "issue_not_found", message: "Issue not found in local cache" };
  }
  // #1129 identity invariant: canonical repo/number come from the DB row; any
  // cross-reference mix-up is refused before a single write.
  if (issue.repository?.fullName !== repoFullName || issue.number !== issueNumber) {
    return {
      ok: false,
      httpStatus: 400,
      code: "identity_mismatch",
      message: `issueId does not match repoFullName/issueNumber; expected ${issue.repository?.fullName}#${issue.number}`,
    };
  }

  // ── 1a. Lease row read (shared by the replay check and the fence) ────────
  // The lease row is read before the replay check (#1262): a settlement
  // record proves a completed release only while the lease is gone. A record
  // under a live lease is a crash-before-CAS window that the exact-token
  // resume below must finish, never replay over.
  const lease = await client.lease.findUnique({
    where: { agentName_issueId: { agentName, issueId } },
  });

  // ── 1b. Durable settlement replay (#1262) ─────────────────────────────────
  // A recorded success is a fact about the past: with the same key and the
  // original claim token it replays verbatim with zero mutation, checked
  // before state refusals so a later close/block can never mask the recorded
  // outcome and leave the caller proving an unprovable release. Fail-closed
  // refusals below cover every non-exact case; nothing synthetic is produced.
  let expiredProof = false;
  if (input.settlementKey) {
    const outcome = await replayIssueHandoffSettlement(client, input, lease, now);
    if (outcome?.kind === "replayed") return outcome.result;
    if (outcome?.kind === "foreign" && !lease) {
      // The key is settled under a different claim incarnation: presenting a
      // foreign token to a settled key proves nothing and must never replay.
      return {
        ok: false,
        httpStatus: 409,
        code: "no_active_claim",
        message:
          "settlementKey is already settled under a different claim token; presenting a foreign token to a settled key is refused (no unsafe replay)",
      };
    }
    if (outcome?.kind === "expired") expiredProof = true;
  }

  if (issue.state === "closed") {
    return { ok: false, httpStatus: 400, code: "issue_closed", message: "Cannot hand off a closed issue" };
  }
  const cachedStatus = issue.labels.find((l: string) => l.startsWith("status/"));
  if (cachedStatus === "status/done") {
    return { ok: false, httpStatus: 400, code: "issue_done", message: "Cannot hand off a done issue" };
  }
  // Human hold: a deliberate block carries a blockedReason; releasing the
  // claim here would drag a human-owned decision back into circulation.
  if (cachedStatus === "status/blocked" && (issue.blockedReason ?? null) != null) {
    return {
      ok: false,
      httpStatus: 409,
      code: "human_hold",
      message: "Issue is deliberately blocked (blockedReason is set); a capacity handoff never overrides a human hold",
    };
  }

  // ── 2. Fence to the exact claim (agent + lease row + issued token) ───────
  if (!lease || !lease.claimToken) {
    return {
      ok: false,
      httpStatus: 409,
      code: "no_active_claim",
      message:
        "No active tokened claim exists for this agent+issue; this claim was already released, superseded, or predates claim tokens — re-claim to obtain a fresh fenced token (do not force an unclaim)" +
        (expiredProof
          ? `; a settlement proof for this key exists but has expired (retention ${ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS} ms) — no unsafe replay`
          : ""),
    };
  }
  if (lease.claimToken !== claimToken) {
    // A re-claim produced a new lease row with a new token. This token belongs
    // to a previous (stale) claim and is inert.
    return {
      ok: false,
      httpStatus: 409,
      code: "stale_claim_token",
      message: "claimToken does not match the current claim; a re-issued claim invalidates prior tokens",
    };
  }
  if (!resuming && new Date(lease.expiredAt).getTime() <= now.getTime()) {
    return {
      ok: false,
      httpStatus: 409,
      code: "claim_expired",
      message: "Claim has expired; stale-claim recovery owns release from here",
    };
  }

  // #1262: a settlement key is bound to exactly one claim incarnation. If the
  // key is already recorded under a different token, this caller is reusing a
  // key across claims — refuse before any remote work (zero mutation); a
  // fresh key is the caller's recovery.
  if (input.settlementKey) {
    let existing: any = null;
    try {
      existing = await client.issueHandoffSettlement.findUnique({
        where: { agentName_issueId_settlementKey: { agentName, issueId, settlementKey: input.settlementKey } },
      });
    } catch (error) {
      // Fail closed: a failed read cannot establish that the key is unused.
      // Proceeding as if absent would let a durable proof under an older
      // claim token coexist with — and fail to fence — the release of a
      // newer live claim (the first-write-wins upsert can never rewrite or
      // validate the existing proof afterward). Refuse retryably with zero
      // mutation; the retained guard lets the exact-token retry resume.
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        ok: false,
        httpStatus: 503,
        code: "settlement_unavailable",
        message: `Could not verify the settlement-key fence: ${message}; nothing was released — retry with the same claimToken and settlementKey`,
      };
    }
    if (existing && existing.claimToken !== claimToken) {
      return {
        ok: false,
        httpStatus: 409,
        code: "settlement_key_conflict",
        message:
          "settlementKey is already bound to a different claim token; retry with a fresh settlement key (keys are never reused across claim incarnations)",
      };
    }
  }

  // ── 3. Ownership against LIVE GitHub labels (#1037), fail closed ─────────
  let liveLabels: string[];
  try {
    liveLabels = await getLiveIssueLabels(repoFullName, issueNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      ok: false,
      httpStatus: 503,
      code: "github_unavailable",
      message: `Could not verify live GitHub labels: ${message}`,
    };
  }
  const refusal = classifyLiveLabels(liveLabels, agentLabel);
  // A previous attempt may have removed the label before a later write
  // failed. The durable guard still excludes a new claim epoch.
  if (refusal && (!resuming || refusal.code === "human_hold" || refusal.code === "issue_done")) return refusal;

  // ── 4. Recheck live labels before any remote mutation ────────────────────
  let releaseLabels = liveLabels;
  let ownershipChangedPostCas = false;
  try {
    const recheck = await getLiveIssueLabels(repoFullName, issueNumber);
    const changed = classifyLiveLabels(recheck, agentLabel, true);
    if (changed?.code === "human_hold" || changed?.code === "issue_done") return changed;
    if (changed || !recheck.includes(agentLabel)) ownershipChangedPostCas = true;
    releaseLabels = recheck;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await writeFailureAudit(client, input, liveLabels, `Could not verify live GitHub labels before release: ${message}`);
    return { ok: false, httpStatus: 503, code: "github_unavailable", message: `Could not verify live GitHub labels before release: ${message}` };
  }

  // ── 5. Release the claim with the shared resting-status policy ───────────
  // The fresh label set is authoritative. A changed owner or newly applied
  // human hold permits only targeted own-label cleanup, never status changes.
  let labels: string[];
  let status: string | null;
  let statusNote: string | null;
  if (ownershipChangedPostCas) {
    const newOwner = getAgentFromLabels(releaseLabels);
    // #1254: the targeted removal of OUR OWN label is a remote ownership
    // write, so it runs inside the FENCED write: the guard check and the
    // forge write share one transaction that holds the guard row's lock, so a
    // maintainer force-claim can neither take this holder's guard between the
    // check and the write nor land its own claim while the removal is in
    // flight. When the guard is already gone/re-owned the forge function is
    // NEVER called: no label is written, the lease and the claim stay
    // intact, and the module's failure shape names the guard loss.
    // The targeted removal carries exactly ONE mutating forge call, so this
    // region uses the default single-call fence budget.
    let removal: FencedRemoteWriteResult<boolean>;
    try {
      // Targeted, idempotent: only our own label. Never a status write —
      // the new owner's transition stands.
      removal = await fencedWrite(async () => {
        await removeIssueLabel(repoFullName, issueNumber, agentLabel);
        return true;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await writeFailureAudit(client, input, liveLabels, `Could not remove claim label: ${message}`);
      return { ok: false, httpStatus: 500, code: "release_failed", message: `Could not remove claim label; lease and release guard retained: ${message}` };
    }
    if (removal.status === "guard-lost") {
      await writeFailureAudit(
        client,
        input,
        liveLabels,
        "Capacity handoff skipped the remote label removal: the mutation guard was taken by an operator override before the remote write",
      );
      return {
        ok: false,
        httpStatus: 500,
        code: "release_failed",
        message:
          "Could not remove claim label; the mutation guard was taken by an operator override before the remote write — lease and release guard retained",
      };
    }
    labels = releaseLabels.filter((l: string) => l !== agentLabel);
    status = labels.find((l: string) => l.startsWith("status/")) ?? null;
    statusNote = newOwner
        ? `claim moved to ${newOwner} before cleanup; only our own agent label was removed — no status change`
        : "no agent claim present before cleanup; mirrored GitHub minus our label — no status change";
    try {
      await client.issue.update({
        where: { id: issueId },
        data: { labels, lastSyncedAt: now },
      });
    } catch (error) {
      console.error(`capacity handoff: cache mirror failed for ${repoFullName}#${issueNumber}:`, error);
    }
  } else try {
    // #1254: the shared release is a remote ownership write, so it runs
    // inside the FENCED write: the guard check and the forge write share one
    // transaction that holds the guard row's lock, so a maintainer
    // force-claim can neither take this holder's guard between the check and
    // the write nor land its own claim while the release is in flight. When
    // the guard is already gone/re-owned the forge function is NEVER called:
    // no label is written, the lease and the claim stay intact, and the
    // module's failure shape names the guard loss.
    //
    // The release's remote call count is DATA-DEPENDENT — the ownership
    // removal plus a chained `transitionIssueStatus`, which removes EVERY
    // observed `status/*` label one call each (duplicated status labels are a
    // documented data-quality edge case, #1037) — so the region derives its
    // budget from the label set the release actually receives (the second
    // live read) rather than a fixed multiplier:
    // `fencedWriteTimeoutForCalls(releaseIssueClaimWorstCaseCalls(releaseLabels))`.
    // An over-bound is cheaper than a bound a new duplicated-status shape can
    // outrun (#1367 review). Supporting local writes (mirror, lifecycle row)
    // are database work inside this same budget.
    const released = await fencedWrite(async (tx) => releaseIssueClaim({
      // The release's own local writes (the cache mirror and the
      // `claim_released` evidence row) join the fenced transaction through a
      // THIN client, so the release cannot open a nested interactive
      // transaction inside the region.
      prisma: fencedClaimClient(tx),
      issue: { ...issue, labels: releaseLabels },
      repoFullName,
      issueNumber,
      agentName,
    }), {
      timeoutMs: fencedWriteTimeoutForCalls(releaseIssueClaimWorstCaseCalls(releaseLabels)),
    });
    if (released.status === "guard-lost") {
      await writeFailureAudit(
        client,
        input,
        liveLabels,
        "Capacity handoff skipped the remote claim release: the mutation guard was taken by an operator override before the remote write",
      );
      return {
        ok: false,
        httpStatus: 500,
        code: "release_failed",
        message:
          "Claim label release skipped; the mutation guard was taken by an operator override before the remote write — lease and release guard retained",
      };
    }
    labels = released.value.labels;
    status = released.value.status;
    statusNote = released.value.statusNote;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await writeFailureAudit(client, input, liveLabels, `Claim label release failed; lease retained: ${message}`);
    return {
      ok: false,
      httpStatus: 500,
      code: "release_failed",
      message: `Claim label release failed; lease and release guard retained: ${message}`,
    };
  }

  // ── 5b. Durable settlement record BEFORE the lease CAS (#1262) ────────────
  // The proof must exist before the release becomes externally observable via
  // lease removal: a crash after the CAS but before a late record write would
  // re-open the unprovable-success gap. A crash before the CAS leaves the
  // lease intact for the exact-token retry, and the first-write-wins upsert
  // makes the re-record a no-op. The cooldown deadline is pinned here so the
  // CapacityHandoff row and the settlement record carry the same value.
  const cooldownUntil = new Date(now.getTime() + capacityCooldownMs(now.getTime()));
  if (input.settlementKey) {
    try {
      const recorded = await recordIssueHandoffSettlement(client, {
        agentName,
        issueId,
        claimToken,
        settlementKey: input.settlementKey,
        capacity,
        labels,
        status,
        statusNote,
        cooldownUntil,
        settledAt: now,
      });
      // First-write-wins means a lost race against a concurrent foreign-token
      // record returns that foreign row instead of ours (a null result would
      // prove nothing either). The lease CAS must not proceed on a proof we
      // do not own: refuse before consuming the lease so the key fence can
      // never silently pass (stale-recovery owns reconciling the retained
      // lease from here).
      if (!recorded || recorded.claimToken !== claimToken) {
        await writeFailureAudit(
          client,
          input,
          liveLabels,
          "Settlement key was concurrently recorded under a different claim token; lease retained, no replay proof for this release",
        );
        return {
          ok: false,
          httpStatus: 409,
          code: "settlement_key_conflict",
          message:
            "settlementKey was concurrently recorded under a different claim token before the lease was consumed; no replay proof exists for this release and the lease is retained (stale-claim recovery owns reconciling it; do not reuse this settlement key)",
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await writeFailureAudit(client, input, liveLabels, `Settlement record write failed; lease retained: ${message}`);
      return {
        ok: false,
        httpStatus: 500,
        code: "release_failed",
        message: `Could not persist the settlement record; lease and release guard retained: ${message}`,
      };
    }
  }

  // Consume the exact lease only after GitHub cleanup succeeded.
  const { count } = await client.lease.deleteMany({
    where: { id: lease.id, agentName, issueId, claimToken },
  });
  if (count !== 1) {
    // The release did not complete: retract our record so it can never replay
    // a success for a lease this attempt failed to consume. Best-effort and
    // pinned to our own claim token — a concurrent exact-key record survives.
    if (input.settlementKey) {
      try {
        await client.issueHandoffSettlement.deleteMany({
          where: { agentName, issueId, settlementKey: input.settlementKey, claimToken },
        });
      } catch (error) {
        // A leftover record can only replay while the lease is absent; log the
        // retraction failure so operators can reconcile the stray proof.
        console.error(`capacity handoff: settlement retraction failed for ${repoFullName}#${issueNumber}:`, error);
      }
    }
    return { ok: false, httpStatus: 409, code: "handoff_race_lost", message: "Claim changed concurrently; no lease was released" };
  }

  // ── 6. Retire active AgentWork rows with history (audit trail) ───────────
  try {
    const activeWork = await client.agentWork.findMany({
      where: { agentName, issueId, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
      select: { id: true },
    });
    for (const work of activeWork) {
      await client.agentWork.update({
        where: { id: work.id },
        data: { state: "RELEASED", leaseExpiresAt: now },
      });
      await client.agentWorkHistory.create({
        data: {
          workId: work.id,
          action: "capacity_handoff",
          state: "RELEASED",
          summary: `Capacity exhausted (${capacity}); claim released by fenced handoff`,
        },
      });
    }
  } catch (error) {
    // AgentWork bookkeeping is visibility, not ownership: the claim is
    // already released. Log and continue — never fail the handoff over it.
    console.error(`capacity handoff: AgentWork release failed for ${repoFullName}#${issueNumber}:`, error);
  }

  // ── 7. Capacity-scoped cooldown + audit ──────────────────────────────────
  // The release itself already committed. A cooldown-write failure must not
  // turn a successful handoff into a 500 (the lease is gone; a retry would
  // read 409 and the worker would believe nothing happened). Degrade to "no
  // cooldown": worst case the exhausted capacity may be re-handed and report
  // exhaustion again — bounded, and strictly better than a false failure.
  // The settlement record (#1262) keeps the pinned deadline regardless: a
  // replay echoes the originally recorded result, and an unpersisted cooldown
  // is bounded dispatch shaping that expires on its own.
  let persistedCooldown: Date | null = null;
  try {
    persistedCooldown = (await recordCapacityHandoff(
      client,
      {
        kind: "issue",
        capacity,
        repoFullName,
        issueNumber,
        agentName,
        issueId,
        note: input.note ?? null,
      },
      now,
      cooldownUntil,
    )).cooldownUntil;
  } catch (error) {
    console.error(`capacity handoff: cooldown write failed for ${repoFullName}#${issueNumber}; releasing without cooldown:`, error);
  }

  try {
    await client.auditLog.create({
      data: {
        actor: input.actor,
        action: "issue_capacity_handoff",
        repoFullName,
        issueNumber,
        issueId,
        beforeLabels: liveLabels,
        afterLabels: labels,
        success: true,
        notes:
          `capacity=${capacity}; cooldownUntil=${persistedCooldown ? persistedCooldown.toISOString() : "none (cooldown write failed)"}; ` +
          `lease ${lease.id} released by claim-token fence${
            input.settlementKey ? `; settlementKey=${input.settlementKey}` : ""
          }${
            ownershipChangedPostCas
              ? "; ownership changed before cleanup: ownership-only release of our label"
              : ""
          }${input.note ? `; ${input.note}` : ""}`,
      },
    });
  } catch {
    // Audit failure is best-effort; the release already happened.
  }

  return { ok: true, labels, status, statusNote, cooldownUntil: persistedCooldown, replayed: false };
}

/**
 * Live-label refusals applied both before the lease CAS. Status checks read
 * the LIVE set (not the cache): a `status/blocked` that exists on GitHub but
 * has not reached the cache is still a hold the handoff must not reverse, so
 * any live blocked label is refused fail-closed — the stale-recovery/operator
 * paths own releasing one.
 */
type HandoffRefusal = Extract<IssueCapacityHandoffResult, { ok: false }>;

function classifyLiveLabels(
  liveLabels: string[],
  agentLabel: string,
  allowMissingOwner = false,
): HandoffRefusal | null {
  if (liveLabels.includes("status/done")) {
    return { ok: false, httpStatus: 409, code: "issue_done", message: "Issue is done on GitHub; nothing to hand off" };
  }
  if (liveLabels.includes("status/blocked")) {
    return {
      ok: false,
      httpStatus: 409,
      code: "human_hold",
      message: "Issue carries status/blocked on GitHub; a capacity handoff never reverses a block — release the block explicitly first",
    };
  }
  const liveAgent = getAgentFromLabels(liveLabels);
  if (liveAgent && liveAgent !== agentLabel) {
    return {
      ok: false,
      httpStatus: 409,
      code: "ownership_changed",
      message: `Issue claim on GitHub belongs to ${liveAgent}; refusing to release another owner's claim`,
    };
  }
  if (!liveAgent && !allowMissingOwner) {
    return {
      ok: false,
      httpStatus: 409,
      code: "ownership_changed",
      message: "No agent claim is present on GitHub; this handoff's claim is already released or was changed by a human",
    };
  }
  return null;
}

async function writeFailureAudit(
  client: IssueCapacityHandoffClient,
  input: IssueCapacityHandoffInput,
  beforeLabels: string[],
  errorMessage: string,
): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        actor: input.actor,
        action: "issue_capacity_handoff",
        repoFullName: input.repoFullName,
        issueNumber: input.issueNumber,
        issueId: input.issueId,
        beforeLabels,
        afterLabels: [],
        success: false,
        errorMessage,
      },
    });
  } catch {
    // Audit failure must not mask the refusal.
  }
}
