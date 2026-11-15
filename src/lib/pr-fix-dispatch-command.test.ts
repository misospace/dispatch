// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    repositoryFindUnique: vi.fn().mockResolvedValue({ id: "r1", fullName: "org/repo" }),
    issueFindFirst: vi.fn(),
    issueUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
    issueUpdate: vi.fn().mockResolvedValue({}),
    prFixQueueItemFindUnique: vi.fn(),
    prFixQueueItemCount: vi.fn().mockResolvedValue(1),
    auditLogCreate: vi.fn().mockResolvedValue({}),
    addIssueComment: vi.fn().mockResolvedValue({ url: null }),
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    fetchIssueLabels: vi.fn(),
    fetchCollaboratorPermission: vi.fn().mockResolvedValue({ status: "ok", permission: "read" }),
    fetchPullRequestDetail: vi.fn(),
    fetchPullRequestReviews: vi.fn(),
    enqueuePrFixItem: vi.fn().mockResolvedValue({ status: "QUEUED", lane: "NORMAL", claimant: "foo", claimantSource: "agent-label" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findUnique: mocks.repositoryFindUnique },
    issue: {
      findFirst: mocks.issueFindFirst,
      updateMany: mocks.issueUpdateMany,
      update: mocks.issueUpdate,
    },
    prFixQueueItem: {
      findUnique: mocks.prFixQueueItemFindUnique,
      count: mocks.prFixQueueItemCount,
    },
    auditLog: { create: mocks.auditLogCreate },
  },
  asPrFixQueueClient: (client: unknown) => client,
}));

vi.mock("@/lib/github-issues", () => ({
  addIssueComment: mocks.addIssueComment,
  addIssueLabel: mocks.addIssueLabel,
  removeIssueLabel: mocks.removeIssueLabel,
  fetchIssueLabels: mocks.fetchIssueLabels,
  fetchCollaboratorPermission: mocks.fetchCollaboratorPermission,
}));

vi.mock("@/lib/github-prs", () => ({
  fetchPullRequestDetail: mocks.fetchPullRequestDetail,
  fetchPullRequestReviews: mocks.fetchPullRequestReviews,
}));

vi.mock("@/lib/pr-fix-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pr-fix-queue")>()),
  enqueuePrFixItem: mocks.enqueuePrFixItem,
}));

import { resetRateLimits } from "@/lib/rate-limit";
import {
  deriveBlockingReview,
  handleDispatchFixCommand,
  parseDispatchFixCommand,
} from "./pr-fix-dispatch-command";
import type { PullRequestReview } from "@/lib/github-prs";

const HEAD = "abc1234567890abcdef";
const PR_DETAIL = {
  state: "open",
  mergedAt: null,
  draft: false,
  headSha: HEAD,
  headRef: "feature-branch",
  headRepoFullName: "org/repo",
  author: "pr-author",
  title: "Fix the thing #101",
  body: "Fixes #101",
  htmlUrl: "https://github.com/org/repo/pull/5",
};

function review(overrides: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    id: 1,
    user: "reviewer",
    state: "CHANGES_REQUESTED",
    submittedAt: "2026-11-13T00:00:00Z",
    commitId: HEAD,
    body: "please fix the thing",
    ...overrides,
  };
}

function baseCommand(overrides: Record<string, unknown> = {}) {
  return {
    repoFullName: "org/repo",
    prNumber: 5,
    commenter: "pr-author",
    commentBody: "/dispatch-fix",
    ...overrides,
  };
}

/** Reset the forge/prisma mocks that eligibility tests vary per case. */
function resetDefaultFlowMocks() {
  mocks.repositoryFindUnique.mockResolvedValue({ id: "r1", fullName: "org/repo" });
  mocks.fetchPullRequestDetail.mockResolvedValue({ ...PR_DETAIL });
  mocks.fetchPullRequestReviews.mockResolvedValue([review()]);
  mocks.issueFindFirst.mockResolvedValue({ id: "i1", labels: ["agent/foo"] });
  mocks.fetchIssueLabels.mockResolvedValue(["agent/foo"]);
  mocks.issueUpdateMany.mockResolvedValue({ count: 1 });
  mocks.issueUpdate.mockResolvedValue({});
  mocks.prFixQueueItemFindUnique.mockResolvedValue(null);
  mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "read" });
  mocks.addIssueComment.mockResolvedValue({ url: null });
  mocks.addIssueLabel.mockResolvedValue(undefined);
  mocks.removeIssueLabel.mockResolvedValue(undefined);
  mocks.auditLogCreate.mockResolvedValue({});
  mocks.enqueuePrFixItem.mockResolvedValue({ status: "QUEUED", lane: "NORMAL", claimant: "foo", claimantSource: "agent-label" });
}

describe("parseDispatchFixCommand", () => {
  it("returns null for non-commands", () => {
    expect(parseDispatchFixCommand(null)).toBeNull();
    expect(parseDispatchFixCommand("")).toBeNull();
    expect(parseDispatchFixCommand("please /dispatch-fix this")).toBeNull();
    expect(parseDispatchFixCommand("/dispatch-fixes")).toBeNull();
  });

  it("parses the bare command", () => {
    expect(parseDispatchFixCommand("/dispatch-fix")).toEqual({ ok: true });
    expect(parseDispatchFixCommand("  /dispatch-fix  ")).toEqual({ ok: true });
  });

  it("parses a lane profile", () => {
    expect(parseDispatchFixCommand("/dispatch-fix lane=hyper")).toEqual({ ok: true, lane: "hyper" });
    expect(parseDispatchFixCommand("/dispatch-fix\nlane=hyper")).toEqual({ ok: true, lane: "hyper" });
  });

  it("rejects malformed lane profiles", () => {
    for (const lane of ["Hyper", "agent/x", "a".repeat(33), "hyper!", ""]) {
      const parsed = parseDispatchFixCommand(`/dispatch-fix lane=${lane}`);
      expect(parsed && "ok" in parsed && parsed.ok).toBeFalsy();
    }
  });

  it("rejects unrecognized trailing arguments", () => {
    const parsed = parseDispatchFixCommand("/dispatch-fix now");
    expect(parsed).toEqual({ ok: false, reason: expect.stringContaining("Unrecognized") });
  });
});

describe("deriveBlockingReview", () => {
  it("returns null with no reviews", () => {
    expect(deriveBlockingReview([], HEAD)).toBeNull();
  });

  it("returns the review when CHANGES_REQUESTED on the current head", () => {
    const blocking = deriveBlockingReview([review()], HEAD);
    expect(blocking?.review.id).toBe(1);
    expect(blocking?.stale).toBe(false);
  });

  it("marks a review against an older commit stale", () => {
    const blocking = deriveBlockingReview([review({ commitId: "0000000" })], HEAD);
    expect(blocking?.stale).toBe(true);
  });

  it("marks a review with unknown commit stale", () => {
    expect(deriveBlockingReview([review({ commitId: null })], HEAD)?.stale).toBe(true);
  });

  it("supersession: the reviewer's later APPROVED clears the block", () => {
    const blocking = deriveBlockingReview(
      [
        review({ id: 1, submittedAt: "2026-11-12T00:00:00Z" }),
        review({ id: 2, state: "APPROVED", submittedAt: "2026-11-13T00:00:00Z" }),
      ],
      HEAD,
    );
    expect(blocking).toBeNull();
  });

  it("picks the newest of several blocking reviews", () => {
    const blocking = deriveBlockingReview(
      [
        review({ id: 1, submittedAt: "2026-11-12T00:00:00Z", body: "old" }),
        review({ id: 2, submittedAt: "2026-11-13T00:00:00Z", body: "new" }),
      ],
      HEAD,
    );
    expect(blocking?.review.body).toBe("new");
  });

  it("a newer stale request from another reviewer does not mask a current-head request", () => {
    // Regression (review round 4, M1): selecting the newest blocking review
    // before checking its head let a newer stale CHANGES_REQUESTED mask a
    // valid current-head request and falsely refuse the command.
    const blocking = deriveBlockingReview(
      [
        review({ id: 1, user: "early-reviewer", submittedAt: "2026-11-12T00:00:00Z", body: "current-head feedback" }),
        review({ id: 2, user: "late-reviewer", submittedAt: "2026-11-14T00:00:00Z", commitId: "0000000", body: "stale feedback" }),
      ],
      HEAD,
    );
    expect(blocking?.review.body).toBe("current-head feedback");
    expect(blocking?.stale).toBe(false);
  });

  it("reports stale only when every standing request is off the current head", () => {
    const blocking = deriveBlockingReview(
      [
        review({ id: 1, user: "reviewer-a", submittedAt: "2026-11-12T00:00:00Z", commitId: "0000000" }),
        review({ id: 2, user: "reviewer-b", submittedAt: "2026-11-13T00:00:00Z", commitId: "1111111" }),
      ],
      HEAD,
    );
    expect(blocking?.review.id).toBe(2);
    expect(blocking?.stale).toBe(true);
  });
});

describe("handleDispatchFixCommand", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.clearAllMocks();
    resetDefaultFlowMocks();
    mocks.prFixQueueItemCount.mockResolvedValue(1);
  });

  it("enqueues the review feedback with the deterministic evidence key", async () => {
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("enqueued");
    expect(mocks.enqueuePrFixItem).toHaveBeenCalledTimes(1);
    const input = mocks.enqueuePrFixItem.mock.calls[0][1];
    expect(input.repo).toBe("org/repo");
    expect(input.pr).toBe(5);
    expect(input.issue).toBe(101);
    expect(input.type).toBe("REVIEW_FEEDBACK");
    expect(input.lane).toBe("NORMAL");
    expect(input.feedback).toBe("please fix the thing");
    expect(input.evidenceKey).toBe(`pr-review:5:${HEAD.slice(0, 8)}`);
    expect(input.headSha).toBe(HEAD);
    expect(input.branch).toBe("feature-branch");
    expect(input.url).toBe(PR_DETAIL.htmlUrl);
    expect(input.author).toBe("pr-author");
    // Ledger fields mirror the review-ingestion projection.
    expect(input.evidenceKind).toBe("review");
    expect(input.evidenceActionable).toBe(true);
    expect(input.evidenceHeadSha).toBe(HEAD);
    expect(input.evidenceSource).toBe("webhook");
    // Claimant is never set by the caller — enqueuePrFixItem resolves it (#1569).
    expect(JSON.stringify(input)).not.toContain("claimant");
  });

  it("refuses an empty review body instead of enqueuing empty feedback", async () => {
    mocks.fetchPullRequestReviews.mockResolvedValue([review({ body: "" })]);
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
  });

  it("writes a success audit row with the commenter as actor", async () => {
    await handleDispatchFixCommand(baseCommand());
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.actor).toBe("pr-author");
    expect(data.action).toBe("pr_fix_enqueue");
    expect(data.success).toBe(true);
    expect(data.issueNumber).toBe(101);
    expect(data.notes).toContain("source=/dispatch-fix");
  });

  it("names the claimant recorded on the queue row in the confirmation reply (AI review major, round 3)", async () => {
    // The note reports the row's RECORDED claimant, not a label prediction.
    await handleDispatchFixCommand(baseCommand());
    expect(mocks.addIssueComment.mock.calls[0][2]).toContain("Claimant recorded on the queue row: `foo` (source: agent-label)");
    mocks.addIssueComment.mockClear();
    // No recorded claimant: the reply says the gate will refuse, not invent one.
    mocks.enqueuePrFixItem.mockResolvedValue({ status: "QUEUED", lane: "NORMAL", claimant: null, claimantSource: "ambiguous" });
    await handleDispatchFixCommand(baseCommand());
    expect(mocks.addIssueComment.mock.calls[0][2]).toContain("No claimant was recorded on the queue row");
    expect(mocks.addIssueComment.mock.calls[0][2]).toContain("ownership gate will refuse");
  });

  it("converges the cached agent set to GitHub on the plain (no lane=) path before enqueueing (AI review major 2, round 3)", async () => {
    // GitHub shows agent/foo; the cached row still lags with agent/old.
    mocks.issueFindFirst.mockResolvedValue({ id: "i1", labels: ["agent/old"] });
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("enqueued");
    expect(mocks.issueUpdateMany).toHaveBeenCalledWith({
      where: { id: "i1", labels: { equals: ["agent/old"] } },
      data: { labels: ["agent/foo"] },
    });
  });

  it("fails closed (no enqueue) when the plain-path cache mirror cannot write", async () => {
    mocks.issueFindFirst.mockResolvedValue({ id: "i1", labels: ["agent/old"] });
    mocks.issueUpdateMany.mockRejectedValue(new Error("mirror down"));
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("error");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.success).toBe(false);
  });

  it("skips the mirror write when a concurrent delivery already refreshed the cache to the post-swap set", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    mocks.issueFindFirst
      // eligibility-check cache read
      .mockResolvedValueOnce({ id: "i1", labels: ["agent/foo"] })
      // verify-and-mirror read: still the pre-swap set
      .mockResolvedValueOnce({ id: "i1", labels: ["agent/foo"] })
      // mirror's post-CAS-loss re-read: the webhook echo already converged it
      .mockResolvedValue({ id: "i1", labels: ["agent/courier-hyper"] });
    mocks.issueUpdateMany.mockResolvedValue({ count: 0 });
    const outcome = await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(outcome.outcome).toBe("enqueued");
    expect(mocks.enqueuePrFixItem).toHaveBeenCalledTimes(1);
    // No unconditional overwrite needed — the fresh cache was already correct.
    expect(mocks.issueUpdate).not.toHaveBeenCalled();
  });

  it("posts a confirmation reply", async () => {
    await handleDispatchFixCommand(baseCommand());
    const reply = mocks.addIssueComment.mock.calls[0];
    expect(reply[0]).toBe("org/repo");
    expect(reply[1]).toBe(5);
    expect(reply[2]).toContain("`QUEUED`");
  });

  it("scopes the queue position to the repo (not global)", async () => {
    await handleDispatchFixCommand(baseCommand());
    expect(mocks.prFixQueueItemCount).toHaveBeenCalledWith({
      where: { repo: "org/repo", lane: "NORMAL", status: "QUEUED" },
    });
  });

  it("refuses to work on an untracked repo", async () => {
    mocks.repositoryFindUnique.mockResolvedValue(null);
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    expect(mocks.fetchPullRequestDetail).not.toHaveBeenCalled();
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
  });

  it("refuses a malformed command instead of silently dropping its arguments", async () => {
    const outcome = await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=Hyper" }));
    expect(outcome.outcome).toBe("refused");
    const reply = mocks.addIssueComment.mock.calls[0][2];
    expect(reply).toContain("Invalid lane profile");
    expect(mocks.fetchPullRequestDetail).not.toHaveBeenCalled();
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.success).toBe(false);
  });

  it("refuses a commenter who is neither the author nor an operator (fail closed on lookup errors)", async () => {
    for (const permission of [
      { status: "ok", permission: "write" },
      { status: "not_found" },
      { status: "error", message: "boom" },
    ]) {
      mocks.fetchCollaboratorPermission.mockResolvedValue(permission);
      const outcome = await handleDispatchFixCommand(baseCommand({ commenter: "rando" }));
      expect(outcome.outcome).toBe("unauthorized");
      expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
      expect(mocks.addIssueComment).toHaveBeenCalled();
      const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
      expect(data.success).toBe(false);
      mocks.auditLogCreate.mockClear();
      mocks.addIssueComment.mockClear();
    }
  });

  it("allows a repo maintainer", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    const outcome = await handleDispatchFixCommand(baseCommand({ commenter: "maintainer" }));
    expect(outcome.outcome).toBe("enqueued");
  });

  it("allows a repo admin", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "admin" });
    const outcome = await handleDispatchFixCommand(baseCommand({ commenter: "admin" }));
    expect(outcome.outcome).toBe("enqueued");
  });

  it("stays silent toward bot commenters", async () => {
    const outcome = await handleDispatchFixCommand(baseCommand({ commenter: "github-actions[bot]" }));
    expect(outcome.outcome).toBe("unauthorized");
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
  });

  it("refuses merged, closed and draft PRs", async () => {
    for (const detail of [
      { ...PR_DETAIL, state: "closed" },
      { ...PR_DETAIL, state: "open", mergedAt: "2026-11-13T00:00:00Z" },
      { ...PR_DETAIL, draft: true },
    ]) {
      mocks.fetchPullRequestDetail.mockResolvedValue(detail);
      const outcome = await handleDispatchFixCommand(baseCommand());
      expect(outcome.outcome).toBe("refused");
      expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
      expect(mocks.addIssueComment).toHaveBeenCalled();
      mocks.addIssueComment.mockClear();
      mocks.auditLogCreate.mockClear();
    }
  });

  it("refuses fork PRs", async () => {
    mocks.fetchPullRequestDetail.mockResolvedValue({ ...PR_DETAIL, headRepoFullName: "someone/repo" });
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
  });

  it("refuses when there is no CHANGES_REQUESTED review", async () => {
    mocks.fetchPullRequestReviews.mockResolvedValue([review({ state: "APPROVED" })]);
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
  });

  it("refuses a review against a stale head", async () => {
    mocks.fetchPullRequestReviews.mockResolvedValue([review({ commitId: "0000000" })]);
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    const reply = mocks.addIssueComment.mock.calls[0][2];
    expect(reply).toContain("stale");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
  });

  it("refuses ambiguous issue linkage", async () => {
    mocks.fetchPullRequestDetail.mockResolvedValue({ ...PR_DETAIL, title: "Fix #101", body: "See also #202" });
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    const reply = mocks.addIssueComment.mock.calls[0][2];
    expect(reply).toContain("ambiguous");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
  });

  it("refuses a cross-repo issue reference instead of relabelling the wrong issue", async () => {
    mocks.fetchPullRequestDetail.mockResolvedValue({
      ...PR_DETAIL,
      title: "Fix the thing",
      body: "Depends on other-org/other-repo#42",
    });
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    const reply = mocks.addIssueComment.mock.calls[0][2];
    expect(reply).toContain("another repository");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
  });

  it("refuses a PR with no linked issue", async () => {
    mocks.fetchPullRequestDetail.mockResolvedValue({ ...PR_DETAIL, title: "Fix the thing", body: "no refs here" });
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
  });

  it("refuses a linked issue that is not in the cache", async () => {
    mocks.issueFindFirst.mockResolvedValue(null);
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    expect(mocks.fetchIssueLabels).not.toHaveBeenCalled();
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
  });

  it("refuses a linked issue carrying multiple agent labels (GitHub truth, not the cache)", async () => {
    mocks.fetchIssueLabels.mockResolvedValue(["agent/foo", "agent/bar"]);
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("refused");
    expect(mocks.issueFindFirst).toHaveBeenCalled();
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
  });

  it("errors (no enqueue, audited reply) when the linked issue's labels are unavailable", async () => {
    mocks.fetchIssueLabels.mockResolvedValue(null);
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("error");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("reports an existing QUEUED item instead of enqueueing a duplicate", async () => {
    mocks.prFixQueueItemFindUnique.mockResolvedValue({ status: "QUEUED", lane: "NORMAL" });
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("duplicate");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.success).toBe(false);
  });

  it("falls through held statuses to the enqueue's recovery decision (review M5)", async () => {
    for (const status of ["BLOCKED", "PARKED", "WAITING_EXTERNAL"]) {
      mocks.prFixQueueItemFindUnique.mockResolvedValue({ status, lane: "NORMAL" });
      const outcome = await handleDispatchFixCommand(baseCommand());
      expect(outcome.outcome).toBe("enqueued");
      expect(mocks.enqueuePrFixItem).toHaveBeenCalledTimes(1);
      mocks.enqueuePrFixItem.mockClear();
      mocks.addIssueComment.mockClear();
      mocks.auditLogCreate.mockClear();
    }
  });

  it("enqueues when the existing item is terminal", async () => {
    mocks.prFixQueueItemFindUnique.mockResolvedValue({ status: "FIXED", lane: "NORMAL" });
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("enqueued");
    expect(mocks.enqueuePrFixItem).toHaveBeenCalledTimes(1);
  });

  it("swaps the linked issue's agent label BEFORE the enqueue and mirrors the cache (claimant resolution order, review M2)", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    const calls: string[] = [];
    mocks.addIssueLabel.mockImplementation(async () => {
      calls.push("label");
    });
    mocks.issueUpdateMany.mockImplementation(async () => {
      calls.push("mirror");
      return { count: 1 };
    });
    mocks.enqueuePrFixItem.mockImplementation(async () => {
      calls.push("enqueue");
      return { status: "QUEUED", lane: "NORMAL" };
    });
    const outcome = await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(outcome.outcome).toBe("enqueued");
    expect(calls).toEqual(["label", "mirror", "enqueue"]);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 101, "agent/courier-hyper");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 101, "agent/foo");
    // The cache mirror pins the swapped label set so the claimant
    // resolution the enqueue runs sees the post-swap owner.
    expect(mocks.issueUpdateMany).toHaveBeenCalledWith({
      where: { id: "i1", labels: { equals: ["agent/foo"] } },
      data: { labels: ["agent/courier-hyper"] },
    });
    // Audit afterLabels reflects the converged single-label state.
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.afterLabels).toEqual(["agent/courier-hyper"]);
    expect(data.notes).toContain("queueLane=");
  });

  it("converges to exactly one agent label (removes every other, review M3)", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    mocks.fetchIssueLabels.mockResolvedValue(["agent/foo"]);
  mocks.issueFindFirst.mockResolvedValue({ id: "i1", labels: ["agent/foo"] });
  mocks.issueUpdateMany.mockResolvedValue({ count: 1 });
    await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 101, "agent/courier-hyper");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 101, "agent/foo");
  });

  it("aborts without enqueueing when the label swap fails (removals landed, add did not)", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    mocks.addIssueLabel.mockRejectedValue(new Error("422"));
    const outcome = await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(outcome.outcome).toBe("error");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.success).toBe(false);
    expect(data.beforeLabels).toEqual(["agent/foo"]);
    // Remove-first: the old label is already off the issue when the add fails.
    expect(data.afterLabels).toEqual([]);
    // The reply names the dropped assignment so the operator can restore it
    // (review round 3, minor 4).
    const reply = mocks.addIssueComment.mock.calls[0][2];
    expect(reply).toContain("agent/foo was already removed");
  });

  it("aborts before any write when the removal fails (add never lands, review M2 round 2)", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    mocks.removeIssueLabel.mockRejectedValue(new Error("boom"));
    const outcome = await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(outcome.outcome).toBe("error");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    // Add-first would have left TWO agent labels here; remove-first leaves
    // the original single label untouched.
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.beforeLabels).toEqual(["agent/foo"]);
    expect(data.afterLabels).toEqual(["agent/foo"]);
  });

  it("removes the old agent label before adding the target (single-label invariant through the swap)", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    const order: string[] = [];
    mocks.removeIssueLabel.mockImplementation(async () => {
      order.push("remove");
    });
    mocks.addIssueLabel.mockImplementation(async () => {
      order.push("add");
    });
    await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(order).toEqual(["remove", "add"]);
  });

  it("converges the cache mirror after a lost CAS race (retries, then an unconditional write) before enqueueing", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    const order: string[] = [];
    mocks.issueUpdateMany.mockImplementation(async () => {
      order.push("cas");
      return { count: 0 };
    });
    mocks.issueUpdate.mockImplementation(async () => {
      order.push("unconditional");
      return {};
    });
    mocks.enqueuePrFixItem.mockImplementation(async () => {
      order.push("enqueue");
      return { status: "QUEUED", lane: "NORMAL" };
    });
    const outcome = await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(outcome.outcome).toBe("enqueued");
    expect(mocks.enqueuePrFixItem).toHaveBeenCalledTimes(1);
    // The stale cached claimant is overwritten before the enqueue reads it.
    expect(order.indexOf("unconditional")).toBeGreaterThan(-1);
    expect(order.indexOf("enqueue")).toBeGreaterThan(order.indexOf("unconditional"));
    expect(mocks.issueUpdate).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { labels: ["agent/courier-hyper"] },
    });
  });

  it("mirrors the cache without a swap when the issue already carries the requested lane label (review M1 round 2)", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    mocks.fetchIssueLabels.mockResolvedValue(["agent/courier-hyper"]);
    const outcome = await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(outcome.outcome).toBe("enqueued");
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    // The cached row may still lag GitHub: the mirror runs even though the
    // swap itself is a no-op, so the enqueue resolves the target claimant.
    expect(mocks.issueUpdateMany).toHaveBeenCalledWith({
      where: { id: "i1", labels: { equals: ["agent/foo"] } },
      data: { labels: ["agent/courier-hyper"] },
    });
  });

  it("adds the lane label without a removal when the issue has none", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    mocks.fetchIssueLabels.mockResolvedValue(["status/ready"]);
    await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 101, "agent/courier-hyper");
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("is a no-op when the issue already carries exactly the requested lane label", async () => {
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    mocks.fetchIssueLabels.mockResolvedValue(["agent/courier-hyper"]);
    await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("does not swap labels without lane=", async () => {
    await handleDispatchFixCommand(baseCommand());
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("does not apply lane= for a PR author without the operator tier (review M6)", async () => {
    // commenter is the PR author; permission lookup returns read.
    const outcome = await handleDispatchFixCommand(baseCommand({ commentBody: "/dispatch-fix lane=hyper" }));
    expect(outcome.outcome).toBe("enqueued");
    expect(mocks.fetchCollaboratorPermission).toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    const reply = mocks.addIssueComment.mock.calls.at(-1)![2];
    expect(reply).toContain("NOT applied");
  });

  it("rate-limits per actor + PR and audits the refusal", async () => {
    // Three ineligible-but-authorized commands burn the window...
    mocks.fetchPullRequestDetail.mockResolvedValue({ ...PR_DETAIL, draft: true });
    for (let i = 0; i < 3; i++) {
      await handleDispatchFixCommand(baseCommand());
    }
    mocks.fetchPullRequestDetail.mockResolvedValue({ ...PR_DETAIL });
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("rate_limited");
    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(4);
  });

  it("does not share the rate-limit window across actors or PRs", async () => {
    mocks.fetchPullRequestDetail.mockResolvedValue({ ...PR_DETAIL, draft: true });
    for (let i = 0; i < 3; i++) {
      await handleDispatchFixCommand(baseCommand());
    }
    mocks.fetchPullRequestDetail.mockResolvedValue({ ...PR_DETAIL });
    // A different actor on the same PR, and the same actor on a different
    // PR, both keep their own windows.
    mocks.fetchCollaboratorPermission.mockResolvedValue({ status: "ok", permission: "maintain" });
    expect((await handleDispatchFixCommand(baseCommand({ commenter: "maintainer" }))).outcome).toBe("enqueued");
    expect((await handleDispatchFixCommand(baseCommand({ prNumber: 6 }))).outcome).toBe("enqueued");
  });

  it("never throws: an enqueue failure becomes a reply and an audit row", async () => {
    mocks.enqueuePrFixItem.mockRejectedValue(new Error("db down"));
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("error");
    expect(mocks.addIssueComment).toHaveBeenCalled();
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.success).toBe(false);
    expect(data.errorMessage).toContain("db down");
  });

  it("replies and audits when forge state is unavailable", async () => {
    mocks.fetchPullRequestDetail.mockResolvedValue(null);
    const outcome = await handleDispatchFixCommand(baseCommand());
    expect(outcome.outcome).toBe("error");
    expect(mocks.addIssueComment).toHaveBeenCalled();
    const data = mocks.auditLogCreate.mock.calls.at(-1)![0].data;
    expect(data.success).toBe(false);
  });
});
