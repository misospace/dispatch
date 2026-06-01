import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildLabelWhere, buildVisibleIssueWhere, toProjectLabel, buildExcludedLabelWhere } from "@/lib/issue-filters";
import { parseExcludedLabels } from "@/lib/config";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get("repo");
  const agent = searchParams.get("agent");
  const owner = searchParams.get("owner");
  const project = searchParams.get("project");
  const priority = searchParams.get("priority");
  const decomposed = searchParams.get("decomposed");
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
