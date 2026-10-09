import { Prisma, type PrismaClient } from "@prisma/client";
import { addIssueComment, fetchIssueComments } from "@/lib/github";
import {
  groomerCommentKey,
  postCommentIdempotently,
  willExceedCommentCap,
  type ApplierGitHub,
} from "./mutation-applier";
import type { LiveComment } from "./mutation-validator";

function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue;
}

export async function holdPendingReply(
  prisma: PrismaClient,
  input: {
    applicationKey: string;
    repoFullName: string;
    issueNumber: number;
    issueId: string;
    groomingRunId: string | null;
    commentBody: string;
    reason: string;
    trustContext: unknown;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Serialize holds for the same issue so concurrent runs cannot leave two
    // pending rows after each supersedes the other's previous snapshot.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Issue" WHERE "id" = ${input.issueId} FOR UPDATE`);
    await tx.groomerPendingReply.updateMany({
      where: { issueId: input.issueId, status: "pending", applicationKey: { not: input.applicationKey } },
      data: { status: "superseded" },
    });

    await tx.groomerPendingReply.updateMany({
      where: { applicationKey: input.applicationKey, status: "pending" },
      data: {
        commentBody: input.commentBody,
        trustContext: jsonInput(input.trustContext),
        updatedAt: new Date(),
      },
    });

    await tx.groomerPendingReply.upsert({
      where: { applicationKey: input.applicationKey },
      create: {
        ...input,
        trustContext: jsonInput(input.trustContext),
      },
      // A concurrent creator wins without allowing this retry to revive or
      // overwrite a terminal row.
      update: {},
    });
  });
}

export type ApproveResult =
  | { ok: true; status: "posted"; url: string | null }
  | { ok: false; code: "not_found" | "not_pending" | "in_progress" | "post_failed" | "too_long"; message: string };

function liveComment(comment: Awaited<ReturnType<typeof fetchIssueComments>>[number]): LiveComment {
  return {
    id: comment.id ?? null,
    author: comment.user?.login ?? "",
    createdAt: comment.created_at ?? "",
    body: comment.body ?? "",
    url: comment.html_url ?? null,
  };
}

const defaultGitHub: Pick<ApplierGitHub, "addComment" | "fetchRecentComments"> = {
  addComment: addIssueComment,
  async fetchRecentComments(repoFullName, issueNumber, max) {
    return (await fetchIssueComments(repoFullName, issueNumber, max, "desc")).map(liveComment);
  },
};

const STALE_APPROVAL_MS = 5 * 60 * 1000;

export async function approvePendingReply(
  prisma: PrismaClient,
  input: {
    id: string;
    actor: string;
    authType?: string;
    github?: Pick<ApplierGitHub, "addComment" | "fetchRecentComments">;
  },
): Promise<ApproveResult> {
  const github = input.github ?? defaultGitHub;

  // Phase 1: claim the row in a short transaction. No GitHub calls belong in
  // an interactive transaction; the claim is protected by the DB CAS instead.
  const row = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "GroomerPendingReply" WHERE "id" = ${input.id} FOR UPDATE`);
    const claimed = await tx.groomerPendingReply.updateMany({
      where: {
        id: input.id,
        OR: [
          { status: "pending" },
          { status: "approved", approvedAt: { lt: new Date(Date.now() - STALE_APPROVAL_MS) } },
        ],
      },
      data: { status: "approved", approvedBy: input.actor, approvedAt: new Date() },
    });
    const current = await tx.groomerPendingReply.findUnique({ where: { id: input.id } });
    if (!current) {
      return { kind: "result" as const, result: { ok: false, code: "not_found", message: "Pending reply not found" } as const };
    }
    if (claimed.count === 0) {
      if (current.status === "posted") {
        return { kind: "result" as const, result: { ok: true, status: "posted", url: current.postedUrl } as const };
      }
      if (current.status === "approved") {
        return {
          kind: "result" as const,
          result: { ok: false, code: "in_progress", message: "another approval is already in progress" } as const,
        };
      }
      return {
        kind: "result" as const,
        result: { ok: false, code: "not_pending", message: `Pending reply is ${current.status}` } as const,
      };
    }
    return { kind: "row" as const, row: current };
  });

  if (row.kind === "result") return row.result;
  const pending = row.row;

  if (willExceedCommentCap(pending.commentBody, pending.applicationKey)) {
    await releaseApprovalClaim(prisma, pending.id);
    return {
      ok: false,
      code: "too_long",
      message: "The proposed reply exceeds GitHub's 4096-character comment limit; shorten it before approving",
    };
  }

  // Phase 2: scan and post outside any transaction. The marker scan resolves a
  // crash after GitHub accepted the comment but before Dispatch recorded it.
  let url: string | null;
  try {
    const found = (await github.fetchRecentComments(pending.repoFullName, pending.issueNumber, 10)).find(
      (comment) => groomerCommentKey(comment) === pending.applicationKey,
    );
    if (found) {
      url = found.url;
    } else {
      // Human approval deliberately bypasses commentCooldownHours: the
      // operator's explicit approval supersedes the machine cooldown.
      url = (await postCommentIdempotently(github, {
        repoFullName: pending.repoFullName,
        issueNumber: pending.issueNumber,
        applicationKey: pending.applicationKey,
        comment: pending.commentBody,
      })).url;
    }
  } catch (error) {
    await releaseApprovalClaim(prisma, pending.id);
    return {
      ok: false,
      code: "post_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Phase 3: record the completed post in a short transaction. Follow-up
  // application/audit writes are best-effort, but can no longer be swallowed
  // by a transaction timing out across a GitHub request.
  await prisma.$transaction(async (tx) => {
    await tx.groomerPendingReply.update({
      where: { id: pending.id },
      data: { status: "posted", postedUrl: url, resolvedBy: input.actor, resolvedAt: new Date() },
    });
  });

  try {
    const application = await prisma.groomingApplication.findUnique({ where: { applicationKey: pending.applicationKey } });
    if (application) {
      const steps = application.steps && typeof application.steps === "object" && !Array.isArray(application.steps)
        ? { ...(application.steps as Record<string, unknown>) }
        : {};
      steps.comment = { status: "applied", detail: "posted_by_operator_approval", commentUrl: url };
      await prisma.groomingApplication.update({
        where: { applicationKey: pending.applicationKey },
        data: { steps: steps as Prisma.InputJsonValue },
      });
    }
  } catch (error) {
    console.warn(`[groomer] approved reply application update failed for ${input.id}:`, error);
  }

  try {
    await prisma.auditLog.create({
      data: {
        actor: input.actor,
        action: "groomer_reply_approved",
        repoFullName: pending.repoFullName,
        issueNumber: pending.issueNumber,
        issueId: pending.issueId,
        beforeLabels: [],
        afterLabels: [],
        success: true,
        notes: JSON.stringify({
          applicationKey: pending.applicationKey,
          policy: "human_approved",
          commentUrl: url,
          authType: input.authType,
        }),
      },
    });
  } catch (error) {
    console.warn(`[groomer] approved reply audit failed for ${input.id}:`, error);
  }

  return { ok: true, status: "posted", url };
}

async function releaseApprovalClaim(prisma: PrismaClient, id: string): Promise<void> {
  try {
    await prisma.groomerPendingReply.updateMany({
      where: { id, status: "approved" },
      data: { status: "pending" },
    });
  } catch (error) {
    console.warn(`[groomer] failed to release pending reply approval claim for ${id}:`, error);
  }
}

export async function dismissPendingReply(
  prisma: PrismaClient,
  input: { id: string; actor: string },
): Promise<{ ok: boolean; code?: string }> {
  const result = await prisma.groomerPendingReply.updateMany({
    where: { id: input.id, status: "pending" },
    data: { status: "dismissed", resolvedBy: input.actor, resolvedAt: new Date() },
  });
  if (result.count > 0) return { ok: true };
  const row = await prisma.groomerPendingReply.findUnique({ where: { id: input.id }, select: { id: true } });
  return row ? { ok: false, code: "not_pending" } : { ok: false, code: "not_found" };
}
