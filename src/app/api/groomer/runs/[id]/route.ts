import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { getGroomingRunDetail } from "@/lib/groomer/history";
import { jsonSafe } from "@/lib/json";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const { id } = await params;

  try {
    const run = await getGroomingRunDetail(prisma, id);
    if (!run) {
      return errorResponse("Grooming run not found", 404);
    }
    return NextResponse.json(jsonSafe(run));
  } catch (error) {
    return handleApiError("fetch grooming run", error);
  }
}
