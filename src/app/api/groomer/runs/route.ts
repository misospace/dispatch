import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { listGroomingRuns } from "@/lib/groomer/history";
import { jsonSafe } from "@/lib/json";

export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const issueNumber = searchParams.get("issueNumber");
  const dryRun = searchParams.get("dryRun");
  try {
    const runs = await listGroomingRuns(prisma, {
      repo: searchParams.get("repo") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      model: searchParams.get("model") ?? undefined,
      issueNumber: issueNumber ? parseInt(issueNumber, 10) : undefined,
      dryRun: dryRun === null ? undefined : dryRun === "true",
      take: parseInt(searchParams.get("limit") || "50", 10),
    });
    return NextResponse.json(jsonSafe(runs));
  } catch (error) {
    console.error("Failed to fetch grooming runs:", error);
    return NextResponse.json({ error: "Failed to fetch grooming runs" }, { status: 500 });
  }
}
