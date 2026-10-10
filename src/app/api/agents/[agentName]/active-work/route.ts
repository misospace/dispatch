import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { resolveActiveWork } from "@/lib/lease";
import type { ActiveWorkResult } from "@/lib/next-action";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";

export async function GET(request: Request, { params }: { params: Promise<{ agentName: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const { agentName } = await params;

  // A bound worker credential may only read its own agent's active work; an
  // unbound legacy worker token is refused here (#1129).
  const scopeError = await enforceWorkerAgentScope(auth, agentName);
  if (scopeError) return scopeError;

  try {
    const context = await resolveActiveWork(agentName);

    if (!context) {
      const response: ActiveWorkResult = { hasActiveWork: false };
      return NextResponse.json(response);
    }

    const response: ActiveWorkResult = {
      hasActiveWork: true,
      context,
    };
    return NextResponse.json(response);
  } catch (error) {
    return handleApiError("fetch active work", error);
  }
}
