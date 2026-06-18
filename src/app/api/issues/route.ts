import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildLabelWhere, buildVisibleIssueWhere, toProjectLabel, buildExcludedLabelWhere, buildNoStatusWhere } from "@/lib/issue-filters";
import { parseExcludedLabels } from "@/lib/config";
import { isValidLane, getLaneIds, resolveRequestLane, getLaneAliases } from "@/lib/lane-config";

export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const repo = searchParams.get("repo");
  const agent = searchParams.get("agent");
  const owner = searchParams.get("owner");
  const project = searchParams.get("project");
  const priority = searchParams.get("priority");
  const lane = searchParams.get("lane");
  const decomposed = searchParams.get("decomposed");
  const untriaged = searchParams.get("untriaged");
  const includeClosed = searchParams.get("includeClosed");

  try {
    const where: Record<string, unknown> = { repository: { enabled: true } };

    buildVisibleIssueWhere(where, { includeClosed: includeClosed === "true" });

    if (repo) {
      where.repository = { ...(where.repository as object), fullName: repo };
    }

    // Filter by decomposed status if requested (default: exclude decomposed)
    if (decomposed !== null) {
      const parsed = decomposed === "true";
      where.decomposed = parsed;
    }

    const labels = buildLabelWhere([agent, owner, toProjectLabel(project), priority]);
    if (labels) where.labels = labels;

    const excludedLabels = parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS);
    const excludedLabelFilter = buildExcludedLabelWhere(excludedLabels);
    if (excludedLabelFilter) {
      where.labels = { ...(where.labels as object), ...excludedLabelFilter };
    }

    // Filter for untriaged issues (no status/* label) — grooming intake
    const noStatusFilter = buildNoStatusWhere(untriaged === "true");
    if (noStatusFilter) where.labels = { ...(where.labels as object), ...noStatusFilter };

    // Filter by execution lane
    if (lane) {
      const resolved = resolveRequestLane(lane.toLowerCase());
      if (!resolved) {
        return NextResponse.json(
          { error: `Invalid lane: "${lane}". Must be one of: ${getLaneIds().join(", ")}` },
          { status: 400 },
        );
      }
      // Match both the configured lane and any aliases that resolve to it
      const aliases = getLaneAliases();
      const matchingLanes = new Set<string>();
      matchingLanes.add(resolved);
      for (const [from, to] of Object.entries(aliases)) {
        if (to === resolved) {
          matchingLanes.add(from.toLowerCase());
        }
      }
      where.currentLane = { in: Array.from(matchingLanes) };
    }

    const issues = await prisma.issue.findMany({
      where,
      include: { repository: true },
      orderBy: { updatedAt: "desc" },
    });

    return NextResponse.json(issues);
  } catch (error) {
    console.error("Failed to fetch issues:", error);
    return NextResponse.json({ error: "Failed to fetch issues" }, { status: 500 });
  }
}
