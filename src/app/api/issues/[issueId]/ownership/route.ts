import { NextResponse } from "next/server";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { inspectIssueOwnership } from "@/lib/ownership-inspect";

/**
 * GET /api/issues/[issueId]/ownership — operator read surface for the derived
 * ownership of one issue (#1251, docs/ownership-reconciliation.md §9).
 *
 * Returns the folded §4/§5 ownership state (state, machine-readable reason
 * codes, owner, liveness) together with the evidence snapshot it was derived
 * from and the deployment's liveness windows. The raw claim token is never
 * surfaced — only its presence. This is a pure read: it writes nothing,
 * audits nothing, and releases nothing.
 *
 * Operator-only: worker-tier callers are rejected with 403 by the central
 * tiering (this route is not in `WORKER_ALLOWLIST`), not by any local check.
 *
 * Query params:
 * - `live=false` — use the cached label set instead of re-reading the forge
 *   (`labelSource: "cache"`). The default is a live read; a failed live read
 *   yields `labelSource: "unavailable"` rather than a 5xx.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return authErrorResponse(auth);

  const { issueId } = await params;
  const live = new URL(request.url).searchParams.get("live") !== "false";

  const result = await inspectIssueOwnership(issueId, { live });
  if (!result.found) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  return NextResponse.json(result);
}
