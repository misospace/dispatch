import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface IssueMutationRequest {
  issueId: string;
  operation: string;
  agentName?: string;
  claimToken?: string;
}

export interface IssueMutationContext { resuming: boolean }
export type IssueMutationResult<T> =
  | { status: "busy"; ownerToken: string; operation: string }
  | { status: "completed"; value: T }
  | { status: "retained"; ownerToken: string; value: T };

/** A committed guard is a fail-closed executor fence; it is never time-expired. */
export async function withIssueMutationGuard<T>(
  request: IssueMutationRequest,
  callback: (tx: Prisma.TransactionClient | undefined, context: IssueMutationContext) => Promise<{ complete: boolean; value: T }>,
): Promise<IssueMutationResult<T>> {
  const ownerToken = crypto.randomUUID();
  let created = false;
  try {
    await prisma.issueMutationGuard.create({ data: { ...request, ownerToken, executing: true } });
    created = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) && (typeof error !== "object" || error === null || !("code" in error))) throw error;
    if ((error as { code?: string }).code !== "P2002") throw error;
  }

  let guard = created ? await prisma.issueMutationGuard.findUnique({ where: { issueId: request.issueId } }) : null;
  let resuming = false;
  if (!created) {
    guard = await prisma.issueMutationGuard.findUnique({ where: { issueId: request.issueId } });
    if (!guard) return { status: "busy", ownerToken, operation: request.operation };
    const exactRelease = request.operation === "capacity-release" && guard.operation === request.operation
      && request.agentName !== undefined && request.claimToken !== undefined
      && guard.agentName === request.agentName && guard.claimToken === request.claimToken;
    const exactClaim = request.operation === "claim" && guard.operation === "claim"
      && request.agentName !== undefined && guard.agentName === request.agentName;
    // #1251: the stale-work sweep fences its whole decide-and-release pipeline
    // under this operation. Its recovery path is the next sweep: every step is
    // a conditional update keyed off the persisted row state (STALE + the
    // pending-release marker) and the external release is deduped per claim
    // epoch, so re-entering after a crash mid-guard is safe. A guard left
    // `executing` by a dead sweep process stays fail-closed (never
    // time-expired) exactly like a crashed claim guard: operator-visible, not
    // silently stolen.
    const exactStaleRelease = request.operation === "stale-release" && guard.operation === "stale-release"
      && request.agentName !== undefined && guard.agentName === request.agentName;
    if ((!exactRelease && !exactClaim && !exactStaleRelease) || guard.executing) return { status: "busy", ownerToken: guard.ownerToken, operation: guard.operation };
    const acquired = await prisma.issueMutationGuard.updateMany({
      where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: false }, data: { executing: true },
    });
    if (!acquired.count) return { status: "busy", ownerToken: guard.ownerToken, operation: guard.operation };
    resuming = true;
  }
  if (!guard) return { status: "busy", ownerToken, operation: request.operation };

  try {
    const result = await callback(undefined, { resuming });
    if (result.complete) {
      await prisma.issueMutationGuard.deleteMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true } });
      return { status: "completed", value: result.value };
    }
    await prisma.issueMutationGuard.updateMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true }, data: { executing: false } });
    return { status: "retained", ownerToken: guard.ownerToken, value: result.value };
  } catch (error) {
    // #1251: "ownership" writes are idempotent, Postgres-only, and fenced on
    // the claim token — there is no partial remote effect to preserve, so a
    // failed ownership attempt must not leave an unrecoverable guard behind
    // (its resume branch does not exist by design). Same posture as "lease".
    if ((request.operation === "lease" || request.operation === "ownership") && !resuming) {
      await prisma.issueMutationGuard.deleteMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true } });
    } else {
      await prisma.issueMutationGuard.updateMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true }, data: { executing: false } });
    }
    throw error;
  }
}
