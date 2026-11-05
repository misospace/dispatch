import { NextResponse } from "next/server";
import { errorResponse, handleApiError, readJsonObjectBody } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getCourierAdmissionConfig } from "@/lib/courier-admission";
import { parseContributionInput, submitExternalContribution, type ExternalContributionRow } from "@/lib/external-contribution";

/**
 * POST /api/external-contributions (#1537, parent #1349).
 *
 * Persist a Dispatch-owned external contribution request and submit it once,
 * exactly, to Courier's HTTP admission API (`POST /v1/contributions`,
 * Courier #708). The idempotency key + canonical fields are persisted before
 * the first network call, so repeated clicks, concurrent requests, restarts,
 * and a lost success response all resolve to the SAME contribution identity;
 * a changed payload under an existing key is rejected.
 *
 * Boundaries:
 *   - Maintainer tier only (absent from WORKER_ALLOWLIST): submission is an
 *     operator action carried by server-side Courier credentials. This route
 *     never mutates a tracked upstream issue, never writes Kubernetes state,
 *     and never creates or merges a PR — Courier owns fork approval,
 *     publication authority, branch identity, and PR creation.
 *   - The admission endpoint/credential/namespaces are operator configuration
 *     only (`getCourierAdmissionConfig`); a client cannot select the
 *     destination, and `fresh`/`debug` stay privileged Courier-side choices.
 *   - Missing/malformed configuration answers 503 and disables submission
 *     clearly, without touching any other Dispatch queue.
 *
 * Response: 201 when Courier created the admission, 200 when it resumed one
 * (or an accepted request was replayed). The body carries the recorded
 * Courier identity (`run`, `namespace`, `workItemId`, `resumed`) plus the
 * Dispatch-side request state. Identity is not proof of execution or
 * publication.
 */

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/** The response projection of a request row. No credential ever exists here. */
function projectRequest(row: ExternalContributionRow) {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    status: row.deliveryStatus,
    // The identity Courier returned (null until accepted). Identity is not
    // proof of successful execution or publication.
    run: row.courierRun,
    namespace: row.courierNamespace ?? row.namespace,
    workItemId: row.courierWorkItemId,
    resumed: row.resumed,
    baseRepo: row.baseRepo,
    baseRef: row.baseRef,
    workRepo: row.workRepo,
    upstreamIssue: row.upstreamIssue,
    attempts: row.attemptCount,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`external-contributions:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  const parsedBody = await readJsonObjectBody(request, { rejectArrays: true });
  if ("error" in parsedBody) return parsedBody.error;

  // Fail fast on configuration BEFORE persisting anything: with submission
  // disabled there is no valid admission to record, and a disabled endpoint
  // must not accumulate pending rows on every click.
  const config = getCourierAdmissionConfig();
  if (!config.ok) {
    return errorResponse(config.reason, 503);
  }

  const input = parseContributionInput(parsedBody.body);
  if (!input.ok) return errorResponse(input.error, 400);

  // Operator-approved namespaces only: the namespace is the admission
  // destination inside Courier, so a value outside the configured list is a
  // validation failure (400), never a best-effort closest match.
  if (!config.namespaces.includes(input.input.namespace)) {
    return errorResponse("namespace is not approved for external contribution submission", 400);
  }

  const actor = getAuthorizedActor(auth, request);

  // Best-effort audit row: the ExternalContributionRequest ledger row is the
  // durable record, so an audit failure never masks the delivery response.
  const audit = async (data: { success: boolean; errorMessage?: string; notes?: string }) => {
    try {
      await prisma.auditLog.create({
        data: {
          actor,
          action: "external_contribution_submit",
          repoFullName: input.input.baseRepo,
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

  try {
    const result = await submitExternalContribution(prisma, input.input, { actor }, config);
    const body = projectRequest(result.request);
    const row = result.request;

    switch (result.outcome) {
      case "created":
        await audit({ success: true, notes: `requestId=${row.id} outcome=created courierRun=${row.courierRun}` });
        return NextResponse.json(body, { status: 201 });
      case "resumed":
        await audit({ success: true, notes: `requestId=${row.id} outcome=resumed courierRun=${row.courierRun}` });
        return NextResponse.json(body, { status: 200 });
      case "replay_accepted":
        return NextResponse.json(body, { status: 200 });
      case "in_flight":
        return NextResponse.json(body, { status: 200 });
      case "replay_rejected":
        return NextResponse.json(
          { error: "this request identity was already rejected by Courier; a new contribution requires a new request", ...body },
          { status: 409 },
        );
      case "payload_conflict":
        await audit({ success: false, errorMessage: "refused: changed payload under an existing request identity" });
        return NextResponse.json(
          { error: "request payload does not match the existing request for this idempotency key; a new contribution requires a new request", ...body },
          { status: 409 },
        );
      case "retry_exhausted":
        return NextResponse.json(
          { error: "courier delivery remains uncertain after the bounded retries; a new contribution requires a new request", ...body },
          { status: 503 },
        );
      case "uncertain":
        await audit({ success: false, errorMessage: row.lastError ?? "courier admission delivery is uncertain" });
        return NextResponse.json(
          { error: row.lastError ?? "courier admission delivery is uncertain; retrying with the same key is safe", ...body },
          { status: result.timeout ? 504 : 502 },
        );
      case "rejected":
        await audit({ success: false, errorMessage: row.lastError ?? "courier admission rejected the request" });
        return NextResponse.json(
          { error: row.lastError ?? "courier admission rejected the request", ...body },
          // Mirror the explicit Courier refusal (400/401/403/404/422/...):
          // the policy call is Courier's and the caller deserves the code.
          { status: result.httpStatus },
        );
    }
  } catch (error) {
    return handleApiError("submit external contribution", error);
  }
}
