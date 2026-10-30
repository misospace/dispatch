import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ReleaseHighlightsSection,
  ReleasePulseLine,
  ReleasePulseStrip,
  ReleaseReadinessBadge,
} from "./release-pulse";
import type { ReleasePulseSnapshot } from "@/lib/release-pulse";
import { buildReleasePulseView, type ReleasePulseViewInput } from "@/lib/release-pulse-view";

const NOW = "2026-10-30T12:00:00.000Z";

function readyPulse(overrides: Partial<ReleasePulseSnapshot> = {}): ReleasePulseSnapshot {
  return {
    schema: "dispatch.release-pulse/v1",
    repoFullName: "org/repo",
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
    ...overrides,
  };
}

function view(overrides: Partial<ReleasePulseViewInput> = {}) {
  return buildReleasePulseView({
    pulse: readyPulse(),
    readiness: { state: "candidate", reasons: ["18 unreleased commits"] },
    releaseDeltaSyncedAt: "2026-10-30T11:00:00.000Z",
    now: NOW,
    ...overrides,
  });
}

describe("ReleaseReadinessBadge", () => {
  it("renders a text word for every state, never color-only", () => {
    render(
      <>
        <ReleaseReadinessBadge state="candidate" />
        <ReleaseReadinessBadge state="building" />
        <ReleaseReadinessBadge state="quiet" />
        <ReleaseReadinessBadge state="unknown" />
      </>,
    );
    expect(screen.getByText("candidate")).toBeInTheDocument();
    expect(screen.getByText("building")).toBeInTheDocument();
    expect(screen.getByText("quiet")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("exposes reasons as the badge title", () => {
    render(<ReleaseReadinessBadge state="candidate" reasons={["18 unreleased commits"]} />);
    expect(screen.getByText("candidate")).toHaveAttribute("title", "18 unreleased commits");
  });
});

describe("ReleasePulseLine", () => {
  it("renders the compact ready line with the badge", () => {
    render(<ReleasePulseLine view={view()} repoFullName="org/repo" />);
    expect(screen.getByText(/v0\.1\.12 · \+18 commits · 5d · 0 highlights/)).toBeInTheDocument();
    expect(screen.getByText("candidate")).toBeInTheDocument();
  });

  it("renders a distinct unknown state, not a zero-commit line", () => {
    render(
      <ReleasePulseLine
        view={view({ pulse: readyPulse({ pulseState: "unknown", baseline: null }) })}
        repoFullName="org/repo"
      />,
    );
    expect(screen.getByText("Release state unknown")).toBeInTheDocument();
    expect(screen.queryByText(/\+0 commits/)).not.toBeInTheDocument();
  });

  it("renders a distinct no-release state", () => {
    render(
      <ReleasePulseLine
        view={view({ pulse: readyPulse({ pulseState: "no-baseline", baseline: null }) })}
        repoFullName="org/repo"
      />,
    );
    expect(screen.getByText("No release baseline")).toBeInTheDocument();
  });

  it("shows the sync age instead of posing as live when stale", () => {
    render(
      <ReleasePulseLine
        view={view({ releaseDeltaSyncedAt: "2026-10-28T12:00:00.000Z" })}
        repoFullName="org/repo"
      />,
    );
    expect(screen.getByText("release data from 2 days ago")).toBeInTheDocument();
  });
});

describe("ReleasePulseStrip", () => {
  it("renders the single-repo strip linking to the automation detail page", () => {
    render(<ReleasePulseStrip view={view()} repoFullName="misospace/courier" />);
    const strip = screen.getByTestId("release-pulse-strip");
    expect(strip).toHaveAttribute("href", "/automation/repos/misospace/courier");
    expect(strip).toHaveTextContent("misospace/courier");
    expect(strip).toHaveTextContent("+18 commits since v0.1.12");
    expect(strip).toHaveTextContent("5d");
    expect(strip).toHaveTextContent("candidate");
  });

  it("renders non-ready states as distinct strip copy", () => {
    render(
      <ReleasePulseStrip
        view={view({ pulse: readyPulse({ pulseState: "no-baseline", baseline: null }) })}
        repoFullName="org/repo"
      />,
    );
    expect(screen.getByTestId("release-pulse-strip")).toHaveTextContent("no release baseline");
  });
});

describe("ReleaseHighlightsSection", () => {
  it("renders the quantitative delta, highlights, and umbrella children", () => {
    const pulse = readyPulse({
      deliveredIssueCount: 3,
      completedUmbrellaCount: 1,
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
          prs: [{ prNumber: 1490, prUrl: "https://github.com/org/repo/pull/1490", mergeCommitSha: "abc", mergedAt: "2026-10-28T10:00:00.000Z" }],
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
    });
    render(<ReleaseHighlightsSection pulse={pulse} />);

    expect(screen.getByText(/18 commits since v0\.1\.12/)).toBeInTheDocument();
    expect(screen.getByText("2 highlights")).toBeInTheDocument();
    expect(screen.getByText("1 completed umbrella(s)")).toBeInTheDocument();

    expect(screen.getByText("Add fenced capacity handoff for worker lanes")).toHaveClass("break-words");
    const issueLink = screen.getByRole("link", { name: "#1256" });
    expect(issueLink).toHaveAttribute("href", "https://github.com/org/repo/issues/1256");
    const prLink = screen.getByRole("link", { name: "PR #1490" });
    expect(prLink).toHaveAttribute("href", "https://github.com/org/repo/pull/1490");
    expect(screen.getByText("notable")).toBeInTheDocument();

    const childLink = screen.getByRole("link", { name: "#1482" });
    expect(childLink).toHaveAttribute("href", "https://github.com/org/repo/issues/1482");
  });

  it("reports the delivered-without-highlight remainder", () => {
    const pulse = readyPulse({
      deliveredIssueCount: 3,
      highlights: [
        {
          kind: "fix",
          headline: "Fix label sync",
          issueNumber: 900,
          issueUrl: null,
          deliveredAt: "2026-10-28T10:00:00.000Z",
          significance: null,
          confidence: "low",
          provenance: "legacy-issue-metadata",
          prs: [],
        },
      ],
    });
    render(<ReleaseHighlightsSection pulse={pulse} />);
    expect(screen.getByText(/2 more delivered issues without a semantic highlight/)).toBeInTheDocument();
  });

  it("notes unknown-delivery issues", () => {
    const pulse = readyPulse({ unknownDeliveryCount: 2, deliveredIssueCount: 0 });
    render(<ReleaseHighlightsSection pulse={pulse} />);
    expect(screen.getByText("2 with unknown delivery")).toBeInTheDocument();
  });

  it("notes truncation when the highlight cap cut the list", () => {
    const pulse = readyPulse({
      deliveredIssueCount: 60,
      highlightsTruncated: true,
      highlights: [],
    });
    render(<ReleaseHighlightsSection pulse={pulse} />);
    expect(screen.getByText(/and 60 more delivered issues/)).toBeInTheDocument();
  });

  it("renders distinct empty states for non-ready pulses", () => {
    render(<ReleaseHighlightsSection pulse={readyPulse({ pulseState: "no-baseline", baseline: null })} />);
    expect(screen.getByText(/No release baseline yet/)).toBeInTheDocument();

    render(<ReleaseHighlightsSection pulse={readyPulse({ pulseState: "unknown", baseline: null })} />);
    expect(screen.getByText(/Release state unknown/)).toBeInTheDocument();
  });

  it("degrades a missing pulse snapshot to the unknown state", () => {
    render(<ReleaseHighlightsSection pulse={null} />);
    expect(screen.getByText(/Release state unknown/)).toBeInTheDocument();
  });

  it("wraps a genuinely long headline instead of overflowing", () => {
    const pulse = readyPulse({
      highlights: [
        {
          kind: "feature",
          headline:
            "Supercalifragilisticexpialidocious_unbreakable_token_and_a_very_long_delivered_feature_headline_that_must_wrap_on_narrow_viewports_instead_of_overflowing",
          issueNumber: 1,
          issueUrl: null,
          deliveredAt: null,
          significance: null,
          confidence: "low",
          provenance: "legacy-issue-metadata",
          prs: [],
        },
      ],
    });
    render(<ReleaseHighlightsSection pulse={pulse} />);
    const headline = screen.getByText(/Supercalifragilisticexpialidocious_unbreakable_token/);
    expect(headline).toHaveClass("break-words");
  });
});
