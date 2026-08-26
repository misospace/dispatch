import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { resolvePrFixFromAgentReport } from "@/lib/pr-fix-queue";

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

  // Resolve issueId from repoFullName + issueNumber
  const issueId = await resolveIssueId(report.repoFullName, report.issueNumber);

  // Build touched URLs
  const touchedIssueUrls = buildTouchedUrls(report);

  // Persist AgentRun
  const now = new Date();
  const run = await prisma.agentRun.create({
    data: {
      agentName,
      runType: report.taskType,
      status: deriveStatus(report.outcome),
      startedAt: now,
      finishedAt: now,
      summary: report.summary,
      errorMessage: report.error,
      touchedIssueUrls,
      issueId,
    },
  });

  // If the report corresponds to a queued pr-fix item, resolve it. Without
  // this, non-bridge agents (anything driven through MCP tools or the generic
  // harness loop) leave the item QUEUED and it is re-served ahead of issue
  // work on every poll. See issue #868.
  const prFixResolution = await resolvePrFixFromAgentReport({
    repoFullName: report.repoFullName,
    pullRequestNumber: report.pullRequestNumber,
    pullRequestUrl: report.pullRequestUrl,
    outcome: report.outcome,
    summary: report.summary,
  });

  return NextResponse.json({
    ok: true,
    agentName,
    report,
    agentRunId: run.id,
    prFixResolution,
  });
}
