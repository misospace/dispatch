import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import AutomationOverview from "./page";

const { mockAuthedFetch } = vi.hoisted(() => ({
  mockAuthedFetch: vi.fn(),
}));

vi.mock("@/lib/client-auth", () => ({
  authedFetch: mockAuthedFetch,
}));

const SYNCED_NOW = "2026-10-30T11:55:00.000Z";

function repoFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    fullName: "org/repo",
    name: "repo",
    owner: "org",
    defaultBranch: "main",
    latestCommitSha: "abc1234",
    openPRCount: 1,
    lastSyncedAt: SYNCED_NOW,
    syncError: null,
    source: "env",
    workflows: [],
    releases: [{ id: "r1", tagName: "v0.1.12", publishedAt: "2026-10-25T12:00:00.000Z" }],
    _count: { workflows: 0, releases: 1 },
    failingRuns: 0,
    runningRuns: 0,
    enabled: true,
    releaseDeltaSyncedAt: SYNCED_NOW,
    readiness: { state: "candidate", reasons: ["18 unreleased commits"] },
    pulse: {
      schema: "dispatch.release-pulse/v1",
      pulseState: "ready",
      baseline: { tag: "v0.1.12", sha: "abc", publishedAt: "2026-10-25T12:00:00.000Z" },
      headSha: "def",
      unreleasedCommits: { state: "ahead", count: 18 },
      deliveredIssueCount: 2,
      highlights: [],
      highlightsTruncated: false,
      notableDeliveryCount: 0,
      completedUmbrellaCount: 0,
      unknownDeliveryCount: 0,
    },
    ...overrides,
  };
}

function mockRepos(repos: unknown[]) {
  // The page also loads the PR fix queue; keep that call inert.
  mockAuthedFetch.mockImplementation((url: string) => {
    if (url.startsWith("/api/pr-fix-queue")) {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    return Promise.resolve({ ok: true, json: async () => repos });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Deterministic clock: the fleet card derives age/staleness from `new Date()`.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-30T12:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Automation fleet page — release pulse (dispatch#1484)", () => {
  it("renders all pulse states with deterministic fixtures", async () => {
    mockRepos([
      repoFixture({
        id: "a",
        fullName: "org/candidate",
        pulse: { ...repoFixture().pulse, repoFullName: "org/candidate" },
        readiness: { state: "candidate", reasons: ["18 unreleased commits"] },
      }),
      repoFixture({
        id: "b",
        fullName: "org/building",
        pulse: {
          ...repoFixture().pulse,
          repoFullName: "org/building",
          unreleasedCommits: { state: "ahead", count: 2 },
        },
        readiness: { state: "building", reasons: ["2 unreleased commits"] },
      }),
      repoFixture({
        id: "c",
        fullName: "org/quiet",
        pulse: {
          ...repoFixture().pulse,
          repoFullName: "org/quiet",
          unreleasedCommits: { state: "identical", count: 0 },
        },
        readiness: { state: "quiet", reasons: ["No unreleased commits since v0.1.12."] },
      }),
      repoFixture({
        id: "d",
        fullName: "org/unknown",
        pulse: {
          ...repoFixture().pulse,
          repoFullName: "org/unknown",
          pulseState: "unknown",
          baseline: null,
          unreleasedCommits: { state: "diverged", count: null },
        },
        readiness: { state: "unknown", reasons: ["Release delta is diverged."] },
      }),
      repoFixture({
        id: "e",
        fullName: "org/nobaseline",
        pulse: {
          ...repoFixture().pulse,
          repoFullName: "org/nobaseline",
          pulseState: "no-baseline",
          baseline: null,
          unreleasedCommits: { state: "no-baseline", count: null },
        },
        readiness: { state: "unknown", reasons: ["No release baseline has been published."] },
      }),
      repoFixture({
        id: "f",
        fullName: "org/stale",
        releaseDeltaSyncedAt: "2026-10-28T12:00:00.000Z",
        pulse: {
          ...repoFixture().pulse,
          repoFullName: "org/stale",
          unreleasedCommits: { state: "ahead", count: 7 },
        },
        readiness: { state: "building", reasons: ["7 unreleased commits"] },
      }),
    ]);

    render(<AutomationOverview />);

    await waitFor(() => {
      expect(screen.getAllByTestId(/^release-pulse-org\//).length).toBe(6);
    });

    // Candidate: full ready line with the badge word, scoped to its card.
    const candidateCard = screen.getByTestId("release-pulse-org/candidate");
    expect(within(candidateCard).getByText(/v0\.1\.12 · \+18 commits · 5d · 0 highlights/)).toBeInTheDocument();
    expect(within(candidateCard).getByText("candidate")).toBeInTheDocument();

    // Building and quiet stay ready-shaped with their own words.
    expect(within(screen.getByTestId("release-pulse-org/building")).getByText("building")).toBeInTheDocument();
    expect(within(screen.getByTestId("release-pulse-org/building")).getByText(/\+2 commits/)).toBeInTheDocument();
    expect(within(screen.getByTestId("release-pulse-org/quiet")).getByText(/\+0 commits/)).toBeInTheDocument();
    expect(within(screen.getByTestId("release-pulse-org/quiet")).getByText("quiet")).toBeInTheDocument();

    // Unknown is textually distinct from the zero-commit quiet line.
    expect(within(screen.getByTestId("release-pulse-org/unknown")).getByText("Release state unknown")).toBeInTheDocument();
    expect(within(screen.getByTestId("release-pulse-org/nobaseline")).getByText("No release baseline")).toBeInTheDocument();

    // Stale sync shows the sync age rather than presenting the pulse as live.
    expect(within(screen.getByTestId("release-pulse-org/stale")).getByText("release data from 2 days ago")).toBeInTheDocument();
  });

  it("degrades a repo without pulse data to the unknown pulse line instead of crashing", async () => {
    mockRepos([repoFixture({ pulse: undefined, readiness: undefined })]);
    // A repo synced before the pulse feature ships may lack the fields; the
    // card must not crash. (Typed API always provides them, but stay honest.)
    render(<AutomationOverview />);
    await waitFor(() => {
      expect(screen.getByTestId("release-pulse-org/repo")).toBeInTheDocument();
      expect(screen.getByText("Release state unknown")).toBeInTheDocument();
    });
  });
});
