import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { projectExternalContribution } from "@/lib/external-contribution-view";

/**
 * GET /api/external-contributions/[id] (#1538) — one request's stored record
 * with its last trustworthy Courier lifecycle observation.
 *
 * A pure ledger read: NO Courier call, no submission, no upstream mutation.
 * This is the surface that answers "what do we actually know" while Courier
 * is unreachable — state, publication evidence (only what Courier itself
 * recorded), freshness, and the last safe diagnostic.
 *
 * Maintainer tier only (absent from WORKER_ALLOWLIST).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeRequest(_request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`external-contributions-get:${auth.throttleKey}`, { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { id } = await params;
    const row = await prisma.externalContributionRequest.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ error: "External contribution request not found" }, { status: 404 });
    }
    return NextResponse.json(projectExternalContribution(row));
  } catch (error) {
    return handleApiError("read external contribution request", error);
  }
}
