/**
 * Agent-agnostic heartbeat orchestration endpoint.
 *
 * POST /api/agents/{agentName}/heartbeat
 *
 * Responsibilities:
 * - Authenticate with the existing agent token flow;
 * - Run deterministic Dispatch-side sync/reconciliation using shared service code;
 * - Aggregate warnings/errors (best-effort sync failures are warnings);
 * - Record an AgentRun for the heartbeat pass;
 * - Return a compact machine-readable result.
 */

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { runSyncBestEffort, runReconcileBestEffort } from "@/lib/heartbeat";
import { enforceRateLimit } from "@/lib/rate-limit";

// Heartbeat runs a full repo sync + reconcile per call, and the worker loop
// heartbeats once per task cycle — minutes apart — so 30 per minute tolerates
// a small fleet retrying through one credential while bounding runaway clients.
const RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

export type AgentHeartbeatResponse = {
  status: "ok" | "warning" | "error";
  agentName: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
  warnings: string[];
  errors: string[];
  /**
   * Always empty for heartbeat runs: the sync phase is repo-scoped and has no
   * per-issue URL data, so `AgentRun.touchedIssueUrls` stays URL-only.
   */
  touchedIssueUrls: string[];
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentName: string }> },
): Promise<NextResponse<AgentHeartbeatResponse | { error: string }>> {
  const { agentName } = await params;

  // Authenticate
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`heartbeat:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  // A bound worker credential may only heartbeat for its own agent; an unbound
  // legacy worker token is refused on this identity-scoped route (#1129).
  const scopeError = await enforceWorkerAgentScope(auth, agentName);
  if (scopeError) return scopeError;

  const startedAt = new Date();
  const warnings: string[] = [];
  const errors: string[] = [];

  // --- Sync phase (best-effort) ---
  try {
    const syncResult = await runSyncBestEffort();

    for (const w of syncResult.warnings) warnings.push(`sync: ${w}`);
    for (const e of syncResult.errors) errors.push(`sync: ${e}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    errors.push(`sync: ${message}`);
  }

  // --- Reconciliation phase (best-effort) ---
  try {
    const reconcileResult = await runReconcileBestEffort();

    for (const w of reconcileResult.warnings) warnings.push(`reconcile: ${w}`);
    for (const e of reconcileResult.errors) errors.push(`reconcile: ${e}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown reconcile error";
    errors.push(`reconcile: ${message}`);
  }

  const finishedAt = new Date();

  // Determine overall status
  let status: "ok" | "warning" | "error" = "ok";
  if (errors.length > 0) {
    status = "error";
  } else if (warnings.length > 0) {
    status = "warning";
  }

  // Build summary
  const summaryParts: string[] = [];
  summaryParts.push(`synced issues`);
  summaryParts.push(`${warnings.length} warning(s)`);
  if (errors.length > 0) {
    summaryParts.push(`${errors.length} error(s)`);
  }
  const summary = `Heartbeat completed: ${summaryParts.join(", ")}`;

  // Record AgentRun for the heartbeat pass
  try {
    await prisma.agentRun.create({
      data: {
        agentName,
        runType: "heartbeat",
        status,
        startedAt,
        finishedAt,
        summary,
        // Sync runs have no per-issue URL data; keep the column URL-only.
        touchedIssueUrls: [],
      },
    });
  } catch (error) {
    // Best-effort — don't fail the heartbeat if run recording fails
    console.error("Failed to record AgentRun for heartbeat:", error);
  }

  return NextResponse.json({
    status,
    agentName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    summary,
    warnings,
    errors,
    touchedIssueUrls: [],
  });
}
