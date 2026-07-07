import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workflowId = searchParams.get("id");

  if (!workflowId) {
    return errorResponse("Workflow ID required", 400);
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
      return errorResponse("Workflow not found", 404);
    }

    return NextResponse.json(jsonSafe(workflow));
  } catch (error) {
    return handleApiError("fetch workflow", error);
  }
}