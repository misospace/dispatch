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
});
