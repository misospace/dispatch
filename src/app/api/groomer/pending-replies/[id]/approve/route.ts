import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { jsonSafe } from "@/lib/json";
import { rejectAgentCaller } from "@/lib/operator-only";
import { prisma } from "@/lib/prisma";
import { enforceRateLimit } from "@/lib/rate-limit";
import { approvePendingReply } from "@/lib/groomer/pending-reply";

const RATE_LIMIT = { limit: 10, windowMs: 10_000 };

async function validateOptionalBody(request: Request): Promise<void> {
  const text = await request.text();
  if (!text.trim()) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Invalid JSON body");
  }
  const reason = (body as Record<string, unknown>).reason;
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw new Error("'reason' must be a string");
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return authErrorResponse(auth);
  const forbidden = rejectAgentCaller(auth, "Approving a groomer reply");
  if (forbidden) return forbidden;
  const limited = enforceRateLimit(`groomer-reply-approve:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    await validateOptionalBody(request);
    const { id } = await context.params;
    const result = await approvePendingReply(prisma, {
      id,
      actor: getAuthorizedActor(auth, request),
      authType: auth.type,
    });
    if (!result.ok) {
      const failure = result as { ok: false; code: string; message: string };
      const status = failure.code === "not_found"
        ? 404
        : failure.code === "not_pending" || failure.code === "in_progress"
          ? 409
          : failure.code === "too_long"
            ? 400
            : 502;
      return errorResponse(failure.message, status);
    }
    return NextResponse.json(jsonSafe({ status: "posted", url: result.url }));
  } catch (error) {
    if (error instanceof Error && (error.message === "Invalid JSON body" || error.message === "'reason' must be a string")) {
      return errorResponse(error.message, 400);
    }
    return handleApiError("approve pending groomer reply", error);
  }
}
