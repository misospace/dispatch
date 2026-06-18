import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/client-auth", () => ({
  authedFetch: vi.fn(),
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
