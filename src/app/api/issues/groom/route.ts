import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { getEscalationLane, getDefaultClaimableLane, isClaimableLane } from "@/lib/lane-config";
import { resolveActor } from "@/lib/resolve-actor";
import { transitionIssueStatus } from "@/lib/issue-status";

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

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

    const {
      issueId,
      repoFullName,
      issueNumber,
      action,
      groomingSummary,
      notReadyReason,
      blockedReason,
      needsInfoReason,
      actor: bodyActor,
      agentName,
    } = body as Record<string, unknown>;

    if (!repoFullName || typeof issueNumber !== "number" || typeof action !== "string") {
      return errorResponse("Missing required fields: repoFullName, issueNumber, action", 400);
    }

    const validActions = ["promote_to_ready", "escalate", "mark_not_ready", "mark_needs_info", "mark_blocked"];
    if (!validActions.includes(action)) {
      return errorResponse(`Invalid action: ${action}. Allowed: ${validActions.join(", ")}`, 400);
    }

    const { actor: bodyActorName, error: actorError } = resolveActor(body);
    if (actorError) {
      return errorResponse(actorError, 400);
    }

    // Authenticated operator identity (basic/oidc) overrides body actor.
    // Bearer mode falls back to x-agent-name header, then body actor.
    // Disabled mode falls back to the body's actor.
    let auditActor: string;
    if (auth.type === "basic" || auth.type === "oidc") {
      auditActor = auth.actor;
    } else if (auth.type === "bearer") {
      const headerActor = request.headers.get("x-agent-name")?.trim();
      auditActor = (headerActor && headerActor.length > 0) ? headerActor : bodyActorName;
    } else {
      // disabled mode
      auditActor = bodyActorName;
    }

    try {
      // Look up the issue: try by DB id first, fall back to repoFullName + issueNumber
      let issue = null;

      if (issueId && typeof issueId === "string") {
        issue = await prisma.issue.findUnique({
          where: { id: issueId },
          include: { repository: true },
        });
      }

      if (!issue) {
        // Fallback: look up by repoFullName + issueNumber
        issue = await prisma.issue.findFirst({
          where: {
            number: issueNumber,
            repository: { fullName: repoFullName as string },
          },
          include: { repository: true },
        });
      }

      if (!issue) {
        return errorResponse("Issue not found in local cache", 404);
      }

      const effectiveRepo = (issue.repository?.fullName ?? repoFullName) as string;
      const effectiveNumber = issue.number;
      const effectiveIssueId = issue.id;
      const beforeLabels = [...issue.labels];
      let afterLabels = [...issue.labels];
      const groomedAt = new Date();

      // Build grooming data
      const groomingData: Record<string, unknown> = {
        groomedAt,
        groomedBy: auditActor,
        groomingSummary: (groomingSummary as string | undefined) ?? null,
      };

      // Clear reason fields that don't apply to this action
      if (action !== "mark_not_ready") {
        groomingData.notReadyReason = null;
      }
      if (action !== "mark_blocked") {
        groomingData.blockedReason = null;
      }
      if (action !== "mark_needs_info") {
        groomingData.needsInfoReason = null;
      }

      switch (action) {
        case "promote_to_ready": {
          // Remove ALL existing status labels (not just the first) and add
          // status/ready via the shared status-swap helper — keeps GitHub
          // and the Prisma cache from diverging when an issue carries more
          // than one status label.
          afterLabels = await transitionIssueStatus(effectiveRepo, effectiveNumber, issue.labels, "status/ready");
          groomingData.nextGroomingAction = null;

          // A ready issue must carry a claimable lane, otherwise every
          // lane-filtered agent queue (the bridge claims via ?lane=<id>)
          // excludes it and it can never be picked up. Preserve an existing
          // claimable lane (e.g. previously escalated to frontier); only
          // (re)assign the default claimable lane when the issue has no lane
          // or is stuck in the non-claimable backlog lane.
          if (!issue.currentLane || !isClaimableLane(issue.currentLane)) {
            groomingData.currentLane = getDefaultClaimableLane()?.id ?? "default";
          }
          break;
        }

        case "escalate": {
          const escalationLane = getEscalationLane();
          groomingData.currentLane = escalationLane?.id ?? "default";
          groomingData.nextGroomingAction = "Implement or decompose into actionable sub-tasks";
          break;
        }

        case "mark_not_ready": {
          if (!notReadyReason || typeof notReadyReason !== "string" || !notReadyReason.trim()) {
            return errorResponse("'notReadyReason' is required when action is 'mark_not_ready'", 400);
          }
          groomingData.notReadyReason = notReadyReason.trim();
          groomingData.nextGroomingAction = (issue.labels.find((l) => l.startsWith("status/")) === "status/backlog")
            ? "Revisit once the blocking condition is resolved"
            : "Reassess if the issue is now actionable";
          break;
        }

        case "mark_needs_info": {
          if (!needsInfoReason || typeof needsInfoReason !== "string" || !needsInfoReason.trim()) {
            return errorResponse("'needsInfoReason' is required when action is 'mark_needs_info'", 400);
          }
          groomingData.needsInfoReason = needsInfoReason.trim();
          groomingData.nextGroomingAction = "Request missing information from the issue author or assignee";
          break;
        }

        case "mark_blocked": {
          if (!blockedReason || typeof blockedReason !== "string" || !blockedReason.trim()) {
            return errorResponse("'blockedReason' is required when action is 'mark_blocked'", 400);
          }
          groomingData.blockedReason = blockedReason.trim();
          groomingData.nextGroomingAction = "Resolve the blocking dependency";
          break;
        }
      }

      // Update GitHub labels if status changed; always refresh lastSyncedAt
      if (action === "promote_to_ready") {
        await prisma.issue.update({
          where: { id: effectiveIssueId },
          data: { ...groomingData, labels: afterLabels, lastSyncedAt: new Date() },
        });
      } else {
        await prisma.issue.update({
          where: { id: effectiveIssueId },
          data: { ...groomingData, lastSyncedAt: new Date() },
        });
      }

      // Write audit log
      const actionLabels = {
        promote_to_ready: "issue_groomed_promote",
        escalate: "issue_groomed_escalate",
        mark_not_ready: "issue_groomed_not_ready",
        mark_needs_info: "issue_groomed_needs_info",
        mark_blocked: "issue_groomed_blocked",
      } as Record<string, string>;

      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: actionLabels[action],
          repoFullName: effectiveRepo,
          issueNumber: effectiveNumber,
          issueId: effectiveIssueId,
          beforeLabels,
          afterLabels: action === "promote_to_ready" ? afterLabels : beforeLabels,
          success: true,
          notes: groomingSummary as string | undefined ?? null,
        },
      });

      return NextResponse.json({
        success: true,
        action,
        labels: action === "promote_to_ready" ? afterLabels : undefined,
        groomedAt,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: `issue_groomed_${action}`,
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: (issueId as string) ?? null,
          beforeLabels: [],
          afterLabels: [],
          success: false,
          errorMessage,
        },
      });

      return errorResponse(errorMessage, 500);
    }
  } catch (error) {
    console.error("Groom issue failed:", error);
    return errorResponse("Failed to groom issue", 500);
  }
}
