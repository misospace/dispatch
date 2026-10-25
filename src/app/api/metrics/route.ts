import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { collectObservabilitySnapshot } from "@/lib/observability-snapshot";
import {
  exportObservabilityMetrics,
  observabilityMetricsEnabled,
} from "@/lib/observability-export";

/**
 * Opt-in Prometheus/VictoriaMetrics scrape endpoint (#1255): the #1252 signal
 * catalogue rendered as text exposition. Fail-closed on
 * DISPATCH_METRICS_ENABLED (404 while disabled), read-only, and maintainer
 * tier only (not on the worker allowlist) — a scrape must never mutate state
 * or release a claim. See docs/observability-packaging.md.
 */
export async function GET(request: Request) {
  if (!observabilityMetricsEnabled()) {
    // Generic body: the response must not advertise configuration state or
    // the flag name to an unauthenticated caller (fail-closed discovery).
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  try {
    const snapshot = await collectObservabilitySnapshot();
    const body = exportObservabilityMetrics(snapshot);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError("export observability metrics", error);
  }
}
