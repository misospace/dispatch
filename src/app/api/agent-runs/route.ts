import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidEscalatedOutcome, VALID_ESCALATED_OUTCOMES } from "@/types";
import { authorizeRequest } from "@/lib/auth";

export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    console.error("Failed to fetch agent runs:", error);
    return NextResponse.json({ error: "Failed to fetch agent runs" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Validate escalated-lane outcome if provided
    if (outcome !== undefined && outcome !== null) {
      if (!isValidEscalatedOutcome(outcome)) {
        return NextResponse.json(
          { error: `Invalid outcome: "${outcome}". Valid values: ${VALID_ESCALATED_OUTCOMES.join(", ")}` },
          { status: 400 },
        );
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
    console.error("Failed to create agent run:", error);
    return NextResponse.json({ error: "Failed to create agent run" }, { status: 500 });
  }
}
