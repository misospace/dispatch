import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { listGroomingRuns } from "@/lib/groomer/history";
import { jsonSafe } from "@/lib/json";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
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
    return handleApiError("fetch grooming runs", error);
  }
}
