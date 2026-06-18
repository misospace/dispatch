import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./filter-bar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const activeFilters = {
  repo: "",
  agent: "",
  owner: "",
  priority: "",
  lane: "",
};

describe("FilterBar", () => {
  it("makes empty agent and owner label option states explicit", async () => {
    render(React.createElement(FilterBar, { repos: [], agents: [], owners: [], activeFilters }));

    // Use findByRole for React 19 concurrent rendering compatibility
    expect(await screen.findByRole("option", { name: "No agent/* labels found" })).toBeDisabled();
    expect(await screen.findByRole("option", { name: "No owner/* labels found" })).toBeDisabled();
  });

  it("labels agent and owner filters as label-based", async () => {
    render(
      React.createElement(FilterBar, {
        repos: [],
        agents: ["agent/alpha"],
        owners: ["owner/alice"],
        activeFilters,
      })
    );

    // Use findByLabelText for React 19 concurrent rendering compatibility
    expect(await screen.findByLabelText("Filter by agent label")).toHaveAttribute(
      "title",
      "Agent filters use agent/ labels on synced GitHub issues."
    );
    expect(await screen.findByLabelText("Filter by owner label")).toHaveAttribute(
      "title",
      "Owner filters use owner/ labels on synced GitHub issues."
    );
    expect(await screen.findByRole("option", { name: "alpha" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "alice" })).toBeInTheDocument();
  });

  it("renders lane filter options from configured lanes", async () => {
    const lanes = [
      { id: "normal", title: "Normal", claimable: true },
      { id: "escalated", title: "Escalated", claimable: true },
      { id: "backlog", title: "Backlog", claimable: false },
    ];
    render(
      React.createElement(FilterBar, {
        repos: [],
        agents: [],
        owners: [],
        lanes,
        activeFilters,
      })
    );

    expect(await screen.findByLabelText("Filter by execution lane")).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "All Lanes" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Normal" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Escalated" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Backlog (non-claimable)" })).toBeInTheDocument();
  });

  it("does not render lane filter when lanes prop is omitted", async () => {
    render(
      React.createElement(FilterBar, {
        repos: [],
        agents: [],
        owners: [],
        activeFilters,
      })
    );

    expect(screen.queryByLabelText("Filter by execution lane")).not.toBeInTheDocument();
  });

  it("renders custom lane titles from config", async () => {
    const lanes = [
      { id: "fast", title: "Fast Lane", claimable: true },
      { id: "slow", title: "Slow Lane", claimable: true },
      { id: "parked", title: "Parked", claimable: false },
    ];
    render(
      React.createElement(FilterBar, {
        repos: [],
        agents: [],
        owners: [],
        lanes,
        activeFilters,
      })
    );

    expect(await screen.findByRole("option", { name: "Fast Lane" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Slow Lane" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Parked (non-claimable)" })).toBeInTheDocument();
  });
});
