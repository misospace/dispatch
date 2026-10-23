import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { addIssueLabel, removeIssueLabel } from "@/lib/github";
import { analyzeAssignmentConflict, buildNewLabels } from "@/lib/assignment-conflicts";
import { getLiveIssueLabels } from "@/lib/claim-gate";
import { AGENT_PREFIX } from "@/types";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { upsertLease, findActiveLeasesForIssue, releaseExpiredLeases } from "@/lib/lease";
import { findAndReleaseStaleAgentWorkForIssue } from "@/lib/agent-work";
import { transitionIssueStatus } from "@/lib/issue-status";
import { recordClaimEvent } from "@/lib/issue-lifecycle";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withIssueMutationGuard } from "@/lib/issue-mutation-guard";
import { supersedeOwnershipReleaseIntent } from "@/lib/ownership-reconciliation";

const IN_PROGRESS_STATUS = "status/in-progress";
const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`claim:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    if (typeof body !== "object" || body === null) {
      return errorResponse("Invalid JSON body", 400);
    }

    const { issueId, repoFullName: bodyRepoFullName, issueNumber: bodyIssueNumber, agentName, force } = body as Record<string, unknown>;

    // Validate required fields
    if (!issueId || !bodyRepoFullName || typeof bodyIssueNumber !== "number" || !agentName || typeof agentName !== "string") {
      return errorResponse("Missing required fields: issueId, repoFullName, issueNumber, agentName", 400);
    }

    // A bound worker credential may only claim for its own agent; an unbound
    // legacy worker token is refused here (#1129).
    const scopeError = await enforceWorkerAgentScope(auth, agentName);
    if (scopeError) return scopeError;

    // The audit actor is the immutable token-derived identity for a bound
    // worker; operators/maintainers keep the body-supplied agent name.
    const actor = getAuthorizedActor(auth, request, agentName);

    // Worker tokens may only claim normally: force-claiming over another
    // agent's lease/assignment requires a maintainer token (#1111).
    if (force === true && auth.type === "bearer" && auth.tier === "worker") {
      try {
        await prisma.auditLog.create({
          data: {
            actor,
            action: "claim_issue",
            repoFullName: bodyRepoFullName as string,
            issueNumber: bodyIssueNumber as number,
            issueId: issueId as string,
            beforeLabels: [],
            afterLabels: [],
            success: false,
            errorMessage: "Force claim requires a maintainer token",
          },
        });
      } catch {
        // Audit log failure should not mask the 403
      }
      return errorResponse("Force claim requires a maintainer token", 403);
    }

    // Maintainer force-claims may take over a guard left `executing` by a
    // crashed process — the deliberate operator decision the fail-closed
    // guard posture defers to (#1254). Automation never overrides.
    const guarded = await withIssueMutationGuard({ issueId: issueId as string, operation: "claim", agentName: agentName as string, override: force === true }, async (_tx, { resuming, stillHoldsGuard }) => {
    let remoteStarted = false;
    const value = await (async (): Promise<Response> => {
    // Fetch the issue from the local database to check its state and current labels
    const issue = await prisma.issue.findUnique({
      where: { id: issueId as string },
      include: { repository: true },
    });

    if (!issue) {
      return errorResponse("Issue not found in local cache", 404);
    }

    // Cross-issue identity invariant (#1129 review): derive the canonical
    // GitHub repo and issue number from the loaded DB record rather than
    // trusting the body. A bound worker passing `issueId` of A and
    // `repoFullName`/`issueNumber` of B (or any other cross-reference) must
    // not be able to mutate B on GitHub while claiming A locally — the
    // subsequent GitHub label writes and the audit row both flow through
    // the canonical values. Reject any mismatch before any write so a
    // happy-path worker cannot be steered onto a foreign issue.
    const repoFullName = issue.repository.fullName;
    const issueNumber = issue.number;
    if (
      bodyRepoFullName !== repoFullName ||
      bodyIssueNumber !== issueNumber
    ) {
      return errorResponse(
        `issueId does not match repoFullName/issueNumber; expected ${repoFullName}#${issueNumber}`,
        400,
      );
    }

    // Refuse closed issues (cached state is fine for this check)
    if (issue.state === "closed") {
      return errorResponse("Cannot claim a closed issue", 400);
    }

    // §8.7 Claim side: a pending reconciler release intent holds ANY claim on
    // this issue with a retryable 409 until the Phase C settle lifts the
    // barrier — a claim that slips in behind an in-flight release could have
    // its fresh label deleted by the release's Phase B. The maintainer
    // force-claim is the one deliberate exemption: under the anchor it
    // supersedes the intent (audited) rather than racing it, and its own
    // idempotent label writes converge the state (docs/ownership-reconciliation.md).
    const pendingReleaseIntent = await prisma.ownershipReleaseIntent.findFirst({
      where: { issueId: issueId as string, phase: "pending" },
    });
    if (pendingReleaseIntent) {
      if (force === true) {
        await supersedeOwnershipReleaseIntent({
          issueId: issueId as string,
          actor,
          reason: "maintainer force-claim superseded the pending reconciler release intent",
        });
      } else {
        return errorResponse(
          "Ownership release is pending on this issue; retry shortly",
          409,
        );
      }
    }

    // #1037: the claim decision must be made against the labels GitHub
    // currently has, not the Prisma cache — a claim made directly on GitHub
    // is invisible in the cache until the next sync. Fail closed if GitHub
    // is unreachable: no label writes, no cache update, no lease.
    let liveLabels: string[];
    try {
      liveLabels = await getLiveIssueLabels(repoFullName, issueNumber);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Failed audit entry, consistent with the failure-audit style below
      try {
        await prisma.auditLog.create({
          data: {
            actor,
            action: "claim_issue",
            repoFullName,
            issueNumber,
            issueId: issueId as string,
            beforeLabels: issue.labels,
            afterLabels: [],
            success: false,
            errorMessage: `Could not verify live GitHub labels: ${errorMessage}`,
          },
        });
      } catch {
        // Audit log failure should not mask the real error
      }

      return errorResponse(`Could not verify live GitHub labels: ${errorMessage}`, 503);
    }

    // Refuse human holds (live labels are authoritative), including on a retry
    // after GitHub succeeded but the local mirror failed.
    if (liveLabels.includes("status/blocked")) {
      return errorResponse("Cannot claim a blocked issue", 400);
    }
    if (liveLabels.includes("status/done")) {
      return errorResponse("Cannot claim a done issue", 400);
    }

    const alreadyOwned = liveLabels.includes(`${AGENT_PREFIX}${agentName}`);
    const hasOtherOwner = liveLabels.some((label) => label.startsWith(AGENT_PREFIX) && label !== `${AGENT_PREFIX}${agentName}`);
    if (resuming && (!alreadyOwned || hasOtherOwner)) {
      return errorResponse("Cannot resume claim because live issue ownership changed", 409);
    }

    // Check for active leases from OTHER agents — refuse unless force=true
    const activeLeases = await findActiveLeasesForIssue(issueId as string);
    const otherAgentLeases = activeLeases.filter((l) => l.agentName !== agentName);

    if (otherAgentLeases.length > 0 && force !== true) {
      return errorResponse(`Issue is actively leased to ${otherAgentLeases[0].agentName}. Use force=true to override.`, 409);
    }

    // Always clean up expired leases (stale recovery)
    const expiredCount = await releaseExpiredLeases(issueId as string);
    if (expiredCount > 0) {
      console.warn(`Released ${expiredCount} expired lease(s) for issue #${issueNumber}`);
    }

    // Clean up stale AgentWork records (no matching active Lease)
    const staleWorkCount = await findAndReleaseStaleAgentWorkForIssue(prisma, issueId as string, repoFullName);
    if (staleWorkCount > 0) {
      console.warn(`Released ${staleWorkCount} stale AgentWork record(s) for issue #${issueNumber}`);
    }

    // Analyze assignment conflicts using the shared conflict resolution module,
    // against the live GitHub labels (authoritative base — #1037).
    // Passing this agent's own label makes a re-claim idempotent: an issue still
    // carrying agent/<this agent> is ours to take, not a conflict to 409 on.
    const analysis = analyzeAssignmentConflict(liveLabels, `${AGENT_PREFIX}${agentName}`);

    // #1254: the shared supersede tripwire for the pre-write re-checks. When a
    // maintainer force-claim has taken this holder's guard away, the callback
    // must not commit remote ownership writes: it deletes the lease receipt it
    // MINTED, records a failure audit, then 409s. No GitHub label is written
    // — the override's own claim converges the state.
    // Mint-based rule: the row is deleted ONLY when THIS attempt minted the
    // receipt (`upsertLease` reports `mintedToken`). A plain renewal merely
    // echoed a live attempt's own token, so its row belongs to that attempt
    // and must survive. The `{id, claimToken, renewedAt}` CAS stays as a
    // second fence, but it alone was NOT sufficient: renewals deliberately
    // KEEP the claim token (#1256) and the losing attempt's own renewal
    // re-stamps `renewedAt` AFTER the winner's renewal, so the fence could
    // still match a live attempt's row and delete it.
    const superseded = async (receipt?: {
      lease?: { id: string; claimToken?: string | null; renewedAt?: Date | null };
      mintedToken?: boolean;
    }): Promise<Response> => {
      const leaseRow = receipt?.lease;
      const mintedToken = receipt?.mintedToken === true;
      if (leaseRow?.id && mintedToken) {
        try {
          await prisma.lease.deleteMany({
            where: { id: leaseRow.id, claimToken: leaseRow.claimToken ?? null, renewedAt: leaseRow.renewedAt ?? null },
          });
        } catch {
          // Best-effort: a failed cleanup must not mask the 409.
        }
      }
      try {
        await prisma.auditLog.create({
          data: {
            actor,
            action: "claim_issue",
            repoFullName,
            issueNumber,
            issueId: issueId as string,
            beforeLabels: liveLabels,
            afterLabels: [],
            success: false,
            errorMessage:
              leaseRow?.id && !mintedToken
                ? "Claim was superseded by an operator override before the remote label write; the lease receipt belongs to a live attempt and was left intact"
                : "Claim was superseded by an operator override before the remote label write",
          },
        });
      } catch {
        // A failing audit write must not mask the 409.
      }
      return errorResponse("Claim was superseded by an operator override before the remote label write", 409);
    };

    // Check for agent conflict — if another agent is assigned, require force-claim
    if (analysis.hasAgentConflict) {
      if (force === true) {
        // #1254: re-check the anchor before the remote removals. A maintainer
        // force-claim can take this holder's guard before the remote writes;
        // if so, do not start a remote mutation the holder no longer owns.
        if (!(await stillHoldsGuard())) {
          return superseded();
        }
        // Force claim: remove ALL stale agent labels first.
        // buildNewLabels below drops every conflicting agent label from the
        // cache, so GitHub must lose all of them too — leaving extras behind
        // is the same GitHub/cache divergence class #1037 fights.
        remoteStarted = true;
        for (const staleAgentLabel of analysis.existingAgents) {
          try {
            await removeIssueLabel(repoFullName, issueNumber, staleAgentLabel);
          } catch (e) {
            console.error(`Failed to remove stale agent label ${staleAgentLabel} during force claim:`, e);
            // Non-fatal: continue with force claim even if label removal fails
          }
        }
      } else {
        return errorResponse(`Issue is already assigned to ${analysis.existingAgents[0].replace("agent/", "")}. Use force=true to override.`, 409);
      }
    }

    // Build updated labels using the shared conflict resolution module,
    // from the live GitHub labels (authoritative base — #1037)
    const agentLabel = `agent/${agentName}`;
    const labelsWithAgent = buildNewLabels(liveLabels, "assign_agent", agentLabel);
    const updatedLabels = [...labelsWithAgent.filter((l) => !l.startsWith("status/")), IN_PROGRESS_STATUS];

    try {
      // §8.7 Claim side, step 2: commit the claim intent — the lease row
      // carrying the fresh attempt token — BEFORE the remote label add, in
      // this same anchor window. The previous ordering wrote the lease after
      // GitHub, which left no persisted claim intent a crash could replay.
      // The lease is now the claim-side intent; the retry path replays the
      // idempotent add below (crash-matrix "claim side" row).
      const lease = await upsertLease({
        agentName: agentName as string,
        issueId: issueId as string,
        checkpoint: "issue_claimed",
        mutationGuardHeld: true,
      });

      // #1254: re-check the anchor before the remote add. A maintainer
      // force-claim can delete this holder's guard between the claim-intent
      // (lease) commit and the label write; the override already retired our
      // receipt, so committing the add here would race it. Back off: delete
      // the lease we minted ourselves and 409 — the add is idempotent, so the
      // override's own claim lands the label. A receipt we did NOT mint (a
      // plain renewal of a live attempt's row) is left intact.
      if (!(await stillHoldsGuard())) {
        return superseded(lease);
      }

      remoteStarted = true;
      // The add is idempotent: a fresh claim lands it once; a resumed claim
      // replays it, repairing a crash that died between the lease (intent)
      // commit and the remote add without creating a second owner.
      await addIssueLabel(repoFullName, issueNumber, agentLabel);

      // Remove ALL existing status labels (not just the first) before adding
      // status/in-progress — keeps GitHub and the Prisma cache from
      // diverging when an issue carries more than one status label.
      // Base is the live GitHub label set (authoritative — #1037).
      if (!resuming || !liveLabels.includes(IN_PROGRESS_STATUS)) {
        await transitionIssueStatus(repoFullName, issueNumber, liveLabels, IN_PROGRESS_STATUS);
      }

      // Update local cache and record the lifecycle event in one transaction:
      // a claim whose event failed to commit would leave the stream missing an
      // attempt, and an event without the claim would describe work that never
      // landed (#1202). A redelivered claim of an already-claimed issue is a
      // no-op for both — the transition guard inside recordClaimEvent sees an
      // unchanged status and an unchanged agent label.
      await prisma.$transaction(async (tx) => {
        await tx.issue.update({
          where: { id: issueId as string },
          data: { labels: updatedLabels, lastSyncedAt: new Date() },
        });

        await recordClaimEvent(tx, {
          issueId: issueId as string,
          repoFullName,
          issueNumber,
          kind: "claim",
          source: "api:claim",
          actor: agentName as string,
          agentName: agentName as string,
          before: liveLabels,
          after: updatedLabels,
          // The GitHub writes above are already outside this transaction, so a
          // failure here rolls the mirror back while GitHub keeps the claim —
          // and the retry reads those live labels as "already claimed". The
          // cache row is written inside the transaction, so on the retry it
          // still holds the pre-claim set and can supply the before-state this
          // attempt is missing. Decision logic stays on liveLabels above.
          mirroredBefore: issue.labels,
          metadata: force === true ? { force: true } : null,
        });
      });

      // Create or renew a lease for this agent (issue #166) — done above, as
      // the §8.7 claim intent committed before the remote add.
      // #1256: the lease carries the opaque claim token that fences a later
      // capacity-handoff release to THIS exact claim; echo it to the worker.

      // Write audit log with conflict analysis details
      const auditNotesParts: string[] = [];
      if (analysis.hasAgentConflict || analysis.hasOwnerConflict) {
        auditNotesParts.push(
          `conflict: agent=${analysis.hasAgentConflict}, owner=${analysis.hasOwnerConflict}`,
        );
        if (analysis.existingAgents.length > 0) {
          auditNotesParts.push(`existingAgents=[${analysis.existingAgents.join(", ")}]`);
        }
        if (analysis.existingOwners.length > 0) {
          auditNotesParts.push(`existingOwners=[${analysis.existingOwners.join(", ")}]`);
        }
      }
      if (force === true && analysis.hasAgentConflict) {
        auditNotesParts.push("force_claim=true");
      }

      await prisma.auditLog.create({
        data: {
          actor: agentName as string,
          action: "claim_issue",
          repoFullName,
          issueNumber,
          issueId: issueId as string,
          beforeLabels: liveLabels,
          afterLabels: updatedLabels,
          success: true,
          notes: auditNotesParts.length > 0 ? auditNotesParts.join(" | ") : undefined,
        },
      });

      return NextResponse.json({
        success: true,
        labels: updatedLabels,
        claimToken: lease.lease.claimToken ?? null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Write failure audit log
      await prisma.auditLog.create({
        data: {
          actor: agentName as string,
          action: "claim_issue",
          repoFullName,
          issueNumber,
          issueId: issueId as string,
          beforeLabels: liveLabels,
          afterLabels: [],
          success: false,
          errorMessage,
        },
      });

      return errorResponse(errorMessage, 500);
    }
    })();
    return { complete: !remoteStarted || value.status < 500, value };
    });
    if (guarded.status === "busy") return errorResponse("Issue mutation is in progress", 409);
    return guarded.value;
  } catch (error) {
    console.error("Claim issue failed:", error);
    return errorResponse("Failed to claim issue", 500);
  }
}
