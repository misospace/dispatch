import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { updateIssueLabels } from "@/lib/github";
import { analyzeAssignmentConflict, buildNewLabels } from "@/lib/assignment-conflicts";
import { getLiveIssueLabels } from "@/lib/claim-gate";
import { supersedeOwnershipReleaseIntent } from "@/lib/ownership-reconciliation";
import { withIssueMutationGuard } from "@/lib/issue-mutation-guard";
import { AGENT_PREFIX, OWNER_PREFIX } from "@/types";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";

// 30 requests / 10s: this route writes live GitHub labels, so bursts stay tight
// — the same ceiling the other agent-facing mutation routes use (status, claim).
const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

type ActionPayload = {
  issueId?: string;
  repoFullName?: string;
  issueNumber?: number;
  action: "assign_agent" | "assign_owner";
  value: string;
  force_claim?: boolean;
};

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`issues-actions:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  const auditActor = getAuthorizedActor(auth, request);

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

    const payload = body as ActionPayload;

    // Validate required fields
    if (!payload.action || payload.value == null) {
      return errorResponse("Missing required fields: action, value", 400);
    }

    if (payload.action !== "assign_agent" && payload.action !== "assign_owner") {
      return errorResponse(`Invalid action: ${payload.action}. Allowed: assign_agent, assign_owner`, 400);
    }

    if (typeof payload.value !== "string" || payload.value.length === 0) {
      return errorResponse("value must be a non-empty string", 400);
    }

    const { issueId, repoFullName, issueNumber } = payload;

    if (!issueId || !repoFullName || typeof issueNumber !== "number") {
      return errorResponse("Missing required fields: issueId, repoFullName, issueNumber", 400);
    }

    // Validate value format: must match agent/<name> or owner/<name>
    const expectedPrefix = payload.action === "assign_agent" ? AGENT_PREFIX : OWNER_PREFIX;
    if (!payload.value.startsWith(expectedPrefix)) {
      return errorResponse(`value must start with "${expectedPrefix}" (e.g. "${expectedPrefix}worker")`, 400);
    }

    try {
      // §8.7: the assign path is an intent-free writer, but when it coincides
      // with a pending reconciler release intent it must serialize on the
      // per-issue anchor rather than race the Phase-B delete — under the lock
      // a pending intent is superseded (assign_agent only; assign_owner does
      // not touch agent labels and must not cancel a pending release), then
      // the explicit assignment's own idempotent label write converges the
      // state. Busy means another claim-path writer holds the issue: 409.
      const guarded = await withIssueMutationGuard({ issueId, operation: "assign" }, async (_tx, { runFencedRemoteWrite }): Promise<{ complete: boolean; value: Response }> => {
      // Fetch current issue to get existing labels and state
      const issue = await prisma.issue.findUnique({ where: { id: issueId } });
      if (!issue) {
        return { complete: true, value: errorResponse(`Issue not found: ${issueId}`, 404) };
      }

      // Policy §1: agents may only claim open issues
      if (issue.state !== "open") {
        return { complete: true, value: errorResponse(`Cannot assign to closed issue (state: ${issue.state})`, 400) };
      }

      // #1037: the assignment decision must be made against the labels
      // GitHub currently has, not the Prisma cache — an assignment made
      // directly on GitHub is invisible in the cache until the next sync.
      // Fail closed if GitHub is unreachable: no label writes, no cache update.
      let liveLabels: string[];
      try {
        liveLabels = await getLiveIssueLabels(repoFullName, issueNumber);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        // Failed audit entry, consistent with the failure-audit style below
        try {
          await prisma.auditLog.create({
            data: {
              actor: auditActor,
              action: payload.action,
              repoFullName,
              issueNumber,
              issueId,
              beforeLabels: issue.labels,
              afterLabels: [],
              success: false,
              errorMessage: `Could not verify live GitHub labels: ${errorMessage}`,
            },
          });
        } catch {
          // Audit log failure should not mask the real error
        }

        return { complete: true, value: errorResponse(`Could not verify live GitHub labels: ${errorMessage}`, 503) };
      }

      const currentLabels = liveLabels;

      // §8.7 exemption: a direct operator/pipeline agent assignment supersedes
      // a pending reconciler release intent (audited) rather than racing its
      // Phase-B delete — the explicit human/pipeline choice converges the
      // label state, the abandoned reconciler's intent does not. assign_owner
      // does not touch agent labels and must not cancel a pending release.
      if (payload.action === "assign_agent") {
        await supersedeOwnershipReleaseIntent({
          issueId,
          actor: auditActor,
          reason: "direct assign_agent assignment",
        });
      }

      // Analyze conflicts using the shared conflict resolution module
      const analysis = analyzeAssignmentConflict(currentLabels);

      // Build new label set using the shared module
      const newLabels = buildNewLabels(currentLabels, payload.action, payload.value);

      // #1254: the guard-loss path records a failure audit — the skipped
      // assignment must be visible, not silent — and answers with the route's
      // busy/conflict shape. Best-effort: a failing audit write must not mask
      // the 409.
      const guardLost = async (): Promise<{ complete: boolean; value: Response }> => {
        try {
          await prisma.auditLog.create({
            data: {
              actor: auditActor,
              action: payload.action,
              repoFullName,
              issueNumber,
              issueId,
              beforeLabels: currentLabels,
              afterLabels: [],
              success: false,
              errorMessage: "Assignment was superseded by an operator override before the remote label write",
            },
          });
        } catch {
          // Audit log failure should not mask the real error
        }
        return { complete: true, value: errorResponse("Assignment was superseded by an operator override", 409) };
      };

      // #1254: the remote label write runs inside the FENCED write for EVERY
      // action, not only `assign_agent`. `updateIssueLabels` is a FULL-label-
      // set PUT (it replaces ALL labels), so the set it writes is a snapshot
      // taken before the write: a stale snapshot strips every label another
      // writer added in the meantime — including the `agent/*` label a
      // maintainer force-claim owns. The fence makes the guard check and the
      // write ONE step (the guard row's lock is held across the write), so
      // when the guard is already gone or re-owned the forge function is
      // NEVER called and the route answers with its busy/conflict shape.
      // (This says nothing about GitHub's own lack of a label CAS: the fence
      // closes the "the guard was stolen under me" hole, not the "another
      // writer changed the labels concurrently" one.)
      const written = await runFencedRemoteWrite(async () => {
        // Update GitHub labels atomically via updateIssueLabels (replaces all)
        await updateIssueLabels(repoFullName, issueNumber, newLabels);
        return true;
      });
      if (written.status === "guard-lost") {
        return await guardLost();
      }

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId },
        data: { labels: newLabels, lastSyncedAt: new Date() },
      });

      // Build audit log notes with conflict analysis and force_claim acknowledgment
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
      // Acknowledge force_claim flag in audit trail (policy §4)
      if (payload.force_claim === true) {
        auditNotesParts.push("force_claim=true (accepted per policy §4, no additional blocking applied)");
      }

      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: payload.action,
          repoFullName,
          issueNumber,
          issueId,
          beforeLabels: currentLabels,
          afterLabels: newLabels,
          success: true,
          notes: auditNotesParts.length > 0 ? auditNotesParts.join(" | ") : undefined,
        },
      });

      return { complete: true, value: NextResponse.json({ success: true, labels: newLabels }) };
      });

      if (guarded.status === "busy") {
        return errorResponse("Issue mutation is in progress; retry shortly", 409);
      }
      return guarded.value;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Write audit log even on failure
      try {
        const issue = await prisma.issue.findUnique({ where: { id: issueId } });
        const beforeLabels = issue?.labels ?? [];

        await prisma.auditLog.create({
          data: {
            actor: auditActor,
            action: payload.action,
            repoFullName: repoFullName!,
            issueNumber: issueNumber!,
            issueId,
            beforeLabels,
            afterLabels: [],
            success: false,
            errorMessage,
          },
        });
      } catch {
        // Audit log failure should not mask the real error
      }

      return errorResponse(errorMessage, 500);
    }
  } catch (error) {
    console.error("Assign agent/owner action failed:", error);
    return errorResponse("Failed to process action", 500);
  }
}
