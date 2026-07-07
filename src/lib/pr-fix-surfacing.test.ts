import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildNeedsHumanComment, surfacePrFixBlocked, NEEDS_HUMAN_LABEL, NEEDS_HUMAN_COMMENT_MARKER } from "./pr-fix-surfacing";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue({ url: null }),
  },
}));

vi.mock("@/lib/github", () => ({
  addIssueLabel: mocks.addIssueLabel,
  addIssueComment: mocks.addIssueComment,
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
