import { NextResponse } from "next/server";
import { authorizeGroomerRequest } from "@/lib/auth";
import { runHostedGroomer } from "@/lib/groomer/run";
import { getHostedGroomerConfig } from "@/lib/groomer/config";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  if (!(await authorizeGroomerRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const config = getHostedGroomerConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Hosted groomer is disabled. Set DISPATCH_HOSTED_GROOMER_ENABLED=true to enable." },
      { status: 503 },
    );
  }

  // Guard: reject grooming of closed issues when issueNumber is explicitly provided.
  // This prevents the groomer from processing issues that are already closed on GitHub
  // but still appear open in Dispatch's cache (stale sync state).
  if (typeof body.issueNumber === "number" && Number.isInteger(body.issueNumber)) {
    const issueNumber = body.issueNumber;
    const repoFullName = typeof body.repoFullName === "string" ? body.repoFullName : undefined;

    let where: Record<string, unknown> = { number: issueNumber };
    if (repoFullName) {
      where.repository = { fullName: repoFullName };
    }

    const issue = await prisma.issue.findFirst({
      where,
      select: { state: true, labels: true },
    });

    if (!issue) {
      return NextResponse.json(
        { error: `Issue #${issueNumber} not found` },
        { status: 404 },
      );
    }
    if (issue.state === "closed") {
      return NextResponse.json(
        { error: "Cannot groom a closed issue" },
        { status: 400 },
      );
    }
    if (issue.labels.includes("status/done")) {
      return NextResponse.json(
        { error: "Cannot groom an issue with status/done label" },
        { status: 400 },
      );
    }
  }

  try {
    const result = await runHostedGroomer({
      dryRun: typeof body.dryRun === "boolean" ? body.dryRun : undefined,
      repoFullName: typeof body.repoFullName === "string" ? body.repoFullName : undefined,
      issueNumber: typeof body.issueNumber === "number" && Number.isInteger(body.issueNumber)
        ? body.issueNumber
        : undefined,
      force: typeof body.force === "boolean" ? body.force : undefined,
    });

    if (!result) {
      return NextResponse.json({ candidateNumber: null, dryRun: config.dryRun });
    }

    return NextResponse.json({
      candidateNumber: result.candidateNumber,
      repoFullName: result.repoFullName,
      dryRun: result.dryRun,
      output: result.output,
      plannedLabels: result.plannedLabels,
      groomingRunId: result.groomingRunId,
      contextWarnings: result.contextWarnings,
      mutationPlan: result.mutationPlan,
      appliedMutations: result.appliedMutations,
    });
  } catch (error) {
    console.error("Hosted groomer run failed:", error);
    return NextResponse.json(
      { error: "Hosted groomer run failed" },
      { status: 500 },
    );
  }
}
