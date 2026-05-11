import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get("repo");
  const agent = searchParams.get("agent");
  const owner = searchParams.get("owner");
  const project = searchParams.get("project");
  const priority = searchParams.get("priority");

  try {
    const where: Record<string, unknown> = { repository: { enabled: true } };

    if (repo) {
      where.repository = { ...(where.repository as object), fullName: repo };
    }

    if (agent) {
      where.labels = { has: agent };
    }

    if (owner) {
      where.labels = { has: owner };
    }

    if (project) {
      where.labels = { has: `project/${project}` };
    }

    if (priority) {
      where.labels = { has: priority };
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