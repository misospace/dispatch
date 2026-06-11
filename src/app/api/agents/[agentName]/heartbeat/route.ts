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
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { runSyncBestEffort, runReconcileBestEffort } from "@/lib/heartbeat";

export type AgentHeartbeatResponse = {
  status: "ok" | "warning" | "error";
  agentName: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
  warnings: string[];
  errors: string[];
  touchedIssueUrls: string[];
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentName: string }> },
): Promise<NextResponse<AgentHeartbeatResponse | { error: string }>> {
  const { agentName } = await params;

  // Authenticate
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  const warnings: string[] = [];
  const errors: string[] = [];
  const touchedIssueUrlsSet = new Set<string>();

  // --- Sync phase (best-effort) ---
  try {
    const syncResult = await runSyncBestEffort();

    for (const w of syncResult.warnings) warnings.push(`sync: ${w}`);
    for (const e of syncResult.errors) errors.push(`sync: ${e}`);

    // Collect touched issue URLs from synced repos
    if (syncResult.touchedIssueUrls.length > 0) {
      for (const url of syncResult.touchedIssueUrls) {
        touchedIssueUrlsSet.add(url);
      }
    }
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
  const touchedIssueUrls = Array.from(touchedIssueUrlsSet);

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
        touchedIssueUrls,
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
    touchedIssueUrls,
  });
}
