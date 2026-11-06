import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { summarizeObserveRuns } from "@/lib/groomer/history";
import { jsonSafe } from "@/lib/json";

const HOUR_MS = 60 * 60 * 1000;
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 720;
const DEFAULT_WINDOW_HOURS = 24;

// "How often would this automation act?" over a recent window (#1542).
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const { searchParams } = new URL(request.url);
  const raw = parseInt(searchParams.get("windowHours") ?? "", 10);
  const windowHours =
    Number.isFinite(raw) && raw >= MIN_WINDOW_HOURS
      ? Math.min(raw, MAX_WINDOW_HOURS)
      : DEFAULT_WINDOW_HOURS;
  try {
    const summary = await summarizeObserveRuns(prisma, { windowMs: windowHours * HOUR_MS });
    return NextResponse.json(jsonSafe(summary));
  } catch (error) {
    return handleApiError("summarize observe runs", error);
  }
}
