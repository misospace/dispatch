import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }
  const retentionDays = parseInt(process.env.DISPATCH_CLOSED_ISSUE_RETENTION_DAYS ?? "30", 10);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  try {
    const result = await prisma.issue.deleteMany({
      where: {
        state: "closed",
        closedAt: {
          lt: cutoffDate,
        },
      },
    });

    return NextResponse.json({
      success: true,
      prunedCount: result.count,
      retentionDays,
      cutoffDate: cutoffDate.toISOString(),
    });
  } catch (error) {
    return handleApiError("prune closed issues", error);
  }
}
