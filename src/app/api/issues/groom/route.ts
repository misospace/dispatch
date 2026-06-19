import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { removeIssueLabel, addIssueLabel } from "@/lib/github";
import { authorizeRequest } from "@/lib/auth";
import { getEscalationLane } from "@/lib/lane-config";

/**
 * Resolve the actor name for grooming attribution.
 *
 * Resolution order: actor > agentName > "agent" (default).
 */
function resolveActor(body: unknown): { actor: string; error?: string } {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!raw) return { actor: "agent" };

  let value: unknown;
  if ("actor" in raw) value = raw.actor;
  else if ("agentName" in raw) value = raw.agentName;
  else return { actor: "agent" };

  if (typeof value !== "string") {
    return { actor: "", error: "'actor'/'agentName' must be a string" };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { actor: "", error: "'actor'/'agentName' must not be empty after trimming" };
  }
  if (trimmed.length > 100) {
    return { actor: "", error: "'actor'/'agentName' must be at most 100 characters" };
  }

  return { actor: trimmed };
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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
      return NextResponse.json(
        { error: "Missing required fields: repoFullName, issueNumber, action" },
        { status: 400 },
      );
    }

    const validActions = ["promote_to_ready", "escalate", "mark_not_ready", "mark_needs_info", "mark_blocked"];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action: ${action}. Allowed: ${validActions.join(", ")}` },
        { status: 400 },
      );
    }

    const { actor: bodyActorName, error: actorError } = resolveActor(body);
    if (actorError) {
      return NextResponse.json({ error: actorError }, { status: 400 });
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
        return NextResponse.json(
          { error: "Issue not found in local cache" },
          { status: 404 },
        );
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
          // Remove status/backlog, add status/ready
          const existingStatus = issue.labels.find((l) => l.startsWith("status/"));
          if (existingStatus && existingStatus !== "status/ready") {
            await removeIssueLabel(effectiveRepo, effectiveNumber, existingStatus);
            afterLabels = afterLabels.filter((l) => !l.startsWith("status/"));
          }
          if (!issue.labels.includes("status/ready")) {
            await addIssueLabel(effectiveRepo, effectiveNumber, "status/ready");
            afterLabels.push("status/ready");
          }
          groomingData.nextGroomingAction = null;
          break;
        }

        case "escalate": {
          const escalationLane = getEscalationLane();
          groomingData.currentLane = escalationLane?.id ?? "escalated";
          groomingData.nextGroomingAction = "Implement or decompose into actionable sub-tasks";
          break;
        }

        case "mark_not_ready": {
          if (!notReadyReason || typeof notReadyReason !== "string" || !notReadyReason.trim()) {
            return NextResponse.json(
              { error: "'notReadyReason' is required when action is 'mark_not_ready'" },
              { status: 400 },
            );
          }
          groomingData.notReadyReason = notReadyReason.trim();
          groomingData.nextGroomingAction = (issue.labels.find((l) => l.startsWith("status/")) === "status/backlog")
            ? "Revisit once the blocking condition is resolved"
            : "Reassess if the issue is now actionable";
          break;
        }

        case "mark_needs_info": {
          if (!needsInfoReason || typeof needsInfoReason !== "string" || !needsInfoReason.trim()) {
            return NextResponse.json(
              { error: "'needsInfoReason' is required when action is 'mark_needs_info'" },
              { status: 400 },
            );
          }
          groomingData.needsInfoReason = needsInfoReason.trim();
          groomingData.nextGroomingAction = "Request missing information from the issue author or assignee";
          break;
        }

        case "mark_blocked": {
          if (!blockedReason || typeof blockedReason !== "string" || !blockedReason.trim()) {
            return NextResponse.json(
              { error: "'blockedReason' is required when action is 'mark_blocked'" },
              { status: 400 },
            );
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

      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  } catch (error) {
    console.error("Groom issue failed:", error);
    return NextResponse.json({ error: "Failed to groom issue" }, { status: 500 });
  }
}
