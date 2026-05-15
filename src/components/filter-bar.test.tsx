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
  it("makes empty agent and owner label option states explicit", () => {
    render(React.createElement(FilterBar, { repos: [], agents: [], owners: [], activeFilters }));

    expect(screen.getByRole("option", { name: "No agent/* labels found" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "No owner/* labels found" })).toBeDisabled();
  });

  it("labels agent and owner filters as label-based", () => {
    render(
      React.createElement(FilterBar, {
        repos: [],
        agents: ["agent/alpha"],
        owners: ["owner/alice"],
        activeFilters,
      })
    );

    expect(screen.getByLabelText("Filter by agent label")).toHaveAttribute(
      "title",
      "Agent filters use agent/ labels on synced GitHub issues."
    );
    expect(screen.getByLabelText("Filter by owner label")).toHaveAttribute(
      "title",
      "Owner filters use owner/ labels on synced GitHub issues."
    );
    expect(screen.getByRole("option", { name: "alpha" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "alice" })).toBeInTheDocument();
  });
});
