import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isAuthorizedAgentToken } from "@/lib/dispatch-env";

/**
 * Resolve the actor name for decomposition attribution.
 *
 * Resolution order: actor > agentName > "agent" (default).
 * Validates that the resolved value is a non-empty trimmed string <= 100 chars.
 */
function resolveActor(body: unknown): { actor: string; error?: string } {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!raw) return { actor: "agent" };

  // Prefer `actor`, fall back to `agentName`, then default to "agent"
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

/**
 * Mark an issue as decomposed (escalated-lane audit parent tracking).
 *
 * This allows broad audit/umbrella issues to be marked as decomposed or
 * no longer actionable without closing child work. Follow-up issue URLs
 * can be linked to the parent issue so the queue endpoint can exclude them.
 *
 * No hardcoded agent names or repo names — applies uniformly.
 */
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!isAuthorizedAgentToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { repo, issueNumber, decomposed, followUpUrls, note } = body;

    if (!repo || !issueNumber) {
      return NextResponse.json({ error: "Missing required fields: repo, issueNumber" }, { status: 400 });
    }

    if (typeof decomposed !== "boolean") {
      return NextResponse.json({ error: "Field 'decomposed' must be a boolean" }, { status: 400 });
    }

    // Resolve attribution actor
    const { actor, error: actorError } = resolveActor(body);
    if (actorError) {
      return NextResponse.json({ error: actorError }, { status: 400 });
    }

    // Parse repo as owner/repo format
    const parts = repo.split("/");
    if (parts.length !== 2) {
      return NextResponse.json({ error: "Invalid repo format. Expected 'owner/repo'" }, { status: 400 });
    }
    const [owner, name] = parts;

    // Find the issue in the database
    const issue = await prisma.issue.findFirst({
      where: {
        number: issueNumber,
        repository: {
          owner,
          name,
        },
      },
    });

    if (!issue) {
      return NextResponse.json({ error: `Issue #${issueNumber} not found in ${repo}` }, { status: 404 });
    }

    // Update decomposed state
    const updated = await prisma.issue.update({
      where: { id: issue.id },
      data: {
        decomposed,
        decomposedAt: decomposed ? new Date() : null,
        decomposedBy: decomposed ? actor : null,
        decomposedNote: note ?? null,
        followUpUrls: followUpUrls ?? [],
      },
    });

    // Log the action in audit trail
    await prisma.auditLog.create({
      data: {
        actor,
        action: decomposed ? "issue_decomposed" : "issue_reactivated",
        repoFullName: `${owner}/${name}`,
        issueNumber,
        issueId: issue.id,
        beforeLabels: [...issue.labels],
        afterLabels: [...issue.labels],
        success: true,
        notes: decomposed
          ? `Issue marked as decomposed. Note: ${note ?? "none"}. Follow-up URLs: ${(followUpUrls ?? []).join(", ")}`
          : `Issue reactivated (decomposed set to false)`,
      },
    });

    return NextResponse.json({
      success: true,
      issueId: updated.id,
      decomposed: updated.decomposed,
      decomposedAt: updated.decomposedAt,
      followUpUrls: updated.followUpUrls,
    }, { status: 200 });
  } catch (error) {
    console.error("Failed to update decomposed state:", error);
    return NextResponse.json({ error: "Failed to update decomposed state" }, { status: 500 });
  }
}
