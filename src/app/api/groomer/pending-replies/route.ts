import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { jsonSafe } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

function parseLimit(raw: string | null): number {
  const parsed = raw === null ? 50 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 50;
}

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return authErrorResponse(auth);
  const limited = enforceRateLimit(`groomer-reply-list:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") || "pending";
  try {
    const rows = await prisma.groomerPendingReply.findMany({
      where: {
        status,
        ...(searchParams.get("repoFullName") ? { repoFullName: searchParams.get("repoFullName")! } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: parseLimit(searchParams.get("limit")),
    });
    return NextResponse.json(jsonSafe(rows));
  } catch (error) {
    return handleApiError("fetch pending groomer replies", error);
  }
}
