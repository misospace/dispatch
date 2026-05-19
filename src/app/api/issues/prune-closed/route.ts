import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST() {
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
    console.error("Failed to prune closed issues:", error);
    return NextResponse.json({ error: "Failed to prune closed issues" }, { status: 500 });
  }
}
