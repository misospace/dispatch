import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { STATUS_LABELS } from "@/types";
import { isRenovateIssue } from "@/lib/agent-queue";

/**
 * GET /api/issues/untriaged
 *
 * Returns open issues with no `status/*` label — an intake view for grooming.
 * These issues are excluded from normal worker queues but need to be surfaced
 * so they can be classified into status/backlog, status/ready, or closed.
 *
 * Query parameters:
 *   limit     — max results (default 50, bounded per run)
 *   repo      — filter by repository fullName
 *   excludeRenovate  — skip Renovate/dashboard noise (default true)
 */

interface UntriagedIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  state: string;
  createdAt: Date;
  updatedAt: Date;
  repository: { fullName: string };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      parseInt(searchParams.get("limit") ?? "50", 10),
      200, // hard cap to prevent runaway queries
    );
    const repoFilter = searchParams.get("repo");
    const excludeRenovate = searchParams.get("excludeRenovate") !== "false";

    // Fetch all open issues from enabled repos
    let where: Record<string, unknown> = {
      state: "open",
      repository: { enabled: true },
    };

    if (repoFilter) {
      where.repository = { ...where.repository, fullName: repoFilter };
    }

    const issues: UntriagedIssue[] = await prisma.issue.findMany({
      where,
      select: {
        id: true,
        number: true,
        title: true,
        url: true,
        labels: true,
        state: true,
        createdAt: true,
        updatedAt: true,
        repository: { select: { fullName: true } },
      },
      orderBy: { updatedAt: "desc" },
    });

    // Filter to only issues with no status/* label (untriaged)
    const untriaged = issues.filter((issue) => {
      for (const label of issue.labels) {
        if (STATUS_LABELS.includes(label)) return false;
      }
      return true;
    });

    // Optionally exclude Renovate/dashboard noise
    let result = untriaged;
    if (excludeRenovate) {
      result = result.filter((issue) => !isRenovateIssue(issue));
    }

    // Bound results per run
    result = result.slice(0, limit);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch untriaged issues:", error);
    return NextResponse.json({ error: "Failed to fetch untriaged issues" }, { status: 500 });
  }
}
