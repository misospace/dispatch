import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import PrFixQueuePage from "./page";

const { mockAuthedFetch } = vi.hoisted(() => ({
  mockAuthedFetch: vi.fn(),
}));

vi.mock("@/lib/client-auth", () => ({
  authedFetch: mockAuthedFetch,
}));

describe("PR Fix Queue page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows blocked and queued sections with data", async () => {
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "1", repo: "org/repo", pr: 42, status: "BLOCKED", lane: "NEEDS_HUMAN", reason: "merge conflict", title: "Fix auth", url: "https://github.com/org/repo/pull/42", queuedAt: "2026-01-01T00:00:00Z" },
        { id: "2", repo: "org/repo", pr: 43, status: "QUEUED", lane: "NORMAL", reason: "ci failure", title: null, url: null, queuedAt: "2026-01-02T00:00:00Z" },
      ],
    });

    render(<PrFixQueuePage />);

    await waitFor(() => {
      expect(screen.getByText(/Blocked — needs human/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Fix auth")).toBeInTheDocument();
    expect(screen.getByText("merge conflict")).toBeInTheDocument();
    expect(screen.getByText(/org\/repo#43/)).toBeInTheDocument();
    expect(screen.getByText(/ci failure/)).toBeInTheDocument();
  });

  it("shows external waits as read-only with their note and retry deadline", async () => {
    const retryAt = "2026-01-03T12:00:00Z";
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "wait-1", repo: "org/repo", pr: 44, status: "WAITING_EXTERNAL", lane: "NORMAL", reason: "CI prerequisite", latestNote: "missing prerequisite: X", retryAt, title: "Wait for CI", url: null, queuedAt: "2026-01-02T00:00:00Z" },
      ],
    });
    render(<PrFixQueuePage />);
    await waitFor(() => expect(screen.getByText(/Waiting on external prerequisite/i)).toBeInTheDocument());
    expect(screen.getByText("missing prerequisite: X")).toBeInTheDocument();
    expect(screen.getByText(new Date(retryAt).toLocaleString())).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /requeue/i })).not.toBeInTheDocument();
  });

  it("shows empty state when no items", async () => {
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<PrFixQueuePage />);

    await waitFor(() => {
      expect(screen.getByText(/No blocked items/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/No queued items/i)).toBeInTheDocument();
  });

  it("shows error on failed fetch", async () => {
    mockAuthedFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Unauthorized" }),
    });

    render(<PrFixQueuePage />);

    await waitFor(() => {
      expect(screen.getByText("Unauthorized")).toBeInTheDocument();
    });
  });

  it("uses fallback title when title is null", async () => {
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "1", repo: "org/repo", pr: 99, status: "BLOCKED", lane: "NEEDS_HUMAN", reason: "test", title: null, url: null, queuedAt: "2026-01-01T00:00:00Z" },
      ],
    });

    render(<PrFixQueuePage />);

    await waitFor(() => {
      expect(screen.getByText(/org\/repo#99/)).toBeInTheDocument();
    });
  });
});
