import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rerunWorkflow, triggerWorkflowDispatch } from "@/lib/github";

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");
  const repoFullName = searchParams.get("repo");
  const action = searchParams.get("action");

  if (!runId || !repoFullName) {
    return NextResponse.json({ error: "runId and repo required" }, { status: 400 });
  }

  const run = await prisma.githubWorkflowRun.findUnique({
    where: { runId: parseInt(runId) },
    include: { workflow: true },
  });

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
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
        return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
      }
      await triggerWorkflowDispatch(repoFullName, Number(workflow.workflowId), run.branch);
      success = true;
    }

    await prisma.auditLog.create({
      data: {
        actor: "user",
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
        actor: "user",
        action: `workflow_${action}`,
        repoFullName,
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}