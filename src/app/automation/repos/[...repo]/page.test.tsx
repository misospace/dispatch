import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import RepoDetailPage from "./page";

const { mockAuthedFetch } = vi.hoisted(() => ({
  mockAuthedFetch: vi.fn(),
}));

vi.mock("@/lib/client-auth", () => ({
  authedFetch: mockAuthedFetch,
}));

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    fullName: "org/repo",
    name: "repo",
    owner: "org",
    defaultBranch: "main",
    latestCommitSha: "abc1234",
    openPRCount: 1,
    lastSyncedAt: "2026-10-30T11:55:00.000Z",
    syncError: null,
    workflows: [],
    releases: [
      {
        id: "r1",
        tagName: "v0.1.12",
        name: "v0.1.12",
        draft: false,
        prerelease: false,
        url: "https://github.com/org/repo/releases/tag/v0.1.12",
        publishedAt: "2026-10-25T12:00:00.000Z",
      },
    ],
    packages: [],
    failingRuns: 0,
    runningRuns: 0,
    releaseDeltaSyncedAt: "2026-10-30T11:55:00.000Z",
    readiness: { state: "candidate", reasons: ["18 unreleased commits", "2 notable delivered features"] },
    pulse: {
      schema: "dispatch.release-pulse/v1",
      pulseState: "ready",
      baseline: { tag: "v0.1.12", sha: "abc", publishedAt: "2026-10-25T12:00:00.000Z" },
      headSha: "def",
      unreleasedCommits: { state: "ahead", count: 18 },
      deliveredIssueCount: 2,
      highlights: [
        {
          kind: "feature",
          headline: "Add fenced capacity handoff for worker lanes",
          issueNumber: 1256,
          issueUrl: "https://github.com/org/repo/issues/1256",
          deliveredAt: "2026-10-28T10:00:00.000Z",
          significance: "notable",
          confidence: "high",
          provenance: "groomer-release-signal",
          prs: [
            {
              prNumber: 1490,
              prUrl: "https://github.com/org/repo/pull/1490",
              mergeCommitSha: "abc",
              mergedAt: "2026-10-28T10:00:00.000Z",
            },
          ],
        },
        {
          kind: "umbrella_completed",
          headline: "Observability packaging complete",
          issueNumber: 1479,
          issueUrl: "https://github.com/org/repo/issues/1479",
          deliveredAt: "2026-10-29T10:00:00.000Z",
          significance: null,
          confidence: "high",
          provenance: "lifecycle-decomposition",
          prs: [],
          children: [
            { number: 1482, url: "https://github.com/org/repo/issues/1482", closedAt: "2026-10-29T09:00:00.000Z" },
          ],
        },
      ],
      highlightsTruncated: false,
      notableDeliveryCount: 1,
      completedUmbrellaCount: 1,
      unknownDeliveryCount: 0,
    },
    lastSyncRun: null,
    recentEvents: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedFetch.mockResolvedValue({ ok: true, json: async () => detailFixture() });
  // Deterministic clock: the page derives release age/staleness from `new Date()`.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-30T12:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderDetail() {
  // `use(params)` suspends on the promise; flush it inside act so the page
  // actually renders before assertions.
  const params = Promise.resolve({ repo: ["org", "repo"] });
  await act(async () => {
    render(<RepoDetailPage params={params} />);
  });
}

describe("Repo detail page — release pulse (dispatch#1484)", () => {
  it("renders the quantitative delta in the Unreleased status card", async () => {
    await renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId("unreleased-card")).toBeInTheDocument();
    });
    const card = screen.getByTestId("unreleased-card");
    expect(card).toHaveTextContent("Unreleased");
    expect(card).toHaveTextContent("candidate");
    expect(card).toHaveTextContent("+18 commits");
    expect(card).toHaveTextContent("v0.1.12");
  });

  it("renders highlights with issue, PR, and umbrella-child links", async () => {
    await renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId("release-highlights")).toBeInTheDocument();
    });

    expect(screen.getByText(/18 commits since v0\.1\.12/)).toBeInTheDocument();
    expect(screen.getByText("2 highlights")).toBeInTheDocument();
    expect(screen.getByText("1 completed umbrella(s)")).toBeInTheDocument();

    expect(screen.getByText("Add fenced capacity handoff for worker lanes")).toHaveClass("break-words");
    expect(screen.getByRole("link", { name: "#1256" })).toHaveAttribute(
      "href",
      "https://github.com/org/repo/issues/1256",
    );
    expect(screen.getByRole("link", { name: "PR #1490" })).toHaveAttribute(
      "href",
      "https://github.com/org/repo/pull/1490",
    );
    expect(screen.getByRole("link", { name: "#1482" })).toHaveAttribute(
      "href",
      "https://github.com/org/repo/issues/1482",
    );
  });

  it("keeps the Releases table and renders distinct non-ready states", async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        detailFixture({
          pulse: {
            ...detailFixture().pulse,
            pulseState: "no-baseline",
            baseline: null,
            unreleasedCommits: { state: "no-baseline", count: null },
            highlights: [],
          },
        }),
    });
    await renderDetail();

    await waitFor(() => {
      expect(screen.getByText(/No release baseline yet/)).toBeInTheDocument();
    });
    // Existing surfaces preserved (the "Releases" title also appears in the
    // status grid card).
    expect(screen.getAllByText("Releases").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: "v0.1.12" })).toBeInTheDocument();
  });

  it("marks a stale release delta with its sync age", async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      json: async () => detailFixture({ releaseDeltaSyncedAt: "2026-10-28T12:00:00.000Z" }),
    });
    await renderDetail();
    await waitFor(() => {
      expect(screen.getByText("release data from 2 days ago")).toBeInTheDocument();
    });
  });
});
