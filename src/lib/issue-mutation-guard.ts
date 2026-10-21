import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface IssueMutationRequest {
  issueId: string;
  operation: string;
  agentName?: string;
  claimToken?: string;
  /**
   * #1254: maintainer-only deliberate override (the claim route's force=true
   * path). Takes over a guard left `executing` by a crashed process — the
   * operator decision the fail-closed posture defers to. Never used by
   * automation: a normal conflicting writer still gets `busy`.
   */
  override?: boolean;
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
    // `override` is a caller directive, never a column: strip it from the
    // row shape or every create fails Prisma validation.
    const { override: _override, ...createRequest } = request;
    await prisma.issueMutationGuard.create({ data: { ...createRequest, ownerToken, executing: true } });
    created = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) && (typeof error !== "object" || error === null || !("code" in error))) throw error;
    if ((error as { code?: string }).code !== "P2002") throw error;
  }

  let guard = created ? await prisma.issueMutationGuard.findUnique({ where: { issueId: request.issueId } }) : null;
  let resuming = false;
  let overrode = false;
  if (!created) {
    guard = await prisma.issueMutationGuard.findUnique({ where: { issueId: request.issueId } });
    if (!guard) return { status: "busy", ownerToken, operation: request.operation };
    // Operator override (maintainer force-claim): a guard left `executing` by
    // a crashed process is otherwise un-recoverable in-product; the explicit
    // operator decision removes it and the caller proceeds under a fresh
    // guard. Deliberately narrower than resuming: it does not run the stale
    // writer's callback, it discards it.
    if (request.override === true && guard.executing) {
      const removed = await prisma.issueMutationGuard.deleteMany({
        where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true },
      });
      if (removed.count !== 1) return { status: "busy", ownerToken: guard.ownerToken, operation: guard.operation };
      overrode = true;
    }
  }
  if (overrode) {
    // The override removed the stale guard: acquire fresh (depth 2 — the
    // recursive create cannot hit the override branch again). A resuming
    // writer that re-acquired its guard inside the delete window loses the
    // race; its own writes are intent/epoch-fenced, so nothing is corrupted —
    // this is the accepted cost of a deliberate operator override.
    return withIssueMutationGuard(request, callback);
  }
  if (!created) {
    if (guard === null) return { status: "busy", ownerToken, operation: request.operation };
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
    // #1254: the reconciler's release protocol and the direct-assign path
    // resume a guard demoted by a failed attempt the same way the stale-work
    // sweep does — every step is a conditional update or an idempotent remote
    // write keyed off the persisted intent row, so re-entering after a crash
    // mid-guard is safe. A guard left `executing` by a dead process stays
    // fail-closed (never time-expired), exactly like every other operation.
    const exactReconcileRelease = request.operation === "reconcile-release" && guard.operation === "reconcile-release"
      && request.agentName !== undefined && guard.agentName === request.agentName;
    const exactAssign = request.operation === "assign" && guard.operation === "assign";
    if ((!exactRelease && !exactClaim && !exactStaleRelease && !exactReconcileRelease && !exactAssign) || guard.executing) return { status: "busy", ownerToken: guard.ownerToken, operation: guard.operation };
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
