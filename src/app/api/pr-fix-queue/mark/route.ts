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

  const limited = enforceRateLimit(`pr-fix-mark:${auth.throttleKey}`, RATE_LIMIT);
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

    // Worker tokens may settle attempts (FIXED/BLOCKED/PARKED/STALE) or defer a
    // consumed generation while waiting on an external prerequisite (WAITING_EXTERNAL):
    // PARKED lets a worker report bounded exhaustion or an operational
    // failure (#1218). Moving an item back to QUEUED or IGNORED changes
    // routing and requires a maintainer token (#1111).
    const WORKER_SETTLE_STATUSES = ["FIXED", "BLOCKED", "PARKED", "STALE", "WAITING_EXTERNAL"];
    if (
      auth.type === "bearer" &&
      auth.tier === "worker" &&
      !WORKER_SETTLE_STATUSES.includes(input.status)
    ) {
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

    // #1430: the bound token's agent identity — never a body/header value
    // (#1322). It binds the idempotent WAITING_EXTERNAL duplicate answer to
    // the agent that actually started the wait; maintainer bearers and
    // operator sessions stay unconstrained, and the legacy unbound worker
    // token (no identity) keeps the pre-#1430 behavior for this replay only.
    const handoutScopedAgent =
      auth.type === "bearer" && auth.tier === "worker" ? auth.agentName : undefined;

    // #1218 review: the mark's commit-time status pin (status === "QUEUED" for
    // BLOCKED/PARKED settlements) must be honored for worker callers — a
    // same-generation second mark cannot erase a recorded human decision.
    // Operators can opt in to reclassify via `allowStickyReclassify`; workers
    // have no equivalent. The tier value is sourced from `auth` here rather
    // than the request body so a worker cannot forge a maintainer tier to
    // bypass the pin. Strip any body-supplied `allowStickyReclassify` for
    // worker requests for defense in depth.
    const actorTier: "worker" | "maintainer" =
      auth.tier === "maintainer" ? "maintainer" : "worker";
    const allowStickyReclassify =
      actorTier === "maintainer" && body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).allowStickyReclassify === true
        : false;

    // Every external wait consumes a handed-out generation, including operator
    // marks, so it must always be fenced. Other operator marks retain legacy behavior.
    if (input.status === "WAITING_EXTERNAL" && (input.expectedGeneration === undefined || input.expectedGeneration === null)) {
      return errorResponse("generation is required for WAITING_EXTERNAL", 400);
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

    const result = await markPrFixItem(asPrFixQueueClient(prisma), {
      ...input,
      actorTier,
      ...(handoutScopedAgent ? { handoutScopedAgent } : {}),
      ...(allowStickyReclassify ? { allowStickyReclassify: true } : {}),
    });
    if (!result.mutated) {
      if (result.reason === "not-handed") {
        // #1430: a hand-out-scoped (bound worker) caller tried to replay a
        // same-generation WAITING_EXTERNAL mark it did not start. Refusal,
        // not an outcome: `reason` lets the worker tell "you may not read/
        // settle this" apart from "the settlement was refused" (the outcome
        // vocabulary stays untouched). No mutation, no success audit row.
        try {
          await prisma.auditLog.create({
            data: {
              actor: auditActor,
              action: "pr_fix_mark",
              repoFullName: input.repo,
              issueNumber: null,
              success: false,
              errorMessage: `Worker ${handoutScopedAgent ?? "unknown"} did not start the external wait on pr-fix item ${input.repo}#${input.pr} at the recorded generation`,
              beforeLabels: [],
              afterLabels: [],
            },
          });
        } catch {
          // Audit log failure should not mask the 403
        }
        return NextResponse.json(
          {
            error: "PR fix queue item external wait was not started by the authenticated agent at that generation",
            reason: "not-handed",
          },
          { status: 403 },
        );
      }
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
        notes: `pr=${input.pr} status=${item.status}${allowStickyReclassify ? " reclassify=true" : ""}${input.note ? ` note=${input.note}` : ""}`,
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
