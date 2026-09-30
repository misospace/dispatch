import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { markPrFixItem, parseMarkPrFixInput, isPrFixRepoArchived } from "@/lib/pr-fix-queue";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchPullRequestMergeState } from "@/lib/github-prs";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`pr-fix-mark:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  const auditActor = getAuthorizedActor(auth, request);

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    const input = parseMarkPrFixInput(body);
    if ("error" in input) return errorResponse(input.error, 400);

    // Worker tokens may only settle attempts (FIXED/BLOCKED/STALE): moving
    // an item back to QUEUED or IGNORED changes routing and requires a
    // maintainer token (#1111).
    if ((input.status === "QUEUED" || input.status === "IGNORED") && auth.type === "bearer" && auth.tier === "worker") {
      try {
        await prisma.auditLog.create({
          data: {
            actor: auditActor,
            action: "pr_fix_mark",
            repoFullName: input.repo,
            issueNumber: null,
            success: false,
            errorMessage: "Marking an item QUEUED or IGNORED requires a maintainer token",
            beforeLabels: [],
            afterLabels: [],
          },
        });
      } catch {
        // Audit log failure should not mask the 403
      }
      return errorResponse("Marking an item QUEUED or IGNORED requires a maintainer token", 403);
    }

    // #1074: bearer (agent/bridge) marks must settle a specific attempt, so
    // the generation token is required. Operator paths (oidc session, basic,
    // disabled) keep the optional behavior for compatibility.
    if (auth.type === "bearer" && input.expectedGeneration === undefined) {
      return errorResponse("generation is required for agent/bridge marks (#1074)", 400);
    }

    // A mark back to QUEUED dispatches a worker; refuse it for an archived
    // repo, which no worker can push to (#1106).
    if (input.status === "QUEUED" && (await isPrFixRepoArchived(input.repo))) {
      return errorResponse("Cannot requeue: repository is archived", 409);
    }

    // #1121: an already-addressed settlement asserts the feedback was handled
    // with no push. The tasks/report path only settles it once the PR is
    // verified mergeable; enforce the same gate here so the two documented
    // entry points cannot give the same settlement different safety
    // properties — a red/conflicting PR must never be tombstoned off an
    // already_addressed assertion. Scope is narrow: only already-addressed
    // FIXED marks; plain FIXED marks keep the #940 head-moved guard as before.
    if (input.status === "FIXED" && input.alreadyAddressed) {
      let mergeable: boolean | null;
      let mergeableState: string | null;
      try {
        const state = await fetchPullRequestMergeState(input.repo, input.pr);
        mergeable = state.mergeable;
        mergeableState = state.mergeableState;
      } catch (error) {
        console.error(
          `pr-fix-queue mark: merge state check failed for ${input.repo}#${input.pr}:`,
          error instanceof Error ? error.message : error,
        );
        // Defer rather than guess, matching the tasks/report resolver, which
        // leaves the item queued for a later reconcile instead of tombstoning
        // a PR whose state it could not read.
        return errorResponse(
          "Cannot settle already_addressed: PR merge state could not be verified; retry later",
          503,
        );
      }
      if (mergeable === null) {
        // GitHub has not computed merge state yet, or is unreachable (the
        // helper returns null for both). Defer with a retry-later signal so a
        // transient unknown never reads as a terminal verdict on this route;
        // only a genuinely unmergeable PR below gets a terminal 409.
        return errorResponse(
          "Cannot settle already_addressed: PR merge state not yet available; retry later",
          503,
        );
      }
      if (mergeable !== true) {
        // Genuinely unmergeable (CONFLICTING, DIRTY, BLOCKED, ...): refuse.
        return errorResponse(
          `Cannot settle already_addressed: PR is not mergeable (mergeable_state=${mergeableState ?? "unknown"})`,
          409,
        );
      }
    }

    const result = await markPrFixItem(asPrFixQueueClient(prisma), input);
    if (!result.mutated) {
      if (result.reason === "generation-mismatch") {
        // The item moved to a newer attempt between the caller's read and
        // this write. Conflict, not an error: no mutation happened.
        return errorResponse(
          `PR fix queue item generation mismatch: expected generation ${input.expectedGeneration} did not match the item's current generation`,
          409,
        );
      }
      return errorResponse("PR fix queue item not found", 404);
    }
    const item = result.item;

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_mark",
        repoFullName: input.repo,
        issueNumber: null,
        success: true,
        beforeLabels: [],
        afterLabels: [],
        notes: `pr=${input.pr} status=${item.status}${input.note ? ` note=${input.note}` : ""}`,
      },
    });

    return NextResponse.json(item);
  } catch (error) {
    console.error("Failed to mark PR fix queue item:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_mark",
        repoFullName: "unknown",
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return errorResponse("Failed to mark PR fix queue item", 500);
  }
}
