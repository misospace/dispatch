import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { resolvePrFixFromAgentReport, type ResolvePrFixFromAgentReportResult } from "@/lib/pr-fix-queue";

const VALID_TASK_TYPES = ["implement", "followup-pr", "groom"] as const;
type ValidTaskType = (typeof VALID_TASK_TYPES)[number];

const VALID_OUTCOMES = [
  "pr_opened",
  "pr_updated",
  "issue_updated",
  "issue_closed",
  "blocked",
  "failed",
  "no_changes_needed",
] as const;
type ValidOutcome = (typeof VALID_OUTCOMES)[number];

export interface TaskReportBody {
  taskType: ValidTaskType;
  outcome: ValidOutcome;
  repoFullName?: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  summary?: string;
  error?: string;
}

function deriveStatus(outcome: ValidOutcome): string {
  if (outcome === "failed") return "failed";
  if (outcome === "blocked") return "blocked";
  return "completed";
}

async function resolveIssueId(
  repoFullName: string | undefined,
  issueNumber: number | undefined,
): Promise<string | null> {
  if (!repoFullName || issueNumber === undefined) return null;

  const repo = await prisma.repository.findUnique({
    where: { fullName: repoFullName },
    select: { id: true },
  });

  if (!repo) return null;

  const issue = await prisma.issue.findUnique({
    where: { repositoryId_number: { repositoryId: repo.id, number: issueNumber } },
    select: { id: true },
  });

  return issue?.id ?? null;
}

function buildTouchedUrls(
  report: TaskReportBody,
): string[] {
  const urls: string[] = [];

  if (report.repoFullName && report.issueNumber !== undefined) {
    urls.push(`https://github.com/${report.repoFullName}/issues/${report.issueNumber}`);
  }

  if (report.pullRequestUrl) {
    urls.push(report.pullRequestUrl);
  } else if (report.repoFullName && report.pullRequestNumber !== undefined) {
    urls.push(`https://github.com/${report.repoFullName}/pull/${report.pullRequestNumber}`);
  }

  return urls;
}

/**
 * Deterministic JSON for report payload comparison: object keys sorted,
 * `undefined` entries omitted. Two reports that differ only in key order or
 * in explicitly-undefined optional fields hash identically.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function reportPayloadHash(report: TaskReportBody): string {
  return createHash("sha256").update(canonicalJson(report)).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentName: string }> },
) {
  const { agentName } = await params;

  // Authenticate
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("Invalid JSON body", 400);
  }

  const raw = body as Record<string, unknown>;

  const taskType = raw.taskType;
  if (typeof taskType !== "string" || !VALID_TASK_TYPES.includes(taskType as ValidTaskType)) {
    return errorResponse(`Invalid taskType. Must be one of: ${VALID_TASK_TYPES.join(", ")}`, 400);
  }

  const outcome = raw.outcome;
  if (typeof outcome !== "string" || !VALID_OUTCOMES.includes(outcome as ValidOutcome)) {
    return errorResponse(`Invalid outcome. Must be one of: ${VALID_OUTCOMES.join(", ")}`, 400);
  }

  if (raw.issueNumber !== undefined && (typeof raw.issueNumber !== "number" || !Number.isInteger(raw.issueNumber))) {
    return errorResponse("issueNumber must be an integer", 400);
  }

  if (raw.pullRequestNumber !== undefined && (typeof raw.pullRequestNumber !== "number" || !Number.isInteger(raw.pullRequestNumber))) {
    return errorResponse("pullRequestNumber must be an integer", 400);
  }

  const stringFields: readonly string[] = ["repoFullName", "pullRequestUrl", "summary", "error"];
  for (const field of stringFields) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") {
      return errorResponse(`${field} must be a string`, 400);
    }
  }

  // Optional worker-chosen opaque key. Present → the report becomes
  // idempotently retryable; absent → current at-least-once behavior (#1044).
  // Trimmed and capped so the unique index cannot be abused with unbounded
  // key material; otherwise fully opaque to Dispatch.
  const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
  const rawIdempotencyKey = raw.idempotencyKey;
  if (rawIdempotencyKey !== undefined && typeof rawIdempotencyKey !== "string") {
    return errorResponse("idempotencyKey must be a non-empty string", 400);
  }
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : undefined;
  if (idempotencyKey !== undefined && idempotencyKey.length === 0) {
    return errorResponse("idempotencyKey must be a non-empty string", 400);
  }
  if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return errorResponse(`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, 400);
  }

  const report: TaskReportBody = {
    taskType: taskType as ValidTaskType,
    outcome: outcome as ValidOutcome,
    repoFullName: raw.repoFullName as string | undefined,
    issueNumber: raw.issueNumber as number | undefined,
    pullRequestNumber: raw.pullRequestNumber as number | undefined,
    pullRequestUrl: raw.pullRequestUrl as string | undefined,
    summary: raw.summary as string | undefined,
    error: raw.error as string | undefined,
  };

  try {
    // Resolve issueId from repoFullName + issueNumber
    const issueId = await resolveIssueId(report.repoFullName, report.issueNumber);

    // Build touched URLs
    const touchedIssueUrls = buildTouchedUrls(report);

    // Persist AgentRun
    const now = new Date();
    const runData = {
      agentName,
      runType: report.taskType,
      status: deriveStatus(report.outcome),
      startedAt: now,
      finishedAt: now,
      summary: report.summary,
      errorMessage: report.error,
      touchedIssueUrls,
      issueId,
    };

    let run: { id: string };
    let duplicate = false;
    let storedResolution: ResolvePrFixFromAgentReportResult | undefined;

    if (typeof idempotencyKey === "string") {
      // Idempotent reporting (#1044): claim the key and create the AgentRun in
      // ONE transaction, so a committed claim always carries its result. A
      // concurrent or retried report with the same (agentName, idempotencyKey)
      // loses the unique-index race (P2002) and replays the stored result
      // instead of re-running the report or its side effects.
      const payloadHash = reportPayloadHash(report);
      try {
        run = await prisma.$transaction(async (tx) => {
          const claim = await tx.agentReportDedupe.create({
            data: { agentName, idempotencyKey, payloadHash },
          });
          const created = await tx.agentRun.create({ data: runData });
          await tx.agentReportDedupe.update({
            where: { id: claim.id },
            data: { agentRunId: created.id },
          });
          return created;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await prisma.agentReportDedupe.findUnique({
          where: { agentName_idempotencyKey: { agentName, idempotencyKey } },
        });
        if (!existing) throw error;
        if (existing.payloadHash !== payloadHash) {
          return errorResponse(
            `idempotencyKey was already used with a different report payload for agent ${agentName}`,
            409,
          );
        }
        if (!existing.agentRunId) {
          // Unreachable while the claim and the AgentRun commit together; guard
          // against a half-written claim from any future refactor.
          return errorResponse("idempotencyKey is claimed but has no recorded result", 409);
        }
        duplicate = true;
        run = { id: existing.agentRunId };
        storedResolution =
          (existing.prFixResolution as ResolvePrFixFromAgentReportResult | null) ?? undefined;
      }
    } else {
      run = await prisma.agentRun.create({ data: runData });
    }

    let prFixResolution: ResolvePrFixFromAgentReportResult;
    if (duplicate) {
      // Never re-run side effects for an already-processed key. Replay the
      // stored resolution when available; otherwise report an explicit skip.
      prFixResolution = storedResolution ?? {
        matched: true,
        action: "skipped",
        itemId: null,
        reason: "duplicate report (idempotency key already processed); PR-fix resolution not re-run",
      };
    } else {
      // If the report corresponds to a queued pr-fix item, resolve it. Without
      // this, non-bridge agents (anything driven through MCP tools or the generic
      // harness loop) leave the item QUEUED and it is re-served ahead of issue
      // work on every poll. See issue #868.
      prFixResolution = await resolvePrFixFromAgentReport({
        repoFullName: report.repoFullName,
        pullRequestNumber: report.pullRequestNumber,
        pullRequestUrl: report.pullRequestUrl,
        outcome: report.outcome,
        summary: report.summary,
      });
      if (typeof idempotencyKey === "string") {
        // Persist the resolution before responding so a retry replays the real
        // result rather than the skip marker. This runs after the claim/run
        // transaction and is awaited: a failure surfaces as a 5xx on THIS
        // response, and the worker's retry then takes the duplicate branch
        // (same agentRunId, skip marker) — side effects are never re-run either
        // way. It cannot move inside the claim transaction because the
        // resolver makes GitHub round-trips and itself opens transactions.
        await prisma.agentReportDedupe.update({
          where: { agentName_idempotencyKey: { agentName, idempotencyKey } },
          data: { prFixResolution: prFixResolution as unknown as Prisma.InputJsonValue },
        });
      }
    }

    return NextResponse.json({
      ok: true,
      agentName,
      report,
      agentRunId: run.id,
      prFixResolution,
      ...(duplicate ? { duplicate: true } : {}),
    });
  } catch (error) {
    // An unexpected failure after validation (DB write, idempotency claim,
    // resolution persistence) must surface as a structured 5xx, not an
    // unhandled rejection — a worker retrying after a 5xx relies on the
    // idempotency key to land in the duplicate branch.
    return handleApiError("report task", error);
  }
}
