import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getCourierTrackingConfig } from "@/lib/courier-tracking";
import {
  isTrackable,
  refreshExternalContributionTracking,
  type TrackingRefreshOutcome,
} from "@/lib/external-contribution-tracking";
import { projectExternalContribution } from "@/lib/external-contribution-view";

/**
 * POST /api/external-contributions/[id]/refresh (#1538) — refresh one
 * accepted request's lifecycle evidence from Courier's authenticated status
 * read (`GET /v1/contributions/<run>`, Courier #836).
 *
 * What this route never does: re-submit the contribution (refresh only ever
 * GETs), touch a tracked upstream issue, or show a PR that Courier's own
 * projection did not record. What it guarantees:
 *
 * - Bounded + duplicate-prevented: one read per row per cooldown window,
 *   claimed by an atomic conditional update, so concurrent refreshers cannot
 *   stampede Courier. Losers get the stored evidence with
 *   `refreshed: false` and the remaining cooldown (HTTP 200).
 * - Identity-bound: a status response whose identity echo (run, namespace,
 *   lane, baseRepo, workRepo) does not equal the stored admission is refused
 *   as an observation — nothing is recorded but the redacted diagnostic, and
 *   the route answers 502.
 * - Honest failure: a missing capability (no read token configured) is 503
 *   naming the missing piece and leaves submission untouched; a 404 becomes
 *   the explicit `expired` state (never completion); a reaped run whose final
 *   evidence was already persisted keeps that evidence.
 * - Credential boundary: the READ token is server-side only
 *   (`DISPATCH_COURIER_READ_TOKEN`) and never appears in a response, the
 *   ledger, or the audit row.
 *
 * Maintainer tier only (absent from WORKER_ALLOWLIST).
 *
 * Responses:
 * | Status | When |
 * |---|---|
 * | 200 | Observation recorded, explicit miss recorded as expired, or the cooldown window held |
 * | 404 | No such request |
 * | 409 | The request was never accepted, so there is no run identity to track |
 * | 502 | Identity mismatch refused the observation |
 * | 503 | Tracking not configured, or Courier could not answer (5xx/4xx refusal) |
 * | 504 | Courier sent no answer in time |
 */
const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`external-contributions-refresh:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    const { id } = await params;
    const row = await prisma.externalContributionRequest.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ error: "External contribution request not found" }, { status: 404 });
    }
    if (!isTrackable(row)) {
      return NextResponse.json(
        {
          error: "this request has no Courier run identity to track yet (only accepted requests are trackable)",
          status: row.deliveryStatus,
        },
        { status: 409 },
      );
    }

    const config = getCourierTrackingConfig();
    if (!config.ok) {
      // Missing capability, named as such — submission stays untouched.
      return NextResponse.json({ error: config.reason, tracking: { configured: false } }, { status: 503 });
    }

    const result = await refreshExternalContributionTracking(prisma, row, config);
    const body = projectExternalContribution(result.request);

    const audit = async (data: { success: boolean; errorMessage?: string; notes?: string }) => {
      try {
        await prisma.auditLog.create({
          data: {
            actor: getAuthorizedActor(auth, request),
            action: "external_contribution_track",
            repoFullName: row.baseRepo,
            issueNumber: null,
            beforeLabels: [],
            afterLabels: [],
            ...data,
          },
        });
      } catch {
        // Audit failure never masks the response.
      }
    };

    return respondToTracking(result, body, audit);
  } catch (error) {
    return handleApiError("refresh external contribution tracking", error);
  }
}

function respondToTracking(
  result: TrackingRefreshOutcome,
  body: ReturnType<typeof projectExternalContribution>,
  audit: (data: { success: boolean; errorMessage?: string; notes?: string }) => Promise<void>,
): NextResponse {
  switch (result.outcome) {
    case "cooldown":
      // Duplicate-prevented refresh: stored evidence, zero network calls.
      return NextResponse.json({ refreshed: false, cooldownRemainingMs: result.cooldownRemainingMs, ...body });
    case "observed":
      return NextResponse.json({ refreshed: true, ...body });
    case "expired": {
      // The read succeeded with the shared miss: recorded explicitly, and
      // final evidence (if we held any) survives.
      void audit({
        success: true,
        notes: `requestId=${body.id} outcome=expired courierRun=${body.run} state=${body.tracking.state}`,
      });
      return NextResponse.json({ refreshed: true, expired: true, ...body });
    }
    case "mismatch":
      void audit({
        success: false,
        errorMessage: body.tracking.lastError ?? "courier status identity mismatch",
        notes: `requestId=${body.id}`,
      });
      return NextResponse.json(
        { error: body.tracking.lastError ?? "courier status identity mismatch; the observation was refused", refreshed: false, ...body },
        { status: 502 },
      );
    case "refused":
      void audit({
        success: false,
        errorMessage: body.tracking.lastError ?? `courier status read refused with HTTP ${result.httpStatus}`,
        notes: `requestId=${body.id}`,
      });
      return NextResponse.json(
        { error: body.tracking.lastError ?? "courier status read refused", refreshed: false, ...body },
        { status: 503 },
      );
    case "unavailable":
      void audit({
        success: false,
        errorMessage: body.tracking.lastError ?? "courier status read unavailable",
        notes: `requestId=${body.id}${result.retryAfterMs !== undefined ? ` retryAfterMs=${result.retryAfterMs}` : ""}`,
      });
      return NextResponse.json(
        {
          error: body.tracking.lastError ?? "courier status read unavailable; the stored evidence is unchanged",
          refreshed: false,
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          ...body,
        },
        { status: result.timeout ? 504 : 503 },
      );
  }
}
