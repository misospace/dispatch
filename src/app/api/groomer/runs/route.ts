import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { listGroomingRuns } from "@/lib/groomer/history";
import { GROOMER_MODES, type GroomerMode } from "@/lib/groomer/observe";
import { jsonSafe } from "@/lib/json";
import { parseIssueNumber, parseListLimit } from "@/lib/query-limit";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get("dryRun");
  const modeParam = searchParams.get("mode");
  try {
    const runs = await listGroomingRuns(prisma, {
      repo: searchParams.get("repo") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      model: searchParams.get("model") ?? undefined,
      issueNumber: parseIssueNumber(searchParams.get("issueNumber")),
      dryRun: dryRun === null ? undefined : dryRun === "true",
      mode: modeParam && GROOMER_MODES.includes(modeParam as GroomerMode) ? modeParam : undefined,
      take: parseListLimit(searchParams.get("limit")),
    });
    return NextResponse.json(jsonSafe(runs));
  } catch (error) {
    return handleApiError("fetch grooming runs", error);
  }
}
