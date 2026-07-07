import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { IssueCard } from "./issue-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

const authedFetchMock = vi.fn();
vi.mock("@/lib/client-auth", () => ({
  authedFetch: (...args: unknown[]) => authedFetchMock(...args),
}));

const makeIssue = (overrides = {}) => ({
  id: "test-issue-1",
  number: 42,
  title: "Test issue",
  body: null,
  state: "open",
  url: "https://github.com/test/repo/issues/42",
  labels: ["status/ready"],
  assignees: [],
  commentsCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  closedAt: null,
  repository: { fullName: "test/repo" },
  ...overrides,
});

describe("IssueCard lane badge", () => {
  it("renders lane badge with configured title and color (hex with #)", () => {
    const lanes = [
      { id: "normal", title: "Normal", claimable: true, color: "#3b82f6" },
      { id: "escalated", title: "Escalated", claimable: true, color: "#f97316" },
    ];
    const issue = makeIssue({ currentLane: "normal" });

    render(React.createElement(IssueCard, { issue, lanes }));

    expect(screen.getByText("Normal")).toBeInTheDocument();
    const badge = screen.getByText("Normal").closest("span");
    expect(badge).toHaveAttribute("title", "Lane: Normal");
  });

  it("renders lane badge with color that lacks # prefix", () => {
    const lanes = [
      { id: "normal", title: "Normal", claimable: true, color: "3b82f6" },
    ];
    const issue = makeIssue({ currentLane: "normal" });

    render(React.createElement(IssueCard, { issue, lanes }));

    expect(screen.getByText("Normal")).toBeInTheDocument();
    const badge = screen.getByText("Normal").closest("span");
    // jsdom normalizes hex colors to rgb/rgba; verify a color was applied
    expect(badge?.style.backgroundColor).toMatch(/rgba?\(/);
    expect(badge?.style.color).toMatch(/rgba?\(/);
  });

  it("renders non-claimable lane with reduced opacity", () => {
    const lanes = [
      { id: "backlog", title: "Backlog", claimable: false, color: "#6b7280" },
    ];
    const issue = makeIssue({ currentLane: "backlog" });

    render(React.createElement(IssueCard, { issue, lanes }));

    expect(screen.getByText("Backlog")).toBeInTheDocument();
    const badge = screen.getByText("Backlog").closest("span");
    expect(badge).toHaveAttribute("title", "Lane: Backlog (non-claimable)");
    expect(badge?.style.opacity).toBe("0.6");
  });

  it("does not render lane badge when lanes prop is omitted", () => {
    const issue = makeIssue({ currentLane: "normal" });

    render(React.createElement(IssueCard, { issue }));

    expect(screen.queryByText("Normal")).not.toBeInTheDocument();
  });

  it("does not render lane badge when currentLane is null", () => {
    const lanes = [
      { id: "normal", title: "Normal", claimable: true, color: "#3b82f6" },
    ];
    const issue = makeIssue({ currentLane: null });

    render(React.createElement(IssueCard, { issue, lanes }));

    expect(screen.queryByText("Normal")).not.toBeInTheDocument();
  });

  it("renders unknown lane badge when lane id is not in config", () => {
    const lanes = [
      { id: "normal", title: "Normal", claimable: true, color: "#3b82f6" },
    ];
    const issue = makeIssue({ currentLane: "unknown-lane" });

    render(React.createElement(IssueCard, { issue, lanes }));

    expect(screen.queryByText("Normal")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown: unknown-lane")).toBeInTheDocument();
    const badge = screen.getByText("Unknown: unknown-lane").closest("span");
    expect(badge).toHaveAttribute("title", "Unknown lane: unknown-lane (not configured)");
  });

  it("uses default gray color when lane has no color", () => {
    const lanes = [
      { id: "custom", title: "Custom", claimable: true },
    ];
    const issue = makeIssue({ currentLane: "custom" });

    render(React.createElement(IssueCard, { issue, lanes }));

    expect(screen.getByText("Custom")).toBeInTheDocument();
    const badge = screen.getByText("Custom").closest("span");
    // jsdom normalizes hex colors to rgb/rgba; verify a color was applied
    expect(badge?.style.backgroundColor).toMatch(/rgba?\(/);
    expect(badge?.style.color).toMatch(/rgba?\(/);
  });
});

describe("IssueCard unclaim button (issue #564)", () => {
  beforeEach(() => {
    authedFetchMock.mockReset();
  });

  it("renders the Unclaim button when the issue has an agent/* label", () => {
    const issue = makeIssue({ labels: ["status/in-progress", "agent/claude"] });
    render(React.createElement(IssueCard, { issue, onIssueUpdate: vi.fn() }));

    const btn = screen.getByTestId("unclaim-button");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-label", "Unclaim from claude");
  });

  it("does not render the Unclaim button when no agent/* label is present", () => {
    const issue = makeIssue({ labels: ["status/ready"] });
    render(React.createElement(IssueCard, { issue, onIssueUpdate: vi.fn() }));

    expect(screen.queryByTestId("unclaim-button")).not.toBeInTheDocument();
  });

  it("opens the confirm dialog when Unclaim is clicked", () => {
    const issue = makeIssue({ labels: ["status/in-progress", "agent/claude"] });
    render(React.createElement(IssueCard, { issue, onIssueUpdate: vi.fn() }));

    fireEvent.click(screen.getByTestId("unclaim-button"));

    expect(screen.getByTestId("unclaim-dialog")).toBeInTheDocument();
    expect(screen.getByText(/Unclaim from/)).toBeInTheDocument();
    expect(screen.getByText(/agent\/claude/)).toBeInTheDocument();
  });

  it("clicking Confirm calls POST /api/issues/unclaim with the expected payload and triggers a board refresh", async () => {
    authedFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/sync")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      if (String(url).endsWith("/api/issues/unclaim")) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, labels: ["status/ready"] }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const onIssueUpdate = vi.fn();
    const issue = makeIssue({ labels: ["status/in-progress", "agent/claude"] });
    render(React.createElement(IssueCard, { issue, onIssueUpdate }));

    fireEvent.click(screen.getByTestId("unclaim-button"));
    fireEvent.click(screen.getByTestId("unclaim-confirm"));

    await waitFor(() => {
      expect(authedFetchMock).toHaveBeenCalledWith(
        "/api/issues/unclaim",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            issueId: issue.id,
            repoFullName: issue.repository.fullName,
            issueNumber: issue.number,
            agentName: "claude",
          }),
        }),
      );
    });

    // Board refresh path: sync + onIssueUpdate are triggered on success.
    await waitFor(() => {
      expect(authedFetchMock).toHaveBeenCalledWith("/api/sync", { method: "POST" });
      expect(onIssueUpdate).toHaveBeenCalled();
    });
  });

  it("surfaces the error string in the dialog when the API responds non-2xx", async () => {
    authedFetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith("/api/issues/unclaim")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "Refusing: closed" }), { status: 400 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const issue = makeIssue({ labels: ["status/in-progress", "agent/claude"] });
    render(React.createElement(IssueCard, { issue, onIssueUpdate: vi.fn() }));

    fireEvent.click(screen.getByTestId("unclaim-button"));
    fireEvent.click(screen.getByTestId("unclaim-confirm"));

    const err = await screen.findByTestId("unclaim-error");
    expect(err).toHaveTextContent("Refusing: closed");
  });
});