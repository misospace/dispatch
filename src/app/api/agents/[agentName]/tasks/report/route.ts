import { NextResponse } from "next/server";

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentName: string }> },
) {
  const { agentName } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;

  const taskType = raw.taskType;
  if (typeof taskType !== "string" || !VALID_TASK_TYPES.includes(taskType as ValidTaskType)) {
    return NextResponse.json(
      { error: `Invalid taskType. Must be one of: ${VALID_TASK_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  const outcome = raw.outcome;
  if (typeof outcome !== "string" || !VALID_OUTCOMES.includes(outcome as ValidOutcome)) {
    return NextResponse.json(
      { error: `Invalid outcome. Must be one of: ${VALID_OUTCOMES.join(", ")}` },
      { status: 400 },
    );
  }

  if (raw.issueNumber !== undefined && (typeof raw.issueNumber !== "number" || !Number.isInteger(raw.issueNumber))) {
    return NextResponse.json(
      { error: "issueNumber must be an integer" },
      { status: 400 },
    );
  }

  if (raw.pullRequestNumber !== undefined && (typeof raw.pullRequestNumber !== "number" || !Number.isInteger(raw.pullRequestNumber))) {
    return NextResponse.json(
      { error: "pullRequestNumber must be an integer" },
      { status: 400 },
    );
  }

  const stringFields: readonly string[] = ["repoFullName", "pullRequestUrl", "summary", "error"];
  for (const field of stringFields) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") {
      return NextResponse.json(
        { error: `${field} must be a string` },
        { status: 400 },
      );
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

  return NextResponse.json({
    ok: true,
    agentName,
    report,
  });
}
