import { NextResponse } from "next/server";
import type { AuthorizedRequest } from "./auth";
import { errorResponse } from "./api-errors";

const UNBOUND_WORKER_MESSAGE =
  'Worker token is not bound to an agent; configure DISPATCH_WORKER_TOKENS as "agent:token" pairs';

/**
 * Best-effort audit row when a worker-tier credential is denied by the
 * identity-scope gate. Throttled per actor so a probing worker cannot
 * write-amplify the audit table, and fully wrapped so a limiter or DB failure
 * can never change the denial. Token values are never recorded.
 */
async function recordWorkerScopeDenial(
  auth: AuthorizedRequest,
  targetAgent: string,
): Promise<void> {
  try {
    const actor =
      auth.authorized && auth.type === "bearer" && auth.agentName
        ? auth.agentName
        : "unbound-worker";
    const { checkRateLimit } = await import("./rate-limit");
    if (!checkRateLimit(`worker_scope_denied:${actor}`, { limit: 10, windowMs: 60_000 }).allowed) {
      return;
    }
    const { prisma } = await import("./prisma");
    await prisma.auditLog.create({
      data: {
        actor,
        action: "worker_scope_denied",
        repoFullName: "unknown",
        success: false,
        errorMessage: `worker token bound to ${auth.authorized && auth.type === "bearer" && auth.agentName ? auth.agentName : "no agent"} denied acting for "${targetAgent}"`,
        beforeLabels: [],
        afterLabels: [],
      },
    });
  } catch {
    // Best-effort audit only — never let a limiter or DB failure affect the
    // scope decision.
  }
}

/**
 * Enforce that a worker-tier bearer caller has a bound agent identity.
 *
 * - non-bearer / maintainer-tier callers (OIDC, basic, disabled, maintainer
 *   bearer) are unconstrained and pass;
 * - a bound worker credential passes;
 * - an unbound legacy `DISPATCH_WORKER_TOKEN` is refused with a 403.
 *
 * Returns an error `NextResponse` when denied, or `null` when allowed. Use this
 * on identity-scoped routes that look the agent up separately (e.g. from the
 * issue assignment) rather than from the request.
 */
export async function enforceWorkerBound(
  auth: AuthorizedRequest,
): Promise<NextResponse<{ error: string }> | null> {
  if (!auth.authorized) return null;
  if (auth.type !== "bearer" || auth.tier !== "worker") return null;
  if (auth.agentName) return null;
  await recordWorkerScopeDenial(auth, "");
  return errorResponse(UNBOUND_WORKER_MESSAGE, 403);
}

/**
 * Enforce that a worker-tier bearer caller may act on behalf of `targetAgent`.
 *
 * Worker credentials issued through `DISPATCH_WORKER_TOKENS` are bound to an
 * immutable agent name resolved from the token itself. This helper is the
 * single gate routes use to keep a bound credential scoped to its own agent:
 *
 * - non-bearer / maintainer-tier callers (OIDC, basic, disabled, maintainer
 *   bearer) are unconstrained — operators may act for any agent;
 * - a bound worker token is allowed only when its bound agent equals
 *   `targetAgent`;
 * - an unbound legacy `DISPATCH_WORKER_TOKEN` is refused (hard cutover): the
 *   shared token carries no identity, so it must not stand in for one.
 *
 * Returns an error `NextResponse` when denied, or `null` when allowed. Token
 * values are never included in the response.
 */
export async function enforceWorkerAgentScope(
  auth: AuthorizedRequest,
  targetAgent: string,
): Promise<NextResponse<{ error: string }> | null> {
  if (!auth.authorized) return null;
  if (auth.type !== "bearer" || auth.tier !== "worker") return null;

  const bound = auth.agentName;
  if (!bound) {
    await recordWorkerScopeDenial(auth, targetAgent);
    return errorResponse(UNBOUND_WORKER_MESSAGE, 403);
  }
  if (bound !== targetAgent) {
    await recordWorkerScopeDenial(auth, targetAgent);
    return errorResponse(
      `Worker token is bound to agent "${bound}" and may not act for "${targetAgent}"`,
      403,
    );
  }
  return null;
}
