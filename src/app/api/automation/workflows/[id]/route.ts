import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workflowId = searchParams.get("id");

  if (!workflowId) {
    return NextResponse.json({ error: "Workflow ID required" }, { status: 400 });
  }

  try {
    const workflow = await prisma.githubWorkflow.findUnique({
      where: { id: workflowId },
      include: {
        repo: true,
        runs: {
          take: 20,
          orderBy: { runStartedAt: "desc" },
          include: {
            jobs: true,
          },
        },
      },
    });

    if (!workflow) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    return NextResponse.json(workflow);
  } catch (error) {
    console.error("Failed to fetch workflow:", error);
    return NextResponse.json({ error: "Failed to fetch workflow" }, { status: 500 });
  }
}