import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { rerunWorkflow, triggerWorkflowDispatch } from "@/lib/github";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }
  const auditActor = getAuthorizedActor(auth, request);

  const { searchParams } = new URL(request.url);
  const pathRunId = (await params).runId;
  const runId = pathRunId || searchParams.get("runId");
  const repoFullName = searchParams.get("repo");
  const action = searchParams.get("action");

  if (!runId || !repoFullName) {
    return errorResponse("runId and repo required", 400);
  }

  const run = await prisma.githubWorkflowRun.findUnique({
    where: { runId: parseInt(runId) },
    include: { workflow: true },
  });

  if (!run) {
    return errorResponse("Run not found", 404);
  }

  try {
    let success = false;
    let errorMessage: string | null = null;

    if (action === "rerun") {
      await rerunWorkflow(repoFullName, parseInt(runId));
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
