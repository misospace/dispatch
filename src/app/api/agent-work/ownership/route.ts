// #1251 — optional worker ownership capability endpoint.
//
// POST /api/agent-work/ownership
// Body: { operation: "register" | "renew" | "disposition", agentName, issueId,
//         claimToken, occurredAt?, ...operation-specific fields }
//
// The three operations of docs/ownership-reconciliation.md §6 share one route
// because they share one contract: every call is fenced on the `claimToken`
// issued with the claim (mirroring the PR-fix `{id, generation, handoutToken}`
// discipline), keyed to the token-derived agent identity (#1129), and records
// occurrence-vs-observation times. Semantics live in `src/lib/worker-ownership.ts`.
//
// Identity boundaries (#1251 done-criteria):
// - a BOUND worker credential may only operate for its own agent
//   (`enforceWorkerAgentScope` — exact match, no `agent/courier*` wildcard);
// - the legacy UNBOUND worker token has no derived identity and is refused
//   (the capability keys on bound identity per §3.8/§6);
// - maintainers (bearer maintainer / basic / OIDC) may record for a named
//   agent, with the operator captured as the audit actor.
//
// Nothing here writes GitHub labels or releases leases; forge reads are not
// needed for these operations (the fencing is entirely on the claim receipt).

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  OWNERSHIP_DISPOSITIONS,
  dispositionOwnership,
  renewOwnership,
  registerOwnership,
  type OwnershipExternalWait,
} from "@/lib/worker-ownership";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const MAX_FUTURE_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

type Operation = "register" | "renew" | "disposition";

function nonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** Parse a future ISO timestamp bounded to 7 days ahead; null when absent. */
function parseRetryAfter(raw: unknown, now: Date): { value?: Date | null; error?: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "string") return { error: "retryAfter must be an ISO 8601 timestamp" };
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return { error: "retryAfter must be a valid ISO 8601 timestamp" };
  if (parsed.getTime() <= now.getTime()) return { error: "retryAfter must be in the future" };
  if (parsed.getTime() > now.getTime() + MAX_FUTURE_RETRY_AFTER_MS) return { error: "retryAfter must be at most 7 days in the future" };
  return { value: parsed };
}

function parseExternalWait(raw: unknown, now: Date): { value?: OwnershipExternalWait | null; error?: string } {
  if (raw === undefined) return {};
  if (raw === null) return { value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "externalWait must be an object or null" };
  const obj = raw as Record<string, unknown>;
  const retry = parseRetryAfter(obj.retryAfter, now);
  if (retry.error) return { error: retry.error };
  if (!retry.value) return { error: "externalWait.retryAfter is required and must be a future ISO timestamp" };
  const reason = obj.reason === undefined || obj.reason === null ? "external dependency wait" : nonEmptyString(obj.reason, 500);
  if (reason === null || typeof reason !== "string") return { error: "externalWait.reason must be a string of at most 500 characters" };
  return { value: { reason, retryAfter: retry.value } };
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return authErrorResponse(auth);

  const limited = enforceRateLimit(`ownership:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return errorResponse("Invalid JSON body", 400);
    }
    const input = body as Record<string, unknown>;

    const operation = input.operation;
    if (operation !== "register" && operation !== "renew" && operation !== "disposition") {
      return errorResponse(`Invalid operation: expected one of ${(["register", "renew", "disposition"] as const).join(", ")}`, 400);
    }

    const agentName = nonEmptyString(input.agentName, 200);
    const issueId = nonEmptyString(input.issueId, 200);
    const claimToken = nonEmptyString(input.claimToken, 200);
    if (!agentName) return errorResponse("Missing required field: agentName (non-empty string, max 200 chars)", 400);
    if (!issueId) return errorResponse("Missing required field: issueId (non-empty string)", 400);
    if (!claimToken) return errorResponse("Missing required field: claimToken (the receipt issued with the claim)", 400);

    // Identity fencing: bound workers only for their own agent; the unbound
    // legacy worker token has no identity and is refused here.
    const scopeError = await enforceWorkerAgentScope(auth, agentName);
    if (scopeError) return scopeError;

    const actor = getAuthorizedActor(auth, request, agentName);
    const now = new Date();

    let runRef: string | null | undefined;
    if (input.runRef !== undefined && input.runRef !== null) {
      const parsed = nonEmptyString(input.runRef, 500);
      if (parsed === null) return errorResponse("runRef must be a non-empty string of at most 500 characters", 400);
      runRef = parsed;
    }

    const common = { agentName, issueId, claimToken, occurredAt: input.occurredAt, actor };

    const result =
      operation === "register"
        ? await registerOwnership({ ...common, runRef })
        : operation === "renew"
          ? await (async () => {
              const wait = parseExternalWait(input.externalWait, now);
              if (wait.error) return { invalid: wait.error } as const;
              return await renewOwnership({ ...common, runRef, externalWait: wait.value });
            })()
          : await (async () => {
              const disposition = input.disposition;
              if (typeof disposition !== "string" || !(OWNERSHIP_DISPOSITIONS as readonly string[]).includes(disposition)) {
                return { invalid: `Invalid disposition: expected one of ${OWNERSHIP_DISPOSITIONS.join(", ")}` } as const;
              }
              const note = input.note === undefined || input.note === null ? null : nonEmptyString(input.note, 1000);
              if (input.note != null && note === null) return { invalid: "note must be a string of at most 1000 characters" } as const;
              const successorRef = input.successorRef === undefined || input.successorRef === null ? null : nonEmptyString(input.successorRef, 500);
              if (input.successorRef != null && successorRef === null) return { invalid: "successorRef must be a string of at most 500 characters" } as const;
              const retry = parseRetryAfter(input.retryAfter, now);
              if (retry.error) return { invalid: retry.error } as const;
              // An external wait only belongs to a `blocked` disposition:
              // a terminal completed/released/handed_off record must not
              // classify a gone owner as EXTERNAL_WAIT in the read model.
              if (retry.value && disposition !== "blocked") {
                return { invalid: "retryAfter is only valid with disposition \"blocked\"" } as const;
              }
              const waitReason = input.waitReason === undefined || input.waitReason === null ? null : nonEmptyString(input.waitReason, 500);
              if (input.waitReason != null && waitReason === null) return { invalid: "waitReason must be a string of at most 500 characters" } as const;
              return await dispositionOwnership({
                ...common,
                disposition: disposition as (typeof OWNERSHIP_DISPOSITIONS)[number],
                note,
                successorRef,
                retryAfter: retry.value,
                waitReason,
              });
            })();

    if ("invalid" in result) return errorResponse(result.invalid, 400);
    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.httpStatus });
    }
    return NextResponse.json({ ok: true, operation, ...result.value });
  } catch (error) {
    console.error("Ownership operation failed:", error);
    return errorResponse("Failed to record ownership operation", 500);
  }
}
