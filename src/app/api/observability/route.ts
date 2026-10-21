import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { collectObservabilitySnapshot } from "@/lib/observability-snapshot";

/**
 * Read-only observability snapshot (#1252): the bounded signal catalogue of
 * docs/observability.md computed from Dispatch's own cache. Maintainer tier
 * only (not on the worker allowlist); the payload carries no repository,
 * issue, agent, or error-text dimensions by construction in
 * @/lib/observability-signals.
 */
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  try {
    const snapshot = await collectObservabilitySnapshot();
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError("fetch observability snapshot", error);
  }
}
