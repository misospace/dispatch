import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildNeedsHumanComment, buildParkedComment, surfacePrFixBlocked, surfacePrFixParked, surfacePrFixRequeued, surfacePrFixUnblocked, NEEDS_HUMAN_LABEL, NEEDS_HUMAN_COMMENT_MARKER, PARKED_COMMENT_MARKER } from "./pr-fix-surfacing";

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

  it("renders the decision question, options, and evidence when present (#1218)", () => {
    const body = buildNeedsHumanComment({
      ...baseInput,
      decision: {
        question: "Should we keep the legacy endpoint?",
        options: ["Keep it", "Remove it"],
        evidence: "Breaking change in the public API.",
      },
    });
    expect(body).toContain("**Decision needed:** Should we keep the legacy endpoint?");
    expect(body).toContain("**Options:**");
    expect(body).toContain("- Keep it");
    expect(body).toContain("- Remove it");
    expect(body).toContain("**Evidence:** Breaking change in the public API.");
  });

  it("omits the decision block when absent", () => {
    const body = buildNeedsHumanComment(baseInput);
    expect(body).not.toContain("Decision needed");
    expect(body).not.toContain("**Options:**");
    expect(body).not.toContain("**Evidence:**");
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
  it("renders workerExecutions and enqueueRows separately, never as 'attempts' (#1218)", () => {
    // Freeze the footer timestamp so the rendered body is byte-stable across
    // wall-clock millisecond values (#1257). The legacy `totalAttempts` value
    // below (99) used to collide with the footer timestamp's millisecond field
    // whenever it happened to contain two consecutive nines.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const body = buildNeedsHumanComment({
        ...baseInput,
        context: {
          workerExecutions: 3,
          enqueueRows: 7,
          attemptsByLane: { NORMAL: 2, ESCALATED: 1 },
          finalFailureSignature: "tests failed after 3 attempts",
          failingRunLinks: ["https://github.com/org/repo/actions/runs/42"],
          lastAttemptSummary: "final attempt still failing",
          // Retained for back-compat but must NOT be rendered as "attempts".
          totalAttempts: 99,
        },
      });

      expect(body).toContain("**Worker executions:** 3");
      expect(body).toContain("**Enqueue rows:** 7");
      expect(body).toContain("**Enqueues by lane:**");
      expect(body).toContain("**NORMAL:** 2");
      expect(body).toContain("**ESCALATED:** 1");
      expect(body).toContain("**Final failure:** tests failed after 3 attempts");
      expect(body).toContain("https://github.com/org/repo/actions/runs/42");
      expect(body).toContain("**Last attempt:** final attempt still failing");
      // The legacy totalAttempts is never rendered as "attempts". The
      // label-level guard above is sufficient — a bare-digit guard on the value
      // collides with the timestamp footer (~79 ms triples, ~299/399/.../999).
      expect(body).not.toContain("Total attempts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits context sections that are absent (backwards compatible)", () => {
    const body = buildNeedsHumanComment(baseInput);
    expect(body).not.toContain("Worker executions");
    expect(body).not.toContain("Enqueue rows");
    expect(body).not.toContain("Enqueues by lane");
    expect(body).not.toContain("Final failure");
    expect(body).not.toContain("Last attempt");
  });

  it("omits empty attemptsByLane and no-op context", () => {
    const body = buildNeedsHumanComment({ ...baseInput, context: { attemptsByLane: {} } });
    expect(body).not.toContain("Enqueues by lane");
  });
});

describe("buildParkedComment (#1218)", () => {
  it("includes the parked marker, reason, and outcome", () => {
    const body = buildParkedComment({ ...baseInput, reason: "bounded at 5 attempts", outcome: "no_progress" });
    expect(body).toContain(PARKED_COMMENT_MARKER);
    expect(body).toContain("**Reason:** bounded at 5 attempts");
    expect(body).toContain("**Outcome:** no_progress");
    expect(body).not.toContain(NEEDS_HUMAN_COMMENT_MARKER);
    expect(body).toMatch(/Posted automatically by Dispatch on \d{4}-\d{2}-\d{2}T/);
  });

  it("defaults a missing/unknown outcome to no_progress", () => {
    expect(buildParkedComment(baseInput)).toContain("**Outcome:** no_progress");
    expect(buildParkedComment({ ...baseInput, outcome: "nonsense" })).toContain("**Outcome:** no_progress");
  });

  it("renders infra_failure and security_failure headlines", () => {
    expect(buildParkedComment({ ...baseInput, outcome: "infra_failure" })).toContain("infrastructure or authentication failure");
    expect(buildParkedComment({ ...baseInput, outcome: "security_failure" })).toContain("security failure");
  });

  it("renders metrics and context without the needs-human claim", () => {
    const body = buildParkedComment({
      ...baseInput,
      outcome: "no_progress",
      context: { workerExecutions: 5, enqueueRows: 12, lastAttemptSummary: "still failing" },
    });
    expect(body).toContain("**Worker executions:** 5");
    expect(body).toContain("**Enqueue rows:** 12");
    expect(body).toContain("**Last attempt:** still failing");
    expect(body).not.toContain("needs human attention");
  });
});

describe("surfacePrFixParked (#1218)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.addIssueComment.mockResolvedValue({ url: null });
    mocks.updateIssueComment.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.fetchIssueComments.mockResolvedValue([]);
    mocks.fetchPullRequestState.mockResolvedValue({ state: "open", mergedAt: null });
  });

  it("posts a parked comment and applies NO label", async () => {
    const result = await surfacePrFixParked({ ...baseInput, outcome: "no_progress" });
    expect(mocks.addIssueComment).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.stringContaining(PARKED_COMMENT_MARKER),
    );
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("updates an existing needs-human marker comment in place (single marker)", async () => {
    mocks.fetchIssueComments.mockResolvedValue([
      { id: 11, body: `${NEEDS_HUMAN_COMMENT_MARKER}\n> old block` },
    ]);
    const result = await surfacePrFixParked({ ...baseInput, outcome: "no_progress" });
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(result.commentUpdated).toBe(true);
    expect(mocks.updateIssueComment).toHaveBeenCalledWith(
      "org/repo",
      11,
      expect.stringContaining(PARKED_COMMENT_MARKER),
    );
  });

  it("writes nothing on a terminal PR", async () => {
    mocks.fetchPullRequestState.mockResolvedValue({ state: "closed", mergedAt: "2026-05-14T22:00:19Z" });
    const result = await surfacePrFixParked({ ...baseInput, outcome: "no_progress" });
    expect(result.skippedTerminal).toBe(true);
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
  });

  it("never throws when the comment lookup fails", async () => {
    mocks.fetchIssueComments.mockRejectedValue(new Error("GitHub API error: 502"));
    const result = await surfacePrFixParked({ ...baseInput, outcome: "no_progress" });
    expect(result.commentPosted).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("retracts the needs-human label when removeNeedsHumanLabel is set (#1218)", async () => {
    const result = await surfacePrFixParked({
      ...baseInput,
      outcome: "no_progress",
      removeNeedsHumanLabel: true,
    });
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, NEEDS_HUMAN_LABEL);
    expect(result.labelRemoved).toBe(true);
    // The retraction happens before/with the parked notice, never in place of it.
    expect(mocks.addIssueComment).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.stringContaining(PARKED_COMMENT_MARKER),
    );
    expect(result.errors).toEqual([]);
  });

  it("leaves the needs-human label alone when removeNeedsHumanLabel is absent", async () => {
    const result = await surfacePrFixParked({ ...baseInput, outcome: "no_progress" });
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(result.labelRemoved).toBe(false);
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

describe("surfacePrFixUnblocked (#1105)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.updateIssueComment.mockResolvedValue(undefined);
    mocks.fetchPullRequestState.mockResolvedValue({ state: "open", mergedAt: null });
    mocks.fetchIssueComments.mockResolvedValue([{ id: 7, body: `${NEEDS_HUMAN_COMMENT_MARKER}\n> old block` }]);
  });

  it("folds the marker into a resolved notice and drops the label", async () => {
    const result = await surfacePrFixUnblocked("org/repo", 42, "resolved", "approved at abc123");

    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, NEEDS_HUMAN_LABEL);
    const body = mocks.updateIssueComment.mock.calls[0][2] as string;
    expect(body.startsWith(NEEDS_HUMAN_COMMENT_MARKER)).toBe(true);
    expect(body).toContain("**resolved**");
    expect(body).not.toContain("requeued");
    expect(body).toContain("approved at abc123");
    expect(result).toMatchObject({ labelRemoved: true, commentUpdated: true, errors: [] });
  });

  it("uses the requeued notice for the requeued outcome", async () => {
    await surfacePrFixUnblocked("org/repo", 42, "requeued");
    expect(mocks.updateIssueComment.mock.calls[0][2]).toContain("**requeued**");
  });

  it("detects and folds a PARKED marker, preserving it (#1218)", async () => {
    mocks.fetchIssueComments.mockResolvedValue([
      { id: 8, body: `${PARKED_COMMENT_MARKER}\n> parked after 5 attempts` },
    ]);
    const result = await surfacePrFixUnblocked("org/repo", 42, "requeued", "operator released");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, NEEDS_HUMAN_LABEL);
    const body = mocks.updateIssueComment.mock.calls[0][2] as string;
    expect(body.startsWith(PARKED_COMMENT_MARKER)).toBe(true);
    expect(body).toContain("**requeued**");
    expect(body).toContain("operator released");
    expect(result).toMatchObject({ labelRemoved: true, commentUpdated: true, errors: [] });
  });
});
