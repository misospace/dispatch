// (#1499) Retention prune for terminal AgentExecution rows — the observation
// table must not grow without bound when a noisy source mints a new run UID
// per restart.
//
// POST /api/agent-work/observations/prune — deletes terminal rows whose last
// observation is older than the retention window
// (DISPATCH_AGENT_EXECUTION_RETENTION_MS, default 7d). Maintainer-tier only:
// the route is absent from WORKER_ALLOWLIST, so worker tokens are refused at
// the tier gate.
//
// Display-data hygiene ONLY: the delete is fenced on the terminal state set
// and touches no other table — AgentWork, leases, and ownership state are
// untouched, and nothing downstream of claim/admission/settlement consumes
// this table. Semantics live in src/lib/agent-executions.ts.

import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { pruneTerminalExecutions } from "@/lib/agent-executions";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(
    `agent-executions-prune:${auth.throttleKey}`,
    RATE_LIMIT,
  );
  if (limited) return limited;

  try {
    const { prunedCount, cutoff } = await pruneTerminalExecutions(prisma);
    return NextResponse.json({
      ok: true,
      prunedCount,
      cutoff: cutoff.toISOString(),
    });
  } catch (error) {
    return handleApiError("prune terminal agent executions", error);
  }
}
