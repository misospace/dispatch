import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/client-auth", () => ({
  authedFetch: vi.fn(),
}));

vi.mock("@/lib/version", () => ({
  getVersion: vi.fn(() => "1.0.0"),
}));

import { DeliveryCohortsClient } from "./delivery-cohorts-client";
import { authedFetch } from "@/lib/client-auth";

const deliveryResponse = {
  schema: "dispatch.delivery-cohorts/v1",
  window: {
    since: "2026-06-01T00:00:00.000Z",
    until: "2026-07-01T00:00:00.000Z",
  },
  groupBy: "model",
  repo: null,
  definitions: {},
  cohorts: [
    {
      key: "gpt-5.5",
      sampleCount: 1,
      delivery: { merged: 1, "closed-unmerged": 0, open: 0, unknown: 0 },
      completionRate: 1,
      claimToDone: {
        samples: 1,
        min: 3600000,
        max: 3600000,
        mean: 3600000,
        p50: 3600000,
        p90: 3600000,
      },
      claimToMerge: {
        samples: 1,
        min: 1800000,
        max: 1800000,
        mean: 1800000,
        p50: 1800000,
        p90: 1800000,
      },
      workerTimeMs: 600000,
      firstPass: { true: 1, false: 0, null: 0 },
      mergedThroughputPerDay: 1,
      openAges: { count: 0, medianOpenMs: null, oldestOpenMs: null },
      fixRounds: { total: 0, itemsWithFixes: 0 },
      failures: { itemsWithFailedAttempts: 1, totalFailedAttempts: 2 },
      waiting: {
        activeExecutionMs: 600000,
        pickupMs: 60000,
        inReviewMs: null,
        blockedMs: 900000,
        fixQueuedMs: null,
        unclassifiedMs: 0,
      },
      confounders: {
        mixedSettings: 0,
        missingMetadata: 0,
        distinctRuntimeRevisions: ["a"],
        distinctModels: ["gpt-5.5"],
        distinctWorkers: ["alpha"],
        maxConcurrentRuns: 2,
      },
    },
  ],
  totals: {
    key: "all",
    sampleCount: 1,
    delivery: { merged: 1, "closed-unmerged": 0, open: 0, unknown: 0 },
    completionRate: 1,
    claimToDone: null,
    claimToMerge: null,
    workerTimeMs: null,
    firstPass: { true: 0, false: 0, null: 1 },
    mergedThroughputPerDay: 0,
    openAges: { count: 0, medianOpenMs: null, oldestOpenMs: null },
    fixRounds: { total: 0, itemsWithFixes: 0 },
    failures: { itemsWithFailedAttempts: 0, totalFailedAttempts: 0 },
    waiting: {
      activeExecutionMs: null,
      pickupMs: null,
      inReviewMs: null,
      blockedMs: null,
      fixQueuedMs: null,
      unclassifiedMs: 1000,
    },
    confounders: {
      mixedSettings: 0,
      missingMetadata: 0,
      distinctRuntimeRevisions: [],
      distinctModels: [],
      distinctWorkers: [],
      maxConcurrentRuns: null,
    },
  },
  samples: [
    {
      issueId: "org/repo#7",
      dbIssueId: "db-issue-1",
      repoFullName: "org/repo",
      issueNumber: 7,
      delivery: "merged",
      firstClaimAt: "2026-06-10T00:00:00.000Z",
      firstMergedAt: "2026-06-10T00:30:00.000Z",
      doneAt: "2026-06-10T01:00:00.000Z",
      doneAtProvenance: "backfilled",
      claimToDoneMs: 3600000,
      claimToMergeMs: 1800000,
      workerTimeMs: 600000,
      observedWaits: {
        pickupMs: 240000,
        inReviewMs: 300000,
        blockedMs: null,
        fixQueuedMs: 60000,
      },
      unclassifiedMs: 0,
      firstPass: true,
      executionAttempts: 1,
      failedAttempts: 0,
      fixRounds: 0,
      cohortKeys: {
        cohort: "c1",
        model: "gpt-5.5",
        worker: "alpha",
        runtimeRevision: "a",
        reasoningEffort: "unknown",
        repository: "org/repo",
        taskType: "feature",
      },
      mixedSettings: false,
      settings: {
        worker: "alpha",
        model: "gpt-5.5",
        reasoningEffort: null,
        runtimeRevision: "a",
      },
      missing: [],
      excludedFromDurations: false,
      ageMs: null,
      taskType: "feature",
      runIntervalsMs: [
        { startMs: 1749000000000, endMs: 1749000600000 },
      ],
    },
  ],
  sampleCount: 1,
  truncated: false,
  notes: [],
};

const lifecycleResponse = {
  issue: {
    id: "db-issue-1",
    repoFullName: "org/repo",
    issueNumber: 7,
    state: "closed",
    url: "https://github.com/org/repo/issues/7",
  },
  timeline: {
    schema: "dispatch.issue-lifecycle-timeline/v1",
    units: "milliseconds",
    claims: [
      {
        agentName: "alpha",
        actor: "agent/alpha",
        source: "api:claim",
        at: "2026-06-10T00:00:00.000Z",
        observedAt: "2026-06-10T00:00:00.000Z",
        provenance: "backfilled",
      },
    ],
    firstClaim: {
      at: "2026-06-10T00:00:00.000Z",
      provenance: "backfilled",
      via: ["claim"],
    },
    doneAt: {
      at: "2026-06-10T01:00:00.000Z",
      provenance: "backfilled",
      via: ["completed"],
    },
    closedAt: {
      at: "2026-06-10T01:30:00.000Z",
      provenance: "observed",
      via: ["issue_closed"],
    },
    lastReopenAt: { at: null, provenance: "unknown", via: [] },
    pullRequests: [
      {
        prNumber: 101,
        prUrl: "https://github.com/org/repo/pull/101",
        mergedAt: "2026-06-10T00:30:00.000Z",
        mergeCommitSha: "abc",
        headSha: "def",
        linkSource: "sync",
        provenance: "observed",
      },
    ],
    firstMergedAt: {
      at: "2026-06-10T00:30:00.000Z",
      provenance: "observed",
      via: ["pr_merged"],
    },
    delivery: "merged",
    claimToDoneMs: 3600000,
    claimToMergeMs: 1800000,
    notes: ["duplicate observation collapsed"],
  },
  events: [],
  truncated: false,
  attempts: {
    schema: "dispatch.work-item-attempt-chain/v1",
    units: "milliseconds",
    workItem: { repoFullName: "org/repo", issueNumber: 7 },
    attempts: [
      {
        attemptId: "attempt-1",
        kind: "execution",
        agentName: "alpha",
        claimedAt: { at: "2026-06-10T00:00:00.000Z", provenance: "observed" },
        startedAt: "2026-06-10T00:02:00.000Z",
        endedAt: "2026-06-10T00:10:00.000Z",
        reportedAt: "2026-06-10T00:11:00.000Z",
        outcome: "success",
        classification: "active-execution",
        executionMetadata: {
          workerProduct: "opencode",
          model: "gpt-5.5",
          reasoningEffort: "high",
          runtimeRevision: "a",
          cohortLabel: "c1",
        },
        artifacts: { agentRunIds: ["run-1"], pullRequestNumbers: [101] },
        wallTimeMs: 480000,
        prFix: null,
      },
      {
        attemptId: "attempt-2",
        kind: "fix-round",
        agentName: "alpha",
        claimedAt: { at: "2026-06-10T00:12:00.000Z", provenance: "observed" },
        startedAt: "2026-06-10T00:13:00.000Z",
        endedAt: "2026-06-10T00:20:00.000Z",
        reportedAt: "2026-06-10T00:21:00.000Z",
        outcome: "superseded",
        classification: "waiting-review",
        executionMetadata: {
          workerProduct: "opencode",
          model: "gpt-5.5",
          reasoningEffort: null,
          runtimeRevision: "a",
          cohortLabel: "c1",
        },
        artifacts: { agentRunIds: ["run-2"], pullRequestNumbers: [] },
        wallTimeMs: 420000,
        prFix: { itemId: "fix-1", repo: "org/repo", pr: 101, type: "REVIEW_FEEDBACK" },
      },
    ],
    prFixEvents: [],
    prFixEventsTruncated: false,
    totalExecutionWallTimeMs: 900000,
    notes: [],
  },
  attemptsTruncated: false,
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe("DeliveryCohortsClient", () => {
  beforeEach(() => {
    vi.mocked(authedFetch).mockReset();
    vi.mocked(authedFetch).mockImplementation(async (url: string) => {
      if (url.includes("/lifecycle")) {
        return jsonResponse(lifecycleResponse);
      }
      return jsonResponse(deliveryResponse);
    });
  });

  it("renders cohorts and samples with observed wait buckets", async () => {
    render(<DeliveryCohortsClient />);

    // Wait for the sample row to appear.
    await screen.findByText("org/repo#7");

    // Sample-level observed wait buckets.
    expect(screen.getByText("pickup 4m")).toBeInTheDocument();
    expect(screen.getByText("in review 5m")).toBeInTheDocument();
    expect(screen.getByText("fix queued 1m")).toBeInTheDocument();

    // Cohort-level observed wait buckets (distinct values so they are unique).
    expect(screen.getByText("pickup 1m")).toBeInTheDocument();
    expect(screen.getByText("blocked 15m")).toBeInTheDocument();

    // Cohort confounder badge for concurrent runs.
    expect(screen.getByText("2 concurrent runs")).toBeInTheDocument();

    // Cohort-overview failure visibility (#1184): the cohort row surfaces
    // items with failed attempts and the summed failed attempts; the clean
    // totals row reports zero without inventing any new population.
    expect(
      screen.getByText("1 with failed attempts · 2 failed attempts"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("0 with failed attempts · 0 failed attempts"),
    ).toBeInTheDocument();

    // The all-null totals bucket renders the muted "waits unknown" line.
    expect(screen.getByText("waits unknown")).toBeInTheDocument();
  });

  it("expands the per-sample lifecycle drill-down from the Timeline button", async () => {
    const user = userEvent.setup();
    render(<DeliveryCohortsClient />);

    const timelineButton = await screen.findByRole("button", { name: "Timeline" });
    await user.click(timelineButton);

    // The lifecycle route is fetched for the sample's dbIssueId.
    expect(authedFetch).toHaveBeenCalledWith("/api/issues/db-issue-1/lifecycle");

    // Merged pull request is linked.
    const prLink = await screen.findByText("#101");
    expect(prLink).toHaveAttribute("href", "https://github.com/org/repo/pull/101");

    // Attempt outcomes (execution success + fix-round superseded) are present.
    expect(screen.getAllByText(/success/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/superseded/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/fix-round/).length).toBeGreaterThan(0);

// Milestone labels render.
expect(screen.getAllByText(/first merge/).length).toBeGreaterThan(0);
// Provenance badges render every observed value, not just backfilled (#1184 review).
expect(screen.getAllByText("backfilled").length).toBeGreaterThan(0);
expect(screen.getAllByText("observed").length).toBeGreaterThan(0);
// Every NON-NULL milestone row carries its own provenance, not just done
// (#1184 round 5): first claim is a backfilled non-done milestone, closed an
// observed one. Scoped to the drill-down panel so the queries stay unique
// even if a "closed"/"first claim" label appears elsewhere on the page.
const drilldown = screen
  .getByText(
    "Fetched on demand from the per-item lifecycle route; it may reflect a later database state than the cohort snapshot above.",
  )
  .closest("div");
expect(drilldown).not.toBeNull();
const firstClaimMilestone = within(drilldown as HTMLElement)
  .getByText("first claim")
  .closest("div");
expect(firstClaimMilestone).not.toBeNull();
expect(within(firstClaimMilestone as HTMLElement).getByText("backfilled")).toBeInTheDocument();
const closedMilestone = within(drilldown as HTMLElement)
  .getByText("closed")
  .closest("div");
expect(closedMilestone).not.toBeNull();
expect(within(closedMilestone as HTMLElement).getByText("observed")).toBeInTheDocument();
// Drill-down discloses that the lifecycle read is on demand, not a cohort snapshot.
expect(
  screen.getByText(
    "Fetched on demand from the per-item lifecycle route; it may reflect a later database state than the cohort snapshot above.",
  ),
).toBeInTheDocument();

    // Issue link points at the GitHub issue.
    const issueLink = screen.getByRole("link", { name: "Issue" });
    expect(issueLink).toHaveAttribute("href", "https://github.com/org/repo/issues/7");
  });
});
