import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildLabelWhere, toProjectLabel } from "@/lib/issue-filters";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get("repo");
  const agent = searchParams.get("agent");
  const owner = searchParams.get("owner");
  const project = searchParams.get("project");
  const priority = searchParams.get("priority");
  const lane = searchParams.get("lane");

  try {
    const where: Record<string, unknown> = { repository: { enabled: true } };

    if (repo) {
      where.repository = { ...(where.repository as object), fullName: repo };
    }

    const labels = buildLabelWhere([agent, owner, toProjectLabel(project), priority]);
    if (labels) where.labels = labels;

    // Lane filter support
    if (lane && ["NORMAL", "GPT", "BACKLOG"].includes(lane)) {
      where.lane = lane;
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
