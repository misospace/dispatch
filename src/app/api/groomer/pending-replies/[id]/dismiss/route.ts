import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { rejectAgentCaller } from "@/lib/operator-only";
import { prisma } from "@/lib/prisma";
import { enforceRateLimit } from "@/lib/rate-limit";
import { dismissPendingReply } from "@/lib/groomer/pending-reply";

const RATE_LIMIT = { limit: 10, windowMs: 10_000 };

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return authErrorResponse(auth);
  const forbidden = rejectAgentCaller(auth, "Dismissing a groomer reply");
  if (forbidden) return forbidden;
  const limited = enforceRateLimit(`groomer-reply-dismiss:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    const { id } = await context.params;
    const row = await prisma.groomerPendingReply.findUnique({ where: { id } });
    const result = await dismissPendingReply(prisma, {
      id,
      actor: getAuthorizedActor(auth, request),
    });
    if (!result.ok) {
      return errorResponse(
        result.code === "not_found" ? "Pending reply not found" : "Pending reply is no longer pending",
        result.code === "not_found" ? 404 : 409,
      );
    }

    if (row) {
      try {
        await prisma.auditLog.create({
          data: {
            actor: getAuthorizedActor(auth, request),
            action: "groomer_reply_dismissed",
            repoFullName: row.repoFullName,
            issueNumber: row.issueNumber,
            issueId: row.issueId,
            beforeLabels: [],
            afterLabels: [],
            success: true,
            notes: JSON.stringify({ applicationKey: row.applicationKey, authType: auth.type }),
          },
        });
      } catch (error) {
        console.warn(`[groomer] dismissed reply audit failed for ${id}:`, error);
      }
    }
    return NextResponse.json({ success: true, status: "dismissed" });
  } catch (error) {
    return handleApiError("dismiss pending groomer reply", error);
  }
}
