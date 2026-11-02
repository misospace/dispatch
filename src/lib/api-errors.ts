/**
 * Shared API error response helpers.
 *
 * Centralizes the canonical pattern for error responses across route
 * handlers, so every route logs and returns the same shape:
 *
 *   console.error("Failed to <thing>:", error);
 *   return errorResponse("Failed to <thing>");
 *
 * Use `errorResponse` for ad-hoc failures and `handleApiError` inside
 * a catch block to keep the log message and the JSON body in sync.
 */

import { NextResponse } from "next/server";

/**
 * Build a structured JSON error response with a 500 status by default.
 * The body is `{ error: message }` to match the convention used across
 * the rest of the route handlers.
 */
export function errorResponse(
  message: string,
  status: number = 500,
): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Log an error with a consistent prefix and return a structured 500
 * response. Use this inside catch blocks so the log line and the
 * response body always agree on what failed.
 */
export function handleApiError(
  context: string,
  error: unknown,
  status: number = 500,
): NextResponse<{ error: string }> {
  console.error(`Failed to ${context}:`, error);
  return errorResponse(`Failed to ${context}`, status);
}

/**
 * Parse a request body that must be a JSON object, returning either the
 * parsed object or a ready-to-send 400 response. This is the canonical
 * replacement for the hand-rolled preamble repeated across route handlers:
 *
 *   const parsed = await readJsonObjectBody(request);
 *   if ("error" in parsed) return parsed.error;
 *   const { issueId, ... } = parsed.body;
 *
 * By default a JSON array is accepted (treated like any other object body,
 * matching the routes that only guard `typeof body !== "object"`); routes
 * whose validation deliberately rejects arrays pass `rejectArrays: true`.
 */
export async function readJsonObjectBody(
  request: Request,
  opts: { rejectArrays?: boolean } = {},
): Promise<{ body: Record<string, unknown> } | { error: NextResponse<{ error: string }> }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { error: errorResponse("Invalid JSON body", 400) };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (opts.rejectArrays === true && Array.isArray(parsed))
  ) {
    return { error: errorResponse("Invalid JSON body", 400) };
  }
  return { body: parsed as Record<string, unknown> };
}
