import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { authorizeGroomerRequest } from "@/lib/auth";
import { runHostedGroomer } from "@/lib/groomer/run";
import { getHostedGroomerConfig } from "@/lib/groomer/config";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  if (!(await authorizeGroomerRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
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
    return errorResponse("Hosted groomer is disabled. Set DISPATCH_HOSTED_GROOMER_ENABLED=true to enable.", 503);
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
      return errorResponse(`Issue #${issueNumber} not found`, 404);
    }
    if (issue.state === "closed") {
      return errorResponse("Cannot groom a closed issue", 400);
    }
    if (issue.labels.includes("status/done")) {
      return errorResponse("Cannot groom an issue with status/done label", 400);
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
    return errorResponse("Hosted groomer run failed", 500);
  }
}
