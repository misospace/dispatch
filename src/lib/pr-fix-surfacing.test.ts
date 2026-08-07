import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildNeedsHumanComment, surfacePrFixBlocked, NEEDS_HUMAN_LABEL, NEEDS_HUMAN_COMMENT_MARKER } from "./pr-fix-surfacing";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue({ url: null }),
    fetchIssueComments: vi.fn().mockResolvedValue([]),
    // Default: an open PR, so the existing cases keep exercising the label/comment
    // paths rather than short-circuiting on the terminal guard.
    fetchPullRequestState: vi.fn().mockResolvedValue({ state: "open", mergedAt: null }),
  },
}));

vi.mock("@/lib/github", () => ({
  addIssueLabel: mocks.addIssueLabel,
  addIssueComment: mocks.addIssueComment,
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
    mocks.fetchIssueComments.mockResolvedValue([]);
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
