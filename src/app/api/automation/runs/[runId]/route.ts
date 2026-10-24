import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { rerunWorkflow, triggerWorkflowDispatch } from "@/lib/github";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";

// 10 requests / 60s: reruns and dispatches are externally visible GitHub
// mutations that burn CI minutes, so a runaway caller is capped.
const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`automation-run-action:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  const auditActor = getAuthorizedActor(auth, request);

  const { searchParams } = new URL(request.url);
  const pathRunId = (await params).runId;
  const runId = pathRunId || searchParams.get("runId");
  const repoFullName = searchParams.get("repo");
  const action = searchParams.get("action");

  if (!runId || !repoFullName) {
    return errorResponse("runId and repo required", 400);
  }

  // runId is a BigInt column: a non-numeric value must 400 here, not NaN-reach
  // Prisma as a validation 500 (issue #1379).
  const runIdNumber = Number.parseInt(runId, 10);
  if (!Number.isSafeInteger(runIdNumber)) {
    return errorResponse("runId must be a number", 400);
  }

  const run = await prisma.githubWorkflowRun.findUnique({
    where: { runId: runIdNumber },
    include: { workflow: true },
  });

  if (!run) {
    return errorResponse("Run not found", 404);
  }

  try {
    let success = false;
    let errorMessage: string | null = null;

    if (action === "rerun") {
      await rerunWorkflow(repoFullName, runIdNumber);
      success = true;
    } else if (action === "dispatch") {
      const workflow = await prisma.githubWorkflow.findUnique({
        where: { id: run.workflowId },
      });
      if (!workflow) {
        return errorResponse("Workflow not found", 404);
      }
      await triggerWorkflowDispatch(repoFullName, Number(workflow.workflowId), run.branch);
      success = true;
    }

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: `workflow_${action}`,
        repoFullName,
        success,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return NextResponse.json({ success });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: `workflow_${action}`,
        repoFullName,
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return errorResponse(errorMessage, 500);
  }
}
