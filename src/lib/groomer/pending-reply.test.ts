import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplierGitHub } from "./mutation-applier";
import { commentMarker, commentMarkerKey, MAX_GITHUB_COMMENT_CHARS } from "./mutation-applier";
import { approvePendingReply, dismissPendingReply, holdPendingReply } from "./pending-reply";

const KEY = "a".repeat(64);
const URL = "https://github.com/org/repo/issues/42#issuecomment-7";

type PendingRow = {
  id: string;
  applicationKey: string;
  repoFullName: string;
  issueNumber: number;
  issueId: string;
  groomingRunId: string | null;
  commentBody: string;
  reason: string;
  trustContext: unknown;
  status: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  postedUrl: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
};

function fakePrisma(initial: Partial<PendingRow> = {}) {
  const rows = new Map<string, PendingRow>();
  const applications = new Map<string, { applicationKey: string; steps: unknown }>();
  const audits: Array<Record<string, unknown>> = [];
  let nextId = 0;
  const complete = (input: Partial<PendingRow>): PendingRow => ({
    id: input.id ?? `pending-${++nextId}`,
    applicationKey: input.applicationKey ?? KEY,
    repoFullName: input.repoFullName ?? "org/repo",
    issueNumber: input.issueNumber ?? 42,
    issueId: input.issueId ?? "issue-42",
    groomingRunId: input.groomingRunId ?? "run-1",
    commentBody: input.commentBody ?? "A proposed public reply.",
    reason: input.reason ?? "externally_engaged",
    trustContext: input.trustContext ?? { participants: [] },
    status: input.status ?? "pending",
    approvedBy: input.approvedBy ?? null,
    approvedAt: input.approvedAt ?? null,
    postedUrl: input.postedUrl ?? null,
    resolvedBy: input.resolvedBy ?? null,
    resolvedAt: input.resolvedAt ?? null,
  });
  const seeded = complete(initial);
  rows.set(seeded.id, seeded);

  const findUnique = async ({ where }: { where: Record<string, unknown> }) => {
    const row = [...rows.values()].find((candidate) =>
      (where.id === undefined || candidate.id === where.id) &&
      (where.applicationKey === undefined || candidate.applicationKey === where.applicationKey),
    );
    return row ? { ...row } : null;
  };
  const updateMany = async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const row of rows.values()) {
      if (
        (where.id === undefined || row.id === where.id) &&
        (where.issueId === undefined || row.issueId === where.issueId) &&
        (where.applicationKey === undefined || (typeof where.applicationKey === "object" && where.applicationKey !== null
          ? (where.applicationKey as { not?: string }).not !== row.applicationKey
          : row.applicationKey === where.applicationKey)) &&
        (where.status === undefined || row.status === where.status) &&
        (where.OR === undefined || (where.OR as Array<Record<string, unknown>>).some((condition) => {
          if (condition.status === "pending") return row.status === "pending";
          if (condition.status === "approved") {
            const approvedAt = row.approvedAt?.getTime();
            const threshold = (condition.approvedAt as { lt?: Date } | undefined)?.lt?.getTime() ?? 0;
            return row.status === "approved" && approvedAt !== undefined && approvedAt < threshold;
          }
          return false;
        }))
      ) {
        Object.assign(row, data);
        count += 1;
      }
    }
    return { count };
  };
  const tx = {
    $queryRaw: async () => [],
    groomerPendingReply: {
      findUnique,
      updateMany,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("missing row");
        Object.assign(row, data);
        return { ...row };
      },
      upsert: async ({ where, create }: { where: { applicationKey: string }; create: Partial<PendingRow>; update: Record<string, unknown> }) => {
        const existing = [...rows.values()].find((row) => row.applicationKey === where.applicationKey);
        if (existing) return existing;
        const row = complete(create);
        rows.set(row.id, row);
        return row;
      },
    },
    groomingApplication: {
      findUnique: async ({ where }: { where: { applicationKey: string } }) => applications.get(where.applicationKey) ?? null,
      update: async ({ where, data }: { where: { applicationKey: string }; data: { steps: unknown } }) => {
        const row = applications.get(where.applicationKey);
        if (!row) throw new Error("missing application");
        row.steps = data.steps;
        return row;
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => audits.push(data) },
  };

  const client = {
    groomerPendingReply: tx.groomerPendingReply,
    groomingApplication: tx.groomingApplication,
    auditLog: tx.auditLog,
    $transaction: <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as PrismaClient;
  return { client, rows, applications, audits };
}

function fakeGitHub(overrides: Partial<Pick<ApplierGitHub, "addComment" | "fetchRecentComments">> = {}) {
  const addComment = vi.fn<ApplierGitHub["addComment"]>(async () => ({ url: URL }));
  const fetchRecentComments = vi.fn<ApplierGitHub["fetchRecentComments"]>(async () => []);
  const effectiveAddComment = overrides.addComment ? vi.fn(overrides.addComment) : addComment;
  const effectiveFetchRecentComments = overrides.fetchRecentComments ? vi.fn(overrides.fetchRecentComments) : fetchRecentComments;
  return {
    addComment: effectiveAddComment,
    fetchRecentComments: effectiveFetchRecentComments,
    addCommentMock: effectiveAddComment,
  };
}

describe("pending groomer replies", () => {
  let db: ReturnType<typeof fakePrisma>;

  beforeEach(() => {
    db = fakePrisma();
  });

  it("holds one pending reply per issue and does not revive terminal rows", async () => {
    await holdPendingReply(db.client, {
      applicationKey: KEY,
      repoFullName: "org/repo",
      issueNumber: 42,
      issueId: "issue-42",
      groomingRunId: "run-1",
      commentBody: "Original reply",
      reason: "externally_engaged",
      trustContext: { login: "external" },
    });
    const row = [...db.rows.values()][0];
    expect(row).toMatchObject({ status: "pending", commentBody: "Original reply" });

    await holdPendingReply(db.client, {
      applicationKey: KEY,
      repoFullName: "org/repo",
      issueNumber: 42,
      issueId: "issue-42",
      groomingRunId: "run-2",
      commentBody: "Updated reply",
      reason: "externally_engaged",
      trustContext: { login: "new external" },
    });
    expect(row).toMatchObject({ status: "pending", commentBody: "Updated reply" });

    row.status = "posted";
    await holdPendingReply(db.client, {
      applicationKey: KEY,
      repoFullName: "org/repo",
      issueNumber: 42,
      issueId: "issue-42",
      groomingRunId: "run-3",
      commentBody: "Do not replace",
      reason: "externally_engaged",
      trustContext: {},
    });
    expect(row).toMatchObject({ status: "posted", commentBody: "Updated reply" });

    const previous = { ...row, id: "pending-previous", applicationKey: "b".repeat(64), status: "pending" };
    db.rows.set(previous.id, previous);
    const nextKey = "c".repeat(64);
    await holdPendingReply(db.client, {
      applicationKey: nextKey,
      repoFullName: "org/repo",
      issueNumber: 42,
      issueId: "issue-42",
      groomingRunId: "run-4",
      commentBody: "Latest reply",
      reason: "externally_engaged",
      trustContext: {},
    });
    expect(previous.status).toBe("superseded");
    expect([...db.rows.values()].find((pending) => pending.applicationKey === nextKey)).toMatchObject({ status: "pending" });
  });

  it("posts once with the canonical marker and body, then replays the stored URL", async () => {
    const row = [...db.rows.values()][0];
    db.applications.set(KEY, { applicationKey: KEY, steps: { labels: { status: "applied" } } });
    const github = fakeGitHub();

    const first = await approvePendingReply(db.client, { id: row.id, actor: "operator", authType: "oidc", github });
    const second = await approvePendingReply(db.client, { id: row.id, actor: "operator", authType: "oidc", github });

    expect(first).toEqual({ ok: true, status: "posted", url: URL });
    expect(second).toEqual({ ok: true, status: "posted", url: URL });
    expect(github.addComment).toHaveBeenCalledTimes(1);
    expect(github.addComment).toHaveBeenCalledWith("org/repo", 42, `A proposed public reply.\n\n${commentMarker(KEY)}`);
    expect(commentMarkerKey(github.addCommentMock.mock.calls[0][2])).toBe(KEY);
    expect(row.status).toBe("posted");
    expect(db.applications.get(KEY)?.steps).toMatchObject({ comment: { status: "applied", detail: "posted_by_operator_approval", commentUrl: URL } });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ actor: "operator", action: "groomer_reply_approved" });
  });

  it("rejects a racing approval while the first GitHub post is in flight", async () => {
    const row = [...db.rows.values()][0];
    let resolvePost!: (value: { url: string }) => void;
    const post = new Promise<{ url: string }>((resolve) => { resolvePost = resolve; });
    const github = fakeGitHub({ addComment: vi.fn(() => post) });

    const firstPromise = approvePendingReply(db.client, { id: row.id, actor: "operator-a", github });
    // Let the first claim transaction finish and enter the blocked GitHub call.
    await vi.waitFor(() => expect(github.addComment).toHaveBeenCalledTimes(1));

    const second = await approvePendingReply(db.client, { id: row.id, actor: "operator-b", github });
    expect(second).toEqual({ ok: false, code: "in_progress", message: "another approval is already in progress" });
    expect(github.addComment).toHaveBeenCalledTimes(1);

    resolvePost({ url: URL });
    const first = await firstPromise;
    expect(first).toEqual({ ok: true, status: "posted", url: URL });
    expect(github.addComment).toHaveBeenCalledTimes(1);
  });

  it("refuses an over-cap approved body without posting and releases the claim", async () => {
    const row = [...db.rows.values()][0];
    row.commentBody = "x".repeat(MAX_GITHUB_COMMENT_CHARS);
    const github = fakeGitHub();

    const result = await approvePendingReply(db.client, { id: row.id, actor: "operator", github });

    expect(result).toEqual({
      ok: false,
      code: "too_long",
      message: "The proposed reply exceeds GitHub's 4096-character comment limit; shorten it before approving",
    });
    expect(github.addComment).not.toHaveBeenCalled();
    expect(row.status).toBe("pending");
  });

  it("uses an existing marker without posting and records its URL", async () => {
    const row = [...db.rows.values()][0];
    row.status = "pending";
    const github = fakeGitHub({
      fetchRecentComments: vi.fn(async () => [{ id: 7, author: "itsmiso-ai", createdAt: "2026-10-08T00:00:00Z", body: `A proposed public reply.\n\n${commentMarker(KEY)}`, url: URL }]),
    });
    const result = await approvePendingReply(db.client, { id: row.id, actor: "operator", github });
    expect(result).toEqual({ ok: true, status: "posted", url: URL });
    expect(github.addComment).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "posted", postedUrl: URL });
  });

  it("returns failed posts to pending so approval can be retried", async () => {
    const row = [...db.rows.values()][0];
    row.status = "pending";
    const github = fakeGitHub({
      addComment: vi.fn(async () => { throw new Error("GitHub unavailable"); }),
    });
    const failed = await approvePendingReply(db.client, { id: row.id, actor: "operator", github });
    expect(failed).toMatchObject({ ok: false, code: "post_failed", message: "GitHub unavailable" });
    expect(row.status).toBe("pending");

    github.addCommentMock.mockImplementation(async () => ({ url: URL }));
    const retried = await approvePendingReply(db.client, { id: row.id, actor: "operator", github });
    expect(retried).toEqual({ ok: true, status: "posted", url: URL });
    expect(github.addComment).toHaveBeenCalledTimes(3);
  });

  it("retries an approval left approved by a crashed attempt", async () => {
    const row = [...db.rows.values()][0];
    row.status = "approved";
    row.approvedAt = new Date(Date.now() - 6 * 60 * 1000);
    const github = fakeGitHub();
    const result = await approvePendingReply(db.client, { id: row.id, actor: "operator", github });
    expect(result).toEqual({ ok: true, status: "posted", url: URL });
    expect(github.addComment).toHaveBeenCalledTimes(1);
  });

  it("fails closed when marker lookup fails, restoring the row to pending", async () => {
    const row = [...db.rows.values()][0];
    row.status = "pending";
    const github = fakeGitHub({ fetchRecentComments: vi.fn(async () => { throw new Error("lookup unavailable"); }) });
    const result = await approvePendingReply(db.client, { id: row.id, actor: "operator", github });
    expect(result).toMatchObject({ ok: false, code: "post_failed" });
    expect(row.status).toBe("pending");
    expect(github.addComment).not.toHaveBeenCalled();
  });

  it("dismisses pending replies but not already-resolved rows", async () => {
    const row = [...db.rows.values()][0];
    row.status = "pending";
    expect(await dismissPendingReply(db.client, { id: row.id, actor: "operator" })).toEqual({ ok: true });
    expect(row).toMatchObject({ status: "dismissed", resolvedBy: "operator" });
    expect(await dismissPendingReply(db.client, { id: row.id, actor: "operator" })).toEqual({ ok: false, code: "not_pending" });
    expect(await dismissPendingReply(db.client, { id: "missing", actor: "operator" })).toEqual({ ok: false, code: "not_found" });
  });
});
