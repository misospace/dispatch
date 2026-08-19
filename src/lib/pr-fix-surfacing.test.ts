import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildNeedsHumanComment, surfacePrFixBlocked, surfacePrFixRequeued, NEEDS_HUMAN_LABEL, NEEDS_HUMAN_COMMENT_MARKER } from "./pr-fix-surfacing";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue({ url: null }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    fetchIssueComments: vi.fn().mockResolvedValue([]),
    // Default: an open PR, so the existing cases keep exercising the label/comment
    // paths rather than short-circuiting on the terminal guard.
    fetchPullRequestState: vi.fn().mockResolvedValue({ state: "open", mergedAt: null }),
  },
}));

vi.mock("@/lib/github", () => ({
  addIssueLabel: mocks.addIssueLabel,
  addIssueComment: mocks.addIssueComment,
  updateIssueComment: mocks.updateIssueComment,
  removeIssueLabel: mocks.removeIssueLabel,
  fetchIssueComments: mocks.fetchIssueComments,
  fetchPullRequestState: mocks.fetchPullRequestState,
}));

const baseInput = { repo: "org/repo", pr: 42, reason: "merge conflict" };

describe("buildNeedsHumanComment", () => {
  it("includes the marker sentinel", () => {
    const body = buildNeedsHumanComment(baseInput);
    expect(body).toContain(NEEDS_HUMAN_COMMENT_MARKER);
  });

  it("includes the reason", () => {
    const body = buildNeedsHumanComment(baseInput);
    expect(body).toContain("**Reason:** merge conflict");
  });

  it("includes latestNote when truthy", () => {
    const body = buildNeedsHumanComment({ ...baseInput, latestNote: "operator reviewed" });
    expect(body).toContain("**Latest note:** operator reviewed");
  });

  it("omits latestNote when null or empty", () => {
    expect(buildNeedsHumanComment({ ...baseInput, latestNote: null })).not.toContain("Latest note");
    expect(buildNeedsHumanComment({ ...baseInput, latestNote: "" })).not.toContain("Latest note");
  });

  it("includes the timestamp line", () => {
    const body = buildNeedsHumanComment(baseInput);
    expect(body).toMatch(/Posted automatically by Dispatch on \d{4}-\d{2}-\d{2}T/);
  });
});

describe("surfacePrFixBlocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.addIssueComment.mockResolvedValue({ url: null });
    mocks.updateIssueComment.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.fetchIssueComments.mockResolvedValue([]);
    mocks.fetchPullRequestState.mockResolvedValue({ state: "open", mergedAt: null });
  });

  it("does NOT re-post when a marker comment already exists (the #264 spam fix)", async () => {
    mocks.fetchIssueComments.mockResolvedValue([
      { body: "unrelated" },
      { body: `${NEEDS_HUMAN_COMMENT_MARKER}\n> already surfaced earlier` },
    ]);

    const result = await surfacePrFixBlocked(baseInput);

    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.labelApplied).toBe(true); // label is idempotent, still applied
  });

  it("updates an existing marker comment in place when it has an id (re-block)", async () => {
    mocks.fetchIssueComments.mockResolvedValue([
      { id: 9, body: `${NEEDS_HUMAN_COMMENT_MARKER}\n> old block` },
    ]);

    const result = await surfacePrFixBlocked(baseInput);

    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(false);
    expect(result.commentUpdated).toBe(true);
    expect(mocks.updateIssueComment).toHaveBeenCalledWith(
      "org/repo",
      9,
      expect.stringContaining(NEEDS_HUMAN_COMMENT_MARKER),
    );
    expect(result.errors).toEqual([]);
  });

  it("does not duplicate or update when the marker has no id (old/mocked caller)", async () => {
    mocks.fetchIssueComments.mockResolvedValue([
      { body: `${NEEDS_HUMAN_COMMENT_MARKER}\n> some block` },
    ]);

    const result = await surfacePrFixBlocked(baseInput);

    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(mocks.updateIssueComment).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(false);
    expect(result.commentUpdated).toBe(false);
  });

  it("does not edit a human comment that only quotes the marker", async () => {
    mocks.fetchIssueComments.mockResolvedValue([
      { id: 10, body: `I found this marker: ${NEEDS_HUMAN_COMMENT_MARKER}` },
    ]);

    const result = await surfacePrFixBlocked(baseInput);

    expect(mocks.addIssueComment).toHaveBeenCalled();
    expect(mocks.updateIssueComment).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(true);
    expect(result.commentUpdated).toBe(false);
  });

  it("does not post (and does not throw) when the comment lookup fails", async () => {
    mocks.fetchIssueComments.mockRejectedValue(new Error("GitHub API error: 502"));

    const result = await surfacePrFixBlocked(baseInput);

    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^comment:/);
  });

  it("calls addIssueLabel and addIssueComment with correct args", async () => {
    const result = await surfacePrFixBlocked(baseInput);

    expect(result.labelApplied).toBe(true);
    expect(result.commentPosted).toBe(true);
    expect(result.errors).toEqual([]);

    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, NEEDS_HUMAN_LABEL);
    expect(mocks.addIssueComment).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.stringContaining(NEEDS_HUMAN_COMMENT_MARKER),
    );
    expect(mocks.addIssueComment.mock.calls[0][2]).toContain("**Reason:** merge conflict");
  });

  it("treats 422 label error as success (idempotency)", async () => {
    mocks.addIssueLabel.mockRejectedValue(new Error("GitHub API error: 422 Already been added"));

    const result = await surfacePrFixBlocked(baseInput);

    expect(result.labelApplied).toBe(true);
    expect(result.commentPosted).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("captures comment error but keeps labelApplied true", async () => {
    mocks.addIssueComment.mockRejectedValue(new Error("GitHub API error: 500 server error"));

    const result = await surfacePrFixBlocked(baseInput);

    expect(result.labelApplied).toBe(true);
    expect(result.commentPosted).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^comment:/);
  });

  it("captures both errors when both fail", async () => {
    mocks.addIssueLabel.mockRejectedValue(new Error("GitHub API error: 503 label fail"));
    mocks.addIssueComment.mockRejectedValue(new Error("GitHub API error: 503 comment fail"));

    const result = await surfacePrFixBlocked(baseInput);

    expect(result.labelApplied).toBe(false);
    expect(result.commentPosted).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatch(/^label:/);
    expect(result.errors[1]).toMatch(/^comment:/);
  });
});

// A PR merged 2026-05-14 received a "needs human attention" comment on 2026-08-06.
// A BLOCKED item can outlive its PR — a leftover queue row, a late status
// transition, a re-queue racing a merge — and writing to a finished PR is pure
// noise that erodes trust in the notifications that are real.
describe("surfacePrFixBlocked — terminal PR guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.addIssueComment.mockResolvedValue({ url: null });
    mocks.updateIssueComment.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.fetchIssueComments.mockResolvedValue([]);
    mocks.fetchPullRequestState.mockResolvedValue({ state: "open", mergedAt: null });
  });

  it("writes nothing when the PR is merged", async () => {
    mocks.fetchPullRequestState.mockResolvedValue({ state: "closed", mergedAt: "2026-05-14T22:00:19Z" });
    const res = await surfacePrFixBlocked(baseInput);
    expect(res.skippedTerminal).toBe(true);
    expect(res.labelApplied).toBe(false);
    expect(res.commentPosted).toBe(false);
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
  });

  it("writes nothing when the PR is closed unmerged", async () => {
    mocks.fetchPullRequestState.mockResolvedValue({ state: "closed", mergedAt: null });
    const res = await surfacePrFixBlocked(baseInput);
    expect(res.skippedTerminal).toBe(true);
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
  });

  it("writes nothing when the state is unknown", async () => {
    // Unknown is treated as terminal, matching the idempotency guard's existing
    // choice: when in doubt, do not write. A missed notification is recoverable
    // from the queue; a comment on a dead PR is not retractable.
    mocks.fetchPullRequestState.mockResolvedValue({ state: null, mergedAt: null });
    const res = await surfacePrFixBlocked(baseInput);
    expect(res.skippedTerminal).toBe(true);
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
  });

  it("does not throw when the PR state lookup throws", async () => {
    mocks.fetchPullRequestState.mockRejectedValue(new Error("network down"));
    const res = await surfacePrFixBlocked(baseInput);
    expect(res.skippedTerminal).toBe(true);
    expect(res.errors).toEqual([]);
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
  });

  it("reports no errors when it skips — a finished PR is not a failure", async () => {
    mocks.fetchPullRequestState.mockResolvedValue({ state: "closed", mergedAt: "2026-05-14T22:00:19Z" });
    const res = await surfacePrFixBlocked(baseInput);
    expect(res.errors).toEqual([]);
  });

  it("still labels and comments on an open PR", async () => {
    const res = await surfacePrFixBlocked(baseInput);
    expect(res.skippedTerminal).toBe(false);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, NEEDS_HUMAN_LABEL);
    expect(mocks.addIssueComment).toHaveBeenCalled();
  });

  it("checks the PR state before writing anything", async () => {
    // Ordering matters: a label applied before the check would still be noise.
    const order: string[] = [];
    mocks.fetchPullRequestState.mockImplementation(async () => {
      order.push("state");
      return { state: "closed", mergedAt: null };
    });
    mocks.addIssueLabel.mockImplementation(async () => { order.push("label"); });
    await surfacePrFixBlocked(baseInput);
    expect(order).toEqual(["state"]);
  });
});

describe("buildNeedsHumanComment — richer context", () => {
  it("renders totalAttempts, attemptsByLane, finalFailure, run links, and last attempt", () => {
    const body = buildNeedsHumanComment({
      ...baseInput,
      context: {
        totalAttempts: 3,
        attemptsByLane: { NORMAL: 2, ESCALATED: 1 },
        finalFailureSignature: "tests failed after 3 attempts",
        failingRunLinks: ["https://github.com/org/repo/actions/runs/42"],
        lastAttemptSummary: "final attempt still failing",
      },
    });

    expect(body).toContain("**Total attempts:** 3");
    expect(body).toContain("**NORMAL:** 2 attempts");
    expect(body).toContain("**ESCALATED:** 1 attempt");
    expect(body).toContain("**Final failure:** tests failed after 3 attempts");
    expect(body).toContain("https://github.com/org/repo/actions/runs/42");
    expect(body).toContain("**Last attempt:** final attempt still failing");
  });

  it("omits context sections that are absent (backwards compatible)", () => {
    const body = buildNeedsHumanComment(baseInput);
    expect(body).not.toContain("Total attempts");
    expect(body).not.toContain("Attempts by lane");
    expect(body).not.toContain("Final failure");
    expect(body).not.toContain("Last attempt");
  });

  it("omits empty attemptsByLane and no-op context", () => {
    const body = buildNeedsHumanComment({ ...baseInput, context: { attemptsByLane: {} } });
    expect(body).not.toContain("Attempts by lane");
  });
});

describe("surfacePrFixRequeued", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.updateIssueComment.mockResolvedValue(undefined);
    mocks.fetchIssueComments.mockResolvedValue([]);
    mocks.fetchPullRequestState.mockResolvedValue({ state: "open", mergedAt: null });
  });

  it("removes the label and folds the marker comment into a requeued notice", async () => {
    mocks.fetchIssueComments.mockResolvedValue([
      { id: 5, body: `${NEEDS_HUMAN_COMMENT_MARKER}\n> old block` },
    ]);

    const result = await surfacePrFixRequeued("org/repo", 42, "re-running");

    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, NEEDS_HUMAN_LABEL);
    expect(result.labelRemoved).toBe(true);
    expect(mocks.updateIssueComment).toHaveBeenCalledWith(
      "org/repo",
      5,
      expect.stringContaining("requeued"),
    );
    expect(result.commentUpdated).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("does nothing on a terminal PR (no label, no comment write)", async () => {
    mocks.fetchPullRequestState.mockResolvedValue({ state: "closed", mergedAt: "2026-05-14T22:00:19Z" });
    mocks.fetchIssueComments.mockResolvedValue([{ id: 5, body: `${NEEDS_HUMAN_COMMENT_MARKER}` }]);

    const result = await surfacePrFixRequeued("org/repo", 42);

    expect(result.skippedTerminal).toBe(true);
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.updateIssueComment).not.toHaveBeenCalled();
  });

  it("does not throw when the requeue PR state lookup throws", async () => {
    mocks.fetchPullRequestState.mockRejectedValue(new Error("network down"));
    const result = await surfacePrFixRequeued("org/repo", 42);
    expect(result.skippedTerminal).toBe(true);
    expect(result.errors).toEqual([]);
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.updateIssueComment).not.toHaveBeenCalled();
  });

  it("does not update a human comment that only quotes the marker", async () => {
    mocks.fetchIssueComments.mockResolvedValue([
      { id: 6, body: `Quoted marker: ${NEEDS_HUMAN_COMMENT_MARKER}` },
    ]);

    const result = await surfacePrFixRequeued("org/repo", 42);

    expect(mocks.removeIssueLabel).toHaveBeenCalled();
    expect(mocks.updateIssueComment).not.toHaveBeenCalled();
    expect(result.commentUpdated).toBe(false);
  });

  it("is best-effort and captures label errors", async () => {
    mocks.removeIssueLabel.mockRejectedValue(new Error("GitHub API error: 500 label fail"));

    const result = await surfacePrFixRequeued("org/repo", 42);

    expect(result.labelRemoved).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^label:/);
    expect(result.commentUpdated).toBe(false);
  });
});
