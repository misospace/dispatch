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

const IN_PROGRESS_STATUS = "status/in-progress";
const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`claim:${auth.actor}`, RATE_LIMIT);
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

    const guarded = await withIssueMutationGuard({ issueId: issueId as string, operation: "claim", agentName: agentName as string }, async (_tx, { resuming }) => {
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

    // Check for agent conflict — if another agent is assigned, require force-claim
    if (analysis.hasAgentConflict) {
      if (force === true) {
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
      remoteStarted = true;
      // A resumed claim already landed remotely. Repair only the local mirror,
      // lifecycle event and lease; do not repeat GitHub label mutations.
      if (!resuming) await addIssueLabel(repoFullName, issueNumber, agentLabel);

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

      // Create or renew a lease for this agent (issue #166).
      // #1256: the lease carries the opaque claim token that fences a later
      // capacity-handoff release to THIS exact claim; echo it to the worker.
      const lease = await upsertLease({
        agentName: agentName as string,
        issueId: issueId as string,
        checkpoint: "issue_claimed",
        mutationGuardHeld: true,
      });

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
