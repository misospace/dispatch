import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { getAgentFromLabels, AGENT_PREFIX } from "@/types";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import {
  releaseLeaseByAgentAndIssue,
  releaseAgentWorkByAgentAndIssue,
} from "@/lib/lease";
import { releaseIssueClaim, fencedClaimClient, releaseIssueClaimWorstCaseCalls } from "@/lib/issue-claim";
import { supersedeOwnershipReleaseIntent } from "@/lib/ownership-reconciliation";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withIssueMutationGuard, fencedWriteTimeoutForCalls } from "@/lib/issue-mutation-guard";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

/**
 * The fenced release's transaction budget — DERIVED from the observed labels.
 *
 * The unclaim region carries the shared claim release: the ownership removal
 * (the `agent/*` label) plus, when the resting-status policy applies, a
 * chained `transitionIssueStatus` call — which removes EVERY existing
 * `status/*` label before adding the target (duplicated status labels are a
 * documented data-quality edge case that is real, #1037). The call count is
 * therefore DATA-DEPENDENT, and a fixed multiplier cannot bound it: the
 * release review found six duplicated status labels chaining enough
 * sequential mutating calls to outrun the previous fixed raise. The region's
 * budget is now computed per release with
 * `releaseIssueClaimWorstCaseCalls(issue.labels)` — 1 agent removal + every
 * observed `status/*` label as a potential removal + the target add + the
 * in-review PR read — scaled by `fencedWriteTimeoutForCalls`, so the budget
 * dominates every call sequence the release can issue FOR THIS LABEL SET.
 * An over-bound (the per-call figure includes the once-per-region cold
 * App-token fetch, and the count is branch-blind) is cheaper than a bound a
 * new counterexample can outgrow.
 *
 * The raised budget does NOT make the guard look stealable: a region that
 * runs longer than the override's silence window (`GUARD_OVERRIDE_MIN_AGE_MS`,
 * 5 min) re-stamps the guard row inside its own transaction, right before the
 * commit (see `runFencedRemoteWrite`), so the committed row is FRESH however
 * long the region ran. A maintainer force-claim waiting on the anchor is then
 * told the issue is busy instead of taking the anchor away while this
 * callback is still running. The budget therefore only has to dominate the
 * region's forge calls — it does not have to fit inside the silence window.
 */

/**
 * #1361: the anchor's guard row REFERENCES the issue, so acquiring the anchor
 * for an unknown issue raises a Prisma foreign-key violation (P2003) before
 * the route's own "issue not found" check can run. The structural check keeps
 * the route free of a direct Prisma error-class import.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2003"
  );
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`unclaim:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    if (typeof body !== "object" || body === null) {
      return errorResponse("Invalid JSON body", 400);
    }

    const { issueId, repoFullName: bodyRepoFullName, issueNumber: bodyIssueNumber, agentName } = body as Record<string, unknown>;

    // Validate required fields
    if (!issueId || !bodyRepoFullName || typeof bodyIssueNumber !== "number" || !agentName || typeof agentName !== "string") {
      return errorResponse("Missing required fields: issueId, repoFullName, issueNumber, agentName", 400);
    }

    // A bound worker credential may only release its own claim; an unbound
    // legacy worker token is refused here (#1129).
    const scopeError = await enforceWorkerAgentScope(auth, agentName);
    if (scopeError) return scopeError;

    const agentLabel = `${AGENT_PREFIX}${agentName}` as const;
    const actor = getAuthorizedActor(auth, request, agentName as string);
    const isAgentSelfUnclaim = auth.type === "bearer" && actor === agentName;
    const auditAction = isAgentSelfUnclaim ? "unclaim_issue" : "unclaim_issue_by_operator";

    // #1367: the unclaim path serializes on the per-issue mutation anchor —
    // the same anchor the claim, assign, and unassign paths hold. Its remote
    // ownership write (the `agent/*` label release) previously ran with no
    // anchor at all, so an unclaim in flight could strip the `agent/*` label
    // a maintainer force-claim had just written (the GitHub/cache divergence
    // class #1037/#1361 close for the other routes). The ENTIRE mutation —
    // the issue read and every validation that decides the release — now
    // runs under the anchor, and the remote release itself runs inside the
    // FENCED write, so a guard stolen in the meantime means the forge
    // function is NEVER called and no label is removed.
    const guarded = await withIssueMutationGuard(
      { issueId: issueId as string, operation: "unclaim", agentName: agentName as string },
      async (_tx, { runFencedRemoteWrite }): Promise<{ complete: boolean; value: Response }> => {
        // The audit targets: canonical once the issue is read, the body's
        // values until then (a read failure still audits the attempt).
        let auditRepoFullName = bodyRepoFullName as string;
        let auditIssueNumber = bodyIssueNumber as number;
        let beforeLabels: string[] = [];

        try {
          // Everything that decides the release happens INSIDE the anchor:
          // re-read the issue while this holder still owns it, so the
          // canonical GitHub repo the release targets is the one this holder
          // validated against, never a body-supplied one (#1129 review: a
          // cross-reference mix-up must not strip labels off a foreign
          // issue).
          const issue = await prisma.issue.findUnique({
            where: { id: issueId as string },
            include: { repository: true },
          });

          if (!issue) {
            return { complete: true, value: errorResponse("Issue not found in local cache", 404) };
          }

          // Cross-issue identity invariant: derive canonical repo + number
          // from the loaded DB record and refuse any mismatch before any
          // write.
          const repoFullName = issue.repository.fullName;
          const issueNumber = issue.number;
          auditRepoFullName = repoFullName;
          auditIssueNumber = issueNumber;
          if (
            bodyRepoFullName !== repoFullName ||
            bodyIssueNumber !== issueNumber
          ) {
            return {
              complete: true,
              value: errorResponse(
                `issueId does not match repoFullName/issueNumber; expected ${repoFullName}#${issueNumber}`,
                400,
              ),
            };
          }

          beforeLabels = issue.labels;

          // Refuse closed issues
          if (issue.state === "closed") {
            return { complete: true, value: errorResponse("Cannot unclaim a closed issue", 400) };
          }

          // Refuse done issues
          const currentStatus = issue.labels.find((l) => l.startsWith("status/"));
          if (currentStatus === "status/done") {
            return { complete: true, value: errorResponse("Cannot unclaim a done issue", 400) };
          }

          // Check if the agent is actually assigned
          const currentAgent = getAgentFromLabels(issue.labels);
          if (!currentAgent || currentAgent !== agentLabel) {
            return {
              complete: true,
              value: errorResponse(`Issue is not assigned to ${agentName}`, 400),
            };
          }

          // §8.7 exemption: the owning agent's / an operator's explicit unclaim
          // supersedes a pending reconciler release intent (audited) instead of
          // racing it, then releases through the normal path. Local-only — an
          // intent supersede + audit in one local transaction — and safe under
          // the anchor.
          await supersedeOwnershipReleaseIntent({
            issueId: issueId as string,
            actor,
            reason: `explicit unclaim by ${actor}`,
          });

          // #1254/#1361: the remote release is the unclaim's remote ownership
          // write, so it runs inside the FENCED write: the guard check and
          // the forge writes share one transaction that holds the guard row's
          // lock, so a maintainer force-claim can neither take this holder's
          // guard between the check and the write nor land its own claim
          // while the release is in flight. When the guard is already
          // gone/re-owned the forge function is NEVER called: no label is
          // written, no lease or AgentWork release happens, and the route
          // answers a retryable 409.
          const released = await runFencedRemoteWrite(
            // The release's own local writes (the cache mirror and the
            // `claim_released` evidence row) join the fenced transaction via
            // a THIN client, so the release cannot open a nested interactive
            // transaction inside the region (#1254).
            async (tx) =>
              releaseIssueClaim({
                prisma: fencedClaimClient(tx),
                issue,
                repoFullName,
                issueNumber,
                agentName: agentName as string,
                options: { actor },
              }),
            {
              // The budget is DERIVED from the observed label set and
              // dominates the release's data-dependent call sequence — the
              // ownership removal plus every `status/*` label a chained
              // resting-status transition can remove, the target add, and the
              // in-review PR read (see the module comment). The budget must
              // cover the calls: a mid-region abort would release the guard
              // row's lock with a remote effect still in flight.
              timeoutMs: fencedWriteTimeoutForCalls(
                releaseIssueClaimWorstCaseCalls(issue.labels),
              ),
            },
          );

          if (released.status === "guard-lost") {
            // #1254: the guard-loss path records a failure audit — the
            // skipped unclaim must be visible, not silent — and answers with
            // a retryable 409. Best-effort: a failing audit write must not
            // mask the 409. No lease/AgentWork release: no remote effect
            // happened, so no local release may imply one did.
            try {
              await prisma.auditLog.create({
                data: {
                  actor,
                  action: auditAction,
                  repoFullName,
                  issueNumber,
                  issueId: issueId as string,
                  beforeLabels: issue.labels,
                  afterLabels: [],
                  success: false,
                  errorMessage: "Unclaim was superseded by an operator override before the remote claim release",
                },
              });
            } catch {
              // Audit log failure should not mask the real error
            }
            return {
              complete: true,
              value: errorResponse(
                "Unclaim was superseded by an operator override before the remote claim release; retry shortly",
                409,
              ),
            };
          }

          const updatedLabels = released.value.labels;
          const statusNote = released.value.statusNote;
          const releasedStatus = released.value.status;

          // Release the durable lease after GitHub and the local cache agree.
          await releaseLeaseByAgentAndIssue(agentName as string, issueId as string);

          // For the operator path, also release any AgentWork records for this
          // agent+issue (mark them RELEASED and write a released_by_operator
          // history entry). The agent self-unclaim path doesn't need this
          // because the agent is releasing its own claim.
          if (!isAgentSelfUnclaim) {
            await releaseAgentWorkByAgentAndIssue(agentName as string, issueId as string);
          }

          // Write audit log
          await prisma.auditLog.create({
            data: {
              actor,
              action: auditAction,
              repoFullName,
              issueNumber,
              issueId: issueId as string,
              beforeLabels: issue.labels,
              afterLabels: updatedLabels,
              notes: isAgentSelfUnclaim ? null : `Released agent ${agentName} as ${actor}`,
              success: true,
            },
          });

          return {
            complete: true,
            value: NextResponse.json({
              success: true,
              labels: updatedLabels,
              status: releasedStatus,
              statusNote,
            }),
          };
        } catch (error) {
          // #1361: the failure is caught INSIDE the callback. A rethrown
          // error would demote the guard row to `executing: false`, and no
          // other writer can resume an `unclaim` guard — that would wedge the
          // issue for every writer (claims included). Catching here releases
          // the guard instead.
          const errorMessage = error instanceof Error ? error.message : "Unknown error";

          try {
            await prisma.auditLog.create({
              data: {
                actor,
                action: auditAction,
                repoFullName: auditRepoFullName,
                issueNumber: auditIssueNumber,
                issueId: issueId as string,
                beforeLabels,
                afterLabels: [],
                success: false,
                errorMessage,
              },
            });
          } catch {
            // Audit log failure should not mask the real error
          }

          return { complete: true, value: errorResponse(errorMessage, 500) };
        }
      },
    );

    if (guarded.status === "busy") {
      // Another writer holds the anchor (a claim in flight, a release, a
      // groom move): the unclaim did not run at all — retryable, no audit row.
      return errorResponse("Issue mutation is in progress; retry shortly", 409);
    }
    return guarded.value;
  } catch (error) {
    // #1361: the anchor's guard row references the issue, so acquiring the
    // anchor for an unknown issue raises a foreign-key violation before the
    // route's own "issue not found" check can run. The route's documented
    // answer for a missing issue is 404 — map it back instead of leaking a
    // 500 for a request the caller got wrong.
    if (isForeignKeyViolation(error)) {
      return errorResponse("Issue not found in local cache", 404);
    }
    console.error("Unclaim issue failed:", error);
    return errorResponse("Failed to unclaim issue", 500);
  }
}
