import { NextResponse } from "next/server";
import { errorResponse, readJsonObjectBody } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { enqueuePrFixItem, parseEnqueuePrFixInput } from "@/lib/pr-fix-queue";
import { isHeadRepoOfBaseRepo } from "@/lib/pr-followup-ingestion";
import { fetchPullRequestHeadRepo } from "@/lib/github-prs";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`pr-fix-enqueue:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  const auditActor = getAuthorizedActor(auth, request);

  try {
    const parsed = await readJsonObjectBody(request);
    if ("error" in parsed) return parsed.error;

    const input = parseEnqueuePrFixInput(parsed.body);
    if ("error" in input) return errorResponse(input.error, 400);

    // #1638: the queue-wide head-repo invariant. A fork PR's head branch lives
    // on the fork, where the fix worker (which operates on the base repo) can
    // never push — a fork row can only ever hold undispatchable work. Same
    // fail-closed rule as the shared #1637 predicate (whose ingestion
    // call-site wiring lands in that issue's own PR): refuse when the head
    // repository differs from the base repo, and refuse outright when it
    // cannot be verified at all. The proof comes from the forge, never from
    // the request body — a caller-supplied head repo would prove nothing.
    const headRepo = await fetchPullRequestHeadRepo(input.repo, input.pr);
    if (headRepo === null) {
      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: "pr_fix_enqueue",
          repoFullName: input.repo,
          issueNumber: input.issue ?? null,
          success: false,
          errorMessage: "PR head repository unverifiable (#1638)",
          beforeLabels: [],
          afterLabels: [],
          notes: `pr=${input.pr} refusal=head-repo-unverifiable`,
        },
      });
      return errorResponse(
        "Could not verify the PR head repository against the base repository; refusing to enqueue fix work for an unverifiable PR (#1638)",
        503,
      );
    }
    if (!isHeadRepoOfBaseRepo(headRepo, input.repo)) {
      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: "pr_fix_enqueue",
          repoFullName: input.repo,
          issueNumber: input.issue ?? null,
          success: false,
          errorMessage: `PR head repository ${headRepo} is not the base repository (#1638)`,
          beforeLabels: [],
          afterLabels: [],
          notes: `pr=${input.pr} refusal=fork-head-repo head=${headRepo}`,
        },
      });
      return errorResponse(
        `Refusing to enqueue: PR head repository ${headRepo} differs from the base repository — fork PR fix work is never dispatchable (#1638)`,
        409,
      );
    }

    const item = await enqueuePrFixItem(asPrFixQueueClient(prisma), input);
    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_enqueue",
        repoFullName: input.repo,
        issueNumber: input.issue ?? null,
        success: true,
        beforeLabels: [],
        afterLabels: [],
        notes: `pr=${input.pr} lane=${item.lane} reason=${input.reason}`,
      },
    });

    return NextResponse.json(item);
  } catch (error) {
    console.error("Failed to enqueue PR fix item:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_enqueue",
        repoFullName: "unknown",
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return errorResponse("Failed to enqueue PR fix item", 500);
  }
}
