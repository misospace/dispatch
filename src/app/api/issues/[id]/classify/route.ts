import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyIssue, validateLane, LANE_NORMAL } from "@/lib/issue-lane-classification";

/**
 * GET /api/issues/[id]/classify
 * Returns the current lane classification for an issue.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const issue = await prisma.issue.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        title: true,
        body: true,
        labels: true,
        lane: true,
        laneConfidence: true,
        laneReason: true,
        laneModel: true,
        laneJudgedAt: true,
        laneHistory: {
          orderBy: { judgedAt: "desc" },
          take: 10,
          select: {
            lane: true,
            confidence: true,
            reason: true,
            model: true,
            judgedAt: true,
          },
        },
      },
    });

    if (!issue) {
      return NextResponse.json({ error: "Issue not found" }, { status: 404 });
    }

    return NextResponse.json({
      lane: issue.lane,
      confidence: issue.laneConfidence,
      reason: issue.laneReason,
      model: issue.laneModel,
      judgedAt: issue.laneJudgedAt,
      history: issue.laneHistory,
    });
  } catch (error) {
    console.error("Failed to fetch lane classification:", error);
    return NextResponse.json({ error: "Failed to fetch lane classification" }, { status: 500 });
  }
}

/**
 * POST /api/issues/[id]/classify
 * Reclassify an issue. Optionally provides a custom classifier prompt override.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const forceLane = typeof body.forceLane === "string" ? validateLane(body.forceLane) : null;
    const modelSource = typeof body.modelSource === "string" && body.modelSource.trim().length > 0
      ? body.modelSource.trim()
      : "api";

    const issue = await prisma.issue.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        title: true,
        body: true,
        labels: true,
      },
    });

    if (!issue) {
      return NextResponse.json({ error: "Issue not found" }, { status: 404 });
    }

    // If forceLane is provided, use it directly (for manual overrides)
    let classification;
    if (forceLane) {
      classification = {
        lane: forceLane,
        confidence: 1.0,
        reason: `Manual override to ${forceLane}`,
        model: "manual",
      };
    } else {
      // Run the generic classifier
      classification = await classifyIssue(
        { title: issue.title, body: issue.body, labels: issue.labels },
        undefined, // Uses noopClassifier by default; inject via env or config in production
        modelSource,
      );
    }

    // Update the issue's current lane and record in history
    const updated = await prisma.issue.update({
      where: { id },
      data: {
        lane: classification.lane,
        laneConfidence: classification.confidence,
        laneReason: classification.reason,
        laneModel: classification.model,
        laneJudgedAt: new Date(),
        laneHistory: {
          create: {
            lane: classification.lane,
            confidence: classification.confidence,
            reason: classification.reason,
            model: classification.model,
          },
        },
      },
      select: {
        id: true,
        number: true,
        lane: true,
        laneConfidence: true,
        laneReason: true,
        laneModel: true,
        laneJudgedAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      issueId: updated.id,
      issueNumber: updated.number,
      lane: updated.lane,
      confidence: updated.laneConfidence,
      reason: updated.laneReason,
      model: updated.laneModel,
    });
  } catch (error) {
    console.error("Failed to classify issue:", error);
    return NextResponse.json({ error: "Failed to classify issue" }, { status: 500 });
  }
}
