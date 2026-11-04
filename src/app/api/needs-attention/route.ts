import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { collectNeedsAttentionSnapshot } from "@/lib/needs-attention-snapshot";

/**
 * Read-only "Needs Attention" projection (#1541): the work that currently
 * requires human action, derived from Dispatch's own records. Maintainer
 * tier only (not on the worker allowlist — a worker is never the audience
 * of the operator attention view); no writes, no forge calls.
 */
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  try {
    const snapshot = await collectNeedsAttentionSnapshot();
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError("fetch needs-attention snapshot", error);
  }
}
