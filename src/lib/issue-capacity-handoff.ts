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
import { releaseIssueClaim } from "./issue-claim";
import { recordCapacityHandoff, type CapacityHandoffClient } from "./capacity-handoff";
import { withIssueMutationGuard } from "./issue-mutation-guard";

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
}

export type IssueCapacityHandoffInput = {
  client: IssueCapacityHandoffClient;
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  agentName: string;
  claimToken: string;
  capacity: string;
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
  }, async (_tx, { resuming }) => {
    const value = await recoverIssueCapacityHandoffUnlocked(input, resuming);
    return { complete: !(value.ok === false && (value.code === "release_failed" || value.code === "github_unavailable")), value };
  });
  if (guarded.status === "busy") return {
    ok: false, httpStatus: 409, code: "handoff_race_lost",
    message: "Issue mutation is in progress; retry after recovery completes",
  };
  return guarded.value;
}

async function recoverIssueCapacityHandoffUnlocked(
  input: IssueCapacityHandoffInput,
  resuming: boolean,
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
  const lease = await client.lease.findUnique({
    where: { agentName_issueId: { agentName, issueId } },
  });
  if (!lease || !lease.claimToken) {
    return {
      ok: false,
      httpStatus: 409,
      code: "no_active_claim",
      message:
        "No active tokened claim exists for this agent+issue; this claim was already released, superseded, or predates claim tokens — re-claim to obtain a fresh fenced token (do not force an unclaim)",
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
    try {
      // Targeted, idempotent: only our own label. Never a status write —
      // the new owner's transition stands.
      await removeIssueLabel(repoFullName, issueNumber, agentLabel);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await writeFailureAudit(client, input, liveLabels, `Could not remove claim label: ${message}`);
      return { ok: false, httpStatus: 500, code: "release_failed", message: `Could not remove claim label; lease and release guard retained: ${message}` };
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
    const released = await releaseIssueClaim({
      prisma: client,
      issue: { ...issue, labels: releaseLabels },
      repoFullName,
      issueNumber,
      agentName,
    });
    labels = released.labels;
    status = released.status;
    statusNote = released.statusNote;
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

  // Consume the exact lease only after GitHub cleanup succeeded.
  const { count } = await client.lease.deleteMany({
    where: { id: lease.id, agentName, issueId, claimToken },
  });
  if (count !== 1) return { ok: false, httpStatus: 409, code: "handoff_race_lost", message: "Claim changed concurrently; no lease was released" };

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
  let cooldownUntil: Date | null = null;
  try {
    cooldownUntil = (await recordCapacityHandoff(
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
          `capacity=${capacity}; cooldownUntil=${cooldownUntil ? cooldownUntil.toISOString() : "none (cooldown write failed)"}; ` +
          `lease ${lease.id} released by claim-token fence${
            ownershipChangedPostCas
              ? "; ownership changed before cleanup: ownership-only release of our label"
              : ""
          }${input.note ? `; ${input.note}` : ""}`,
      },
    });
  } catch {
    // Audit failure is best-effort; the release already happened.
  }

  return { ok: true, labels, status, statusNote, cooldownUntil };
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
