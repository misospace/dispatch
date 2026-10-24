import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { updateIssueLabels } from "@/lib/github";
import { getLiveIssueLabels } from "@/lib/claim-gate";
import { buildUnassignedLabels, getAgentLabels, getOwnerLabels } from "@/lib/assignment-conflicts";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withIssueMutationGuard } from "@/lib/issue-mutation-guard";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 } as const;

type UnassignPayload = {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  action: "unassign_agent" | "unassign_owner";
};

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

/**
 * POST /api/issues/unassign
 * Removes the agent or owner assignment from an issue.
 * - unassign_agent: removes all agent/* labels
 * - unassign_owner: removes all owner/* labels
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  const auditActor = getAuthorizedActor(auth, request);

  const limited = enforceRateLimit(`route:issues/unassign:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  // Captured once the payload is validated so the catch below can name the
  // issue in its 404 response (the anchor's foreign-key failure carries no
  // issue id of its own).
  let issueIdForErrors: string | null = null;

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

    const payload = body as UnassignPayload;

    if (
      !payload.action ||
      typeof payload.issueId !== "string" ||
      payload.issueId.length === 0 ||
      typeof payload.repoFullName !== "string" ||
      payload.repoFullName.length === 0 ||
      typeof payload.issueNumber !== "number"
    ) {
      return errorResponse("Missing required fields: action, issueId, repoFullName, issueNumber", 400);
    }

    issueIdForErrors = payload.issueId;

    if (payload.action !== "unassign_agent" && payload.action !== "unassign_owner") {
      return errorResponse(`Invalid action: ${payload.action}. Allowed: unassign_agent, unassign_owner`, 400);
    }

    // #1361: the unassign path serializes on the per-issue mutation anchor —
    // the same anchor the claim and assign paths hold. `updateIssueLabels` is a
    // FULL-label-set PUT (it replaces ALL labels), so the set it writes is a
    // snapshot taken before the write: a stale snapshot strips every label
    // another writer added in the meantime — including the `agent/*` label a
    // maintainer force-claim owns (the GitHub/cache divergence class #1037
    // fights). Under the anchor the snapshot is taken while this holder still
    // owns the issue, and the remote write itself runs inside the FENCED
    // write, so a guard that was stolen in the meantime means the forge
    // function is NEVER called and no label is removed.
    const guarded = await withIssueMutationGuard(
      { issueId: payload.issueId, operation: "unassign" },
      async (_tx, { runFencedRemoteWrite }): Promise<{ complete: boolean; value: Response }> => {
        // The audit targets: canonical once the issue is read, the body's
        // values until then (a read failure still audits the attempt).
        let auditRepoFullName = payload.repoFullName;
        let auditIssueNumber = payload.issueNumber;
        let currentLabels: string[] = [];

        try {
          // Everything that decides the new label set happens INSIDE the
          // anchor: the snapshot the remote write applies must be taken under
          // the anchor, not before it.
          const issue = await prisma.issue.findUnique({
            where: { id: payload.issueId },
            include: { repository: true },
          });
          if (!issue) {
            return { complete: true, value: errorResponse(`Issue not found: ${payload.issueId}`, 404) };
          }

          // Cross-issue identity invariant (#1129 review, mirrored here): the
          // anchor is per issue, so the fenced remote write must target the
          // ANCHOR's issue, never an arbitrary body-supplied one. Derive the
          // canonical repo/number from the loaded DB record and reject any
          // mismatch BEFORE any write, so a caller cannot strip labels on a
          // foreign issue while unassigning this one.
          const repoFullName = issue.repository.fullName;
          const issueNumber = issue.number;
          auditRepoFullName = repoFullName;
          auditIssueNumber = issueNumber;
          if (payload.repoFullName !== repoFullName || payload.issueNumber !== issueNumber) {
            return {
              complete: true,
              value: errorResponse(
                `issueId does not match repoFullName/issueNumber; expected ${repoFullName}#${issueNumber}`,
                400,
              ),
            };
          }

          // The cached row is the audit baseline until the live read lands.
          currentLabels = issue.labels;

          // #1366: `updateIssueLabels` is a FULL-label-set PUT, so the set it
          // writes must be derived from the labels GitHub CURRENTLY has, not
          // the Prisma cache — a label added on GitHub since the last sync
          // would be silently stripped by the snapshot (the same rule
          // issue-claim.ts states and the sibling assign route (#1037) obeys).
          // The read happens INSIDE the anchor, so the snapshot the fenced PUT
          // applies is the one taken while this holder owns the issue. Fail
          // closed when GitHub is unreachable: no remote write, no cache
          // write, a failure audit row, and a 503 — the route could not have
          // succeeded without GitHub anyway (the PUT needs it), so the live
          // read costs no availability.
          let liveLabels: string[];
          try {
            liveLabels = await getLiveIssueLabels(repoFullName, issueNumber);
          } catch (error) {
            const liveReadMessage = error instanceof Error ? error.message : "Unknown error";

            // Failed audit entry, consistent with the assign route's live-read
            // failure shape. Best-effort: a failing audit write must not mask
            // the 503.
            try {
              await prisma.auditLog.create({
                data: {
                  actor: auditActor,
                  action: payload.action,
                  repoFullName,
                  issueNumber,
                  issueId: payload.issueId,
                  beforeLabels: currentLabels,
                  afterLabels: [],
                  success: false,
                  errorMessage: `Could not verify live GitHub labels: ${liveReadMessage}`,
                },
              });
            } catch {
              // Audit log failure should not mask the real error
            }

            return {
              complete: true,
              value: errorResponse(`Could not verify live GitHub labels: ${liveReadMessage}`, 503),
            };
          }
          currentLabels = liveLabels;

          // Use shared conflict resolution module for both removal detection and label update
          const labelsToRemove = payload.action === "unassign_agent"
            ? getAgentLabels(currentLabels)
            : getOwnerLabels(currentLabels);

          if (labelsToRemove.length === 0) {
            return { complete: true, value: errorResponse(`No ${payload.action === "unassign_agent" ? "agent" : "owner"} label found on this issue`, 400) };
          }

          const newLabels = buildUnassignedLabels(currentLabels, payload.action);

          // #1254/#1361: the remote label write runs inside the FENCED write.
          // The fence makes the guard check and the write ONE step (the guard
          // row's lock is held across the write), so when the guard is already
          // gone or re-owned the forge function is NEVER called and no remote
          // label set is stripped.
          const written = await runFencedRemoteWrite(async () => {
            // Update GitHub labels
            await updateIssueLabels(repoFullName, issueNumber, newLabels);
            return true;
          });
          if (written.status === "guard-lost") {
            // #1254: the guard-loss path records a failure audit — the skipped
            // unassignment must be visible, not silent — and answers with a
            // retryable 409. Best-effort: a failing audit write must not mask
            // the 409.
            try {
              await prisma.auditLog.create({
                data: {
                  actor: auditActor,
                  action: payload.action,
                  repoFullName,
                  issueNumber,
                  issueId: payload.issueId,
                  beforeLabels: currentLabels,
                  afterLabels: [],
                  success: false,
                  errorMessage: "Unassign was superseded by an operator override before the remote label write",
                },
              });
            } catch {
              // Audit log failure should not mask the real error
            }
            return {
              complete: true,
              value: errorResponse(
                "Unassign was superseded by an operator override before the remote label write; retry shortly",
                409,
              ),
            };
          }

          // Update local cache
          await prisma.issue.update({
            where: { id: payload.issueId },
            data: { labels: newLabels, lastSyncedAt: new Date() },
          });

          // Write audit log
          await prisma.auditLog.create({
            data: {
              actor: auditActor,
              action: payload.action,
              repoFullName,
              issueNumber,
              issueId: payload.issueId,
              beforeLabels: currentLabels,
              afterLabels: newLabels,
              success: true,
            },
          });

          return { complete: true, value: NextResponse.json({ success: true, labels: newLabels, removed: labelsToRemove }) };
        } catch (error) {
          // #1361: the failure is caught INSIDE the callback. A rethrown
          // error would demote the guard row to `executing: false`, and no
          // other writer can resume an `unassign` guard — that would wedge the
          // issue for every writer (claims included). Catching here releases
          // the guard instead.
          const errorMessage = error instanceof Error ? error.message : "Unknown error";

          try {
            await prisma.auditLog.create({
              data: {
                actor: auditActor,
                action: payload.action,
                repoFullName: auditRepoFullName,
                issueNumber: auditIssueNumber,
                issueId: payload.issueId,
                beforeLabels: currentLabels,
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
      // Another writer holds the anchor (a claim in flight, an assign, a
      // release): the unassign did not run at all — retryable, no audit row.
      return errorResponse("Issue mutation is in progress; retry shortly", 409);
    }
    return guarded.value;
  } catch (error) {
    // #1361: the anchor's guard row references the issue, so acquiring the
    // anchor for an unknown issue raises a foreign-key violation before the
    // route's own "issue not found" check can run. The route's documented
    // answer for a missing issue is 404 — map it back instead of leaking a
    // 500 for a request the caller got wrong.
    if (issueIdForErrors !== null && isForeignKeyViolation(error)) {
      return errorResponse(`Issue not found: ${issueIdForErrors}`, 404);
    }
    console.error("Unassign action failed:", error);
    return errorResponse("Failed to process unassign", 500);
  }
}
