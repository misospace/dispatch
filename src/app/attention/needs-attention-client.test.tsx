import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/client-auth", () => ({
  authedFetch: vi.fn(),
}));

import { NeedsAttentionClient } from "./needs-attention-client";
import { authedFetch } from "@/lib/client-auth";
import type { NeedsAttentionSnapshot } from "@/lib/needs-attention";

const snapshot = (items: NeedsAttentionSnapshot["items"]) =>
  ({
    ok: true,
    json: async () => ({ now: "2026-11-04T12:00:00.000Z", items }),
  }) as unknown as Response;

const humanDecisionItem = {
  id: "human_decision:pfix1",
  category: "human_decision" as const,
  title: "Fix the thing",
  repo: "org/repo",
  issueNumber: 42,
  prNumber: 7,
  url: "https://github.com/org/repo/pull/7",
  reason: "worker escalated a decision an operator must make",
  decision: { question: "Keep or revert?", options: ["keep", "revert"], evidence: "ci log" },
  ageStartedAt: "2026-11-04T10:00:00.000Z",
  urgency: 1,
};

const reviewReadyItem = {
  id: "review_ready:exec1",
  category: "review_ready" as const,
  title: "alpha finished work awaiting review",
  repo: "org/repo",
  issueNumber: null,
  prNumber: 9,
  url: "https://github.com/org/repo/pull/9",
  reason: "agent work is complete and awaiting operator review",
  decision: null,
  ageStartedAt: "2026-11-04T09:00:00.000Z",
  urgency: 3,
};

beforeEach(() => {
  vi.mocked(authedFetch).mockReset();
});

describe("NeedsAttentionClient", () => {
  it("renders nothing-needs-attention empty state", async () => {
    vi.mocked(authedFetch).mockResolvedValue(snapshot([]));
    render(<NeedsAttentionClient />);
    await waitFor(() => expect(screen.getByText("Nothing needs attention.")).toBeTruthy());
    expect(
      screen.getByText(/Healthy, queued, and transient retry work is intentionally not listed/i),
    ).toBeTruthy();
  });

  it("renders urgency-ordered groups with identity, reason, decision payload and links", async () => {
    vi.mocked(authedFetch).mockResolvedValue(snapshot([reviewReadyItem, humanDecisionItem]));
    render(<NeedsAttentionClient />);

    await waitFor(() => expect(screen.getByText("Human decision")).toBeTruthy());
    const headings = screen.getAllByRole("heading").map((h) => h.textContent ?? "");
    const humanIdx = headings.findIndex((t) => t.startsWith("Human decision"));
    const reviewIdx = headings.findIndex((t) => t.startsWith("Review ready"));
    expect(humanIdx).toBeGreaterThanOrEqual(0);
    expect(reviewIdx).toBeGreaterThan(humanIdx);

    expect(screen.getByText("Fix the thing")).toBeTruthy();
    expect(screen.getByText("org/repo#7")).toBeTruthy();
    expect(screen.getByText(/worker escalated a decision/)).toBeTruthy();
    expect(screen.getByText(/Keep or revert\?/)).toBeTruthy();
    expect(screen.getByText("keep")).toBeTruthy();
    expect(screen.getByText("revert")).toBeTruthy();
    expect(screen.getByText("Evidence: ci log")).toBeTruthy();

    const links = screen.getAllByRole("link", { name: /open org\/repo/i });
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("https://github.com/org/repo/pull/7");
  });

  it("refreshes via authedFetch on button click", async () => {
    vi.mocked(authedFetch).mockResolvedValueOnce(snapshot([])).mockResolvedValueOnce(
      snapshot([humanDecisionItem]),
    );
    render(<NeedsAttentionClient />);
    await waitFor(() => expect(screen.getByText("Nothing needs attention.")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(screen.getByText("Human decision")).toBeTruthy());
    expect(vi.mocked(authedFetch)).toHaveBeenCalledTimes(2);
  });

  it("shows an error message when the fetch fails", async () => {
    vi.mocked(authedFetch).mockRejectedValue(new Error("unauthorized"));
    render(<NeedsAttentionClient />);
    await waitFor(() => expect(screen.getByText("unauthorized")).toBeTruthy());
  });
});