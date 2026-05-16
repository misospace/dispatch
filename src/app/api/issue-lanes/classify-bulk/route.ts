import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyIssue, LANE_NORMAL } from "@/lib/issue-lane-classification";

/**
 * POST /api/issue-lanes/classify-bulk
 * Classify all unclassified or stale issues. Rate-limited to 50 issues per call.
 * Classification failures are non-blocking: failed issues default to NORMAL.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const limit = Math.min(body.limit ?? 50, 200); // Cap at 200 per request
    const modelSource = typeof body.modelSource === "string" && body.modelSource.trim().length > 0
      ? body.modelSource.trim()
      : "bulk-sync";

    // Find issues that need classification: no lane set, or judged more than 24h ago
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const issues = await prisma.issue.findMany({
      where: {
        state: "open",
        OR: [
          { laneJudgedAt: null },
          { laneJudgedAt: { lt: staleThreshold } },
        ],
      },
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
      },
      take: limit,
    });

    const results = {
      total: issues.length,
      classified: 0,
      skipped: 0,
      failed: 0,
      details: [] as Array<{ issueId: string; number: number; lane: string; error?: string }>,
    };

    for (const issue of issues) {
      try {
        const classification = await classifyIssue(
          { title: issue.title, body: issue.body, labels: issue.labels },
          undefined, // noopClassifier by default
          modelSource,
        );

        await prisma.issue.update({
          where: { id: issue.id },
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
        });

        results.classified++;
        results.details.push({
          issueId: issue.id,
          number: issue.number,
          lane: classification.lane,
        });
      } catch (error) {
        // Classification failure does NOT break sync — default to NORMAL
        console.error(`Lane classification failed for issue #${issue.number}:`, error);
        results.failed++;

        // Still record the failure in history and set a safe default
        await prisma.issue.update({
          where: { id: issue.id },
          data: {
            lane: LANE_NORMAL,
            laneConfidence: 0.1,
            laneReason: `Bulk classification failed: ${error instanceof Error ? error.message : "unknown error"}`,
            laneModel: modelSource,
            laneJudgedAt: new Date(),
            laneHistory: {
              create: {
                lane: LANE_NORMAL,
                confidence: 0.1,
                reason: `Bulk classification failed: ${error instanceof Error ? error.message : "unknown error"}`,
                model: modelSource,
              },
            },
          },
        });

        results.details.push({
          issueId: issue.id,
          number: issue.number,
          lane: LANE_NORMAL,
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
    }

    return NextResponse.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error("Bulk lane classification failed:", error);
    return NextResponse.json({ error: "Bulk lane classification failed" }, { status: 500 });
  }
}
