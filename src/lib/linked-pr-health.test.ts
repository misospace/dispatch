import { describe, it, expect } from "vitest";
import { computeLinkedPrHealth, computeLinkedPrHealthBatch, enrichQueueItemsWithPrHealth, toPersistedLinkedPrHealth, PrHealthInput } from "./linked-pr-health";

describe("computeLinkedPrHealth", () => {
  it("returns null for draft PRs", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/1",
      number: 1,
      state: "open",
      draft: true,
      mergedAt: null,
      mergeStateStatus: "clean",
      reviewDecision: null,
      checkFailures: [],
    });
    expect(result).toBeNull();
  });

  it("returns null for closed PRs", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/2",
      number: 2,
      state: "closed",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "clean",
      reviewDecision: null,
      checkFailures: [],
    });
    expect(result).toBeNull();
  });

  it("returns null for merged PRs", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/3",
      number: 3,
      state: "merged",
      draft: false,
      mergedAt: "2026-01-01T00:00:00Z",
      mergeStateStatus: "clean",
      reviewDecision: null,
      checkFailures: [],
    });
    expect(result).toBeNull();
  });

  it("detects changes_requested as needing follow-up", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/10",
      number: 10,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "clean",
      reviewDecision: "CHANGES_REQUESTED",
      checkFailures: [],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(true);
    expect(result!.followupReasons).toContain("changes_requested");
  });

  it("detects failing checks as needing follow-up", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/11",
      number: 11,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "clean",
      reviewDecision: null,
      checkFailures: [
        { name: "Docker Build", conclusion: "FAILURE" },
        { name: "Lint", conclusion: "failure" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(true);
    expect(result!.followupReasons).toContain("failing_checks");
    expect(result!.failingChecks.length).toBe(2);
  });

  it("detects merge conflict as needing follow-up", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/12",
      number: 12,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "DIRTY",
      reviewDecision: null,
      checkFailures: [],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(true);
    expect(result!.followupReasons).toContain("merge_conflict");
    expect(result!.hasMergeConflict).toBe(true);
  });

  it("does NOT flag BEHIND alone as needing follow-up", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/13",
      number: 13,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "BEHIND",
      reviewDecision: null,
      checkFailures: [],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(false);
    expect(result!.followupReasons).toEqual([]);
  });

  it("does NOT flag BLOCKED alone as needing follow-up", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/14",
      number: 14,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "BLOCKED",
      reviewDecision: null,
      checkFailures: [],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(false);
    expect(result!.followupReasons).toEqual([]);
  });

  it("flags BEHIND when paired with failing checks", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/15",
      number: 15,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "BEHIND",
      reviewDecision: null,
      checkFailures: [{ name: "CI", conclusion: "failure" }],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(true);
    expect(result!.followupReasons).toContain("failing_checks");
    expect(result!.followupReasons).toContain("merge_state_behind");
  });

  it("flags BLOCKED when paired with changes_requested", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/16",
      number: 16,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "BLOCKED",
      reviewDecision: "CHANGES_REQUESTED",
      checkFailures: [],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(true);
    expect(result!.followupReasons).toContain("changes_requested");
    expect(result!.followupReasons).toContain("merge_state_blocked");
  });

  it("handles healthy PR with no issues", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/20",
      number: 20,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      checkFailures: [],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(false);
    expect(result!.followupReasons).toEqual([]);
  });

  it("handles REVIEW_REQUIRED as not needing follow-up on its own", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/21",
      number: 21,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "clean",
      reviewDecision: "REVIEW_REQUIRED",
      checkFailures: [],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(false);
  });

  it("includes all health metadata fields correctly", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/30",
      number: 30,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "DIRTY",
      reviewDecision: "CHANGES_REQUESTED",
      checkFailures: [
        { name: "Docker Build", conclusion: "FAILURE" },
        { name: "Test Suite", conclusion: "cancelled" },
        { name: "Ignored Check", conclusion: "success" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.linkedPrUrl).toBe("https://github.com/org/repo/pull/30");
    expect(result!.linkedPrNumber).toBe(30);
    expect(result!.reviewDecision).toBe("CHANGES_REQUESTED");
    expect(result!.mergeStateStatus).toBe("DIRTY");
    expect(result!.failingChecks.length).toBe(2); // "success" is filtered out
    expect(result!.hasMergeConflict).toBe(true);
    expect(result!.needsFollowup).toBe(true);
    expect(result!.followupReasons).toContain("changes_requested");
    expect(result!.followupReasons).toContain("failing_checks");
    expect(result!.followupReasons).toContain("merge_conflict");
  });

  it("handles cancelled and timed_out check conclusions", () => {
    const result = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/40",
      number: 40,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "clean",
      reviewDecision: null,
      checkFailures: [
        { name: "Build", conclusion: "cancelled" },
        { name: "Deploy", conclusion: "timed_out" },
        { name: "Action Required", conclusion: "action_required" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.needsFollowup).toBe(true);
    expect(result!.failingChecks.length).toBe(3);
  });
});

describe("computeLinkedPrHealthBatch", () => {
  it("filters out excluded PRs and returns only health snapshots", () => {
    const inputs = [
      {
        url: "https://github.com/org/repo/pull/1",
        number: 1,
        state: "open" as const,
        draft: false,
        mergedAt: null,
        mergeStateStatus: "clean",
        reviewDecision: "CHANGES_REQUESTED",
        checkFailures: [],
      },
      {
        url: "https://github.com/org/repo/pull/2",
        number: 2,
        state: "closed" as const,
        draft: false,
        mergedAt: null,
        mergeStateStatus: "clean",
        reviewDecision: null,
        checkFailures: [],
      },
      {
        url: "https://github.com/org/repo/pull/3",
        number: 3,
        state: "open" as const,
        draft: true,
        mergedAt: null,
        mergeStateStatus: "clean",
        reviewDecision: null,
        checkFailures: [],
      },
      {
        url: "https://github.com/org/repo/pull/4",
        number: 4,
        state: "open" as const,
        draft: false,
        mergedAt: null,
        mergeStateStatus: "clean",
        reviewDecision: null,
        checkFailures: [],
      },
    ];

    const results = computeLinkedPrHealthBatch(inputs);
    expect(results.length).toBe(2);
    expect(results[0].linkedPrNumber).toBe(1);
    expect(results[0].needsFollowup).toBe(true);
    expect(results[1].linkedPrNumber).toBe(4);
    expect(results[1].needsFollowup).toBe(false);
  });

  it("returns empty array for all-excluded inputs", () => {
    const inputs = [
      {
        url: "https://github.com/org/repo/pull/5",
        number: 5,
        state: "merged" as const,
        draft: false,
        mergedAt: "2026-01-01T00:00:00Z",
        mergeStateStatus: "clean",
        reviewDecision: null,
        checkFailures: [],
      },
    ];
    expect(computeLinkedPrHealthBatch(inputs)).toEqual([]);
  });

  it("handles empty input array", () => {
    expect(computeLinkedPrHealthBatch([])).toEqual([]);
  });
});

describe("enrichQueueItemsWithPrHealth", () => {
  it("attaches health data to items with matching PRs", () => {
    const prMap = new Map<number, PrHealthInput>();
    prMap.set(100, {
      url: "https://github.com/org/repo/pull/100",
      number: 100,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "DIRTY",
      reviewDecision: "CHANGES_REQUESTED",
      checkFailures: [],
    });

    const items = [
      {
        type: "issue" as const,
        number: 100,
        title: "Fix bug",
        url: "https://github.com/org/repo/issues/100",
        labels: ["status/ready"],
        priority: null,
        status: "status/ready",
        agentMatch: false,
        rankingReason: "ready",
      },
      {
        type: "issue" as const,
        number: 200,
        title: "Add feature",
        url: "https://github.com/org/repo/issues/200",
        labels: ["status/ready"],
        priority: null,
        status: "status/ready",
        agentMatch: false,
        rankingReason: "ready",
      },
    ];

    const enriched = enrichQueueItemsWithPrHealth(items, prMap);
    expect(enriched.length).toBe(2);
    expect(enriched[0].linkedPrHealth).not.toBeNull();
    expect(enriched[0].linkedPrHealth!.needsFollowup).toBe(true);
    expect(enriched[1].linkedPrHealth).toBeNull();
  });

  it("handles empty items array", () => {
    const enriched = enrichQueueItemsWithPrHealth([], new Map());
    expect(enriched).toEqual([]);
  });

  it("preserves all original item fields while adding linkedPrHealth", () => {
    const prMap = new Map<number, PrHealthInput>();
    prMap.set(10, {
      url: "https://github.com/org/repo/pull/10",
      number: 10,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "clean",
      reviewDecision: null,
      checkFailures: [],
    });

    const items = [
      {
        type: "issue" as const,
        number: 10,
        title: "Test issue",
        url: "https://github.com/org/repo/issues/10",
        labels: ["enhancement", "priority/p1"],
        priority: "priority/p1",
        status: "status/ready",
        agentMatch: true,
        rankingReason: "priority/p1, agent/saffron, ready",
        lane: "normal",
        decomposed: false,
        issueId: "test-id",
        repoFullName: "org/repo",
        claimable: true,
      },
    ];

    const enriched = enrichQueueItemsWithPrHealth(items, prMap);
    expect(enriched[0].number).toBe(10);
    expect(enriched[0].title).toBe("Test issue");
    expect(enriched[0].labels).toEqual(["enhancement", "priority/p1"]);
    expect(enriched[0].agentMatch).toBe(true);
    expect(enriched[0].lane).toBe("normal");
    expect(enriched[0].linkedPrHealth).not.toBeNull();
  });
});

describe("toPersistedLinkedPrHealth", () => {
  const checkedAt = new Date("2026-05-29T12:00:00Z");

  it("maps an actionable health snapshot to persisted columns", () => {
    const health = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/7",
      number: 7,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "dirty",
      reviewDecision: "CHANGES_REQUESTED",
      checkFailures: [{ name: "build", conclusion: "failure" }],
    });

    const persisted = toPersistedLinkedPrHealth(health, checkedAt);
    expect(persisted).toEqual({
      linkedPrNumber: 7,
      linkedPrUrl: "https://github.com/org/repo/pull/7",
      linkedPrNeedsFollowup: true,
      linkedPrFollowupReasons: expect.arrayContaining(["changes_requested", "failing_checks", "merge_conflict"]),
      linkedPrReviewDecision: "CHANGES_REQUESTED",
      linkedPrMergeState: "dirty",
      linkedPrHealthCheckedAt: checkedAt,
    });
  });

  it("clears the columns when health is null (no actionable linked PR)", () => {
    const persisted = toPersistedLinkedPrHealth(null, checkedAt);
    expect(persisted).toEqual({
      linkedPrNumber: null,
      linkedPrUrl: null,
      linkedPrNeedsFollowup: false,
      linkedPrFollowupReasons: [],
      linkedPrReviewDecision: null,
      linkedPrMergeState: null,
      linkedPrHealthCheckedAt: checkedAt,
    });
  });

  it("persists a healthy (non-followup) snapshot without reasons", () => {
    const health = computeLinkedPrHealth({
      url: "https://github.com/org/repo/pull/8",
      number: 8,
      state: "open",
      draft: false,
      mergedAt: null,
      mergeStateStatus: "clean",
      reviewDecision: "APPROVED",
      checkFailures: [],
    });

    const persisted = toPersistedLinkedPrHealth(health, checkedAt);
    expect(persisted.linkedPrNumber).toBe(8);
    expect(persisted.linkedPrNeedsFollowup).toBe(false);
    expect(persisted.linkedPrFollowupReasons).toEqual([]);
    expect(persisted.linkedPrReviewDecision).toBe("APPROVED");
  });
});
