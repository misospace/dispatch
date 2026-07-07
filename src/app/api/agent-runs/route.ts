import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { isValidEscalatedOutcome, VALID_ESCALATED_OUTCOMES } from "@/types";
import { authorizeRequest } from "@/lib/auth";

export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50");

  try {
    const runs = await prisma.agentRun.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return NextResponse.json(runs);
  } catch (error) {
    return handleApiError("fetch agent runs", error);
  }
}

export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    const body = await request.json();
    const {
      agentName,
      runType,
      status,
      startedAt,
      finishedAt,
      summary,
      errorMessage,
      touchedIssueUrls,
      issueId,
      outcome,
    } = body;

    if (!agentName || !runType || !status || !startedAt) {
      return errorResponse("Missing required fields", 400);
    }

    // Validate escalated-lane outcome if provided
    if (outcome !== undefined && outcome !== null) {
      if (!isValidEscalatedOutcome(outcome)) {
        return errorResponse(`Invalid outcome: "${outcome}". Valid values: ${VALID_ESCALATED_OUTCOMES.join(", ")}`, 400);
      }
    }

    const run = await prisma.agentRun.create({
      data: {
        agentName,
        runType,
        status,
        startedAt: new Date(startedAt),
        finishedAt: finishedAt ? new Date(finishedAt) : null,
        summary,
        errorMessage,
        touchedIssueUrls: touchedIssueUrls || [],
        issueId,
        outcome: outcome ?? undefined,
      },
    });

    return NextResponse.json(run, { status: 201 });
  } catch (error) {
    return handleApiError("create agent run", error);
  }
}
