import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseLaneClassification, classifyByHeuristics, validateLaneRecord } from "@/lib/issue-lane";

interface LaneRequestBody {
  force?: boolean;
  model?: string;
  classification?: Record<string, unknown>;
}

/**
 * POST /api/issues/[issueId]/lane — Classify or reclassify an issue's execution lane.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ issueId: string }> }) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.MISSION_CONTROL_AGENT_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const { issueId } = params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Reject non-object types (including arrays and null)
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsedBody = body as LaneRequestBody;
    const { force, model } = parsedBody;

    // Fetch the issue from the local database
    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: { repository: true },
    });

    if (!issue) {
      return NextResponse.json({ error: "Issue not found in local cache" }, { status: 404 });
    }

    // Determine classification source
    const useForce = force === true;

    // If model classification is requested (via body.classification field), attempt it first
    if (typeof parsedBody.classification === "object" && parsedBody.classification !== null && !Array.isArray(parsedBody.classification)) {
      const validation = validateLaneRecord(parsedBody.classification);
      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }
      // Use the provided classification
      const laneData = validation.parsed!;
      laneData.model = typeof model === "string" ? model : laneData.model ?? "manual";

      await prisma.$transaction([
        prisma.issueLane.create({
          data: {
            issueId,
            ...laneData,
          },
        }),
        prisma.issue.update({
          where: { id: issueId },
          data: { currentLane: laneData.lane },
        }),
      ]);

      return NextResponse.json({
        success: true,
        lane: laneData.lane,
        confidence: laneData.confidence,
        reason: laneData.reason,
        model: laneData.model,
      });
    }

    // If no classification provided and not forced, return current lane info
    const currentLane = await prisma.issueLane.findFirst({
      where: { issueId },
      orderBy: { judgedAt: "desc" },
    });

    if (currentLane && !useForce) {
      return NextResponse.json({
        success: true,
        lane: currentLane.lane,
        confidence: currentLane.confidence,
        reason: currentLane.reason ?? "",
        model: currentLane.model ?? null,
        judgedAt: currentLane.judgedAt,
        reclassifyAvailable: true,
      });
    }

    // Use heuristic fallback for auto-classification
    const classification = classifyByHeuristics(issue.title, issue.body, issue.labels);

    await prisma.$transaction([
      prisma.issueLane.create({
        data: {
          issueId,
          ...classification,
          model: "heuristic",
        },
      }),
      prisma.issue.update({
        where: { id: issueId },
        data: { currentLane: classification.lane },
      }),
    ]);

    return NextResponse.json({
      success: true,
      lane: classification.lane,
      confidence: classification.confidence,
      reason: classification.reason,
      model: "heuristic",
    });
  } catch (error) {
    console.error("Lane classification failed:", error);
    return NextResponse.json({ error: "Failed to classify issue lane" }, { status: 500 });
  }
}

/**
 * GET /api/issues/[issueId]/lane — Get the current lane classification for an issue.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ issueId: string }> }) {
  const token = _request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.MISSION_CONTROL_AGENT_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const { issueId } = params;

    // First check the currentLane field on the Issue for quick access
    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { currentLane: true, lastSyncedAt: true },
    });

    if (!issue) {
      return NextResponse.json({ error: "Issue not found in local cache" }, { status: 404 });
    }

    // Check for full classification history
    const currentLane = await prisma.issueLane.findFirst({
      where: { issueId },
      orderBy: { judgedAt: "desc" },
    });

    if (!currentLane) {
      return NextResponse.json({
        lane: issue.currentLane ?? "normal",
        confidence: null,
        reason: "",
        model: null,
        judgedAt: null,
      });
    }

    return NextResponse.json({
      lane: currentLane.lane,
      confidence: currentLane.confidence,
      reason: currentLane.reason ?? "",
      model: currentLane.model ?? null,
      judgedAt: currentLane.judgedAt,
    });
  } catch (error) {
    console.error("Failed to get lane classification:", error);
    return NextResponse.json({ error: "Failed to retrieve lane classification" }, { status: 500 });
  }
}
