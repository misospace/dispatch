import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { runHostedGroomer } from "@/lib/groomer/run";
import { getHostedGroomerConfig } from "@/lib/groomer/config";

export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const config = getHostedGroomerConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Hosted groomer is disabled. Set DISPATCH_HOSTED_GROOMER_ENABLED=true to enable." },
      { status: 503 },
    );
  }

  try {
    const result = await runHostedGroomer({
      dryRun: typeof body.dryRun === "boolean" ? body.dryRun : undefined,
      repoFullName: typeof body.repoFullName === "string" ? body.repoFullName : undefined,
      issueNumber: typeof body.issueNumber === "number" && Number.isInteger(body.issueNumber)
        ? body.issueNumber
        : undefined,
      force: typeof body.force === "boolean" ? body.force : undefined,
    });

    if (!result) {
      return NextResponse.json({ candidateNumber: null, dryRun: config.dryRun });
    }

    return NextResponse.json({
      candidateNumber: result.candidateNumber,
      repoFullName: result.repoFullName,
      dryRun: result.dryRun,
      output: result.output,
      plannedLabels: result.plannedLabels,
    });
  } catch (error) {
    console.error("Hosted groomer run failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
