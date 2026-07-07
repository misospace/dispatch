import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { MobileNav } from "./mobile-nav";

vi.mock("@/lib/version-client", () => ({
  getClientVersionLabel: () => "v0.0.0-test",
}));

// AuthControls is an async server component; stub it for client rendering.
vi.mock("./auth-controls", () => ({
  AuthControls: () => <div data-testid="auth-controls" />,
}));

vi.mock("./theme-toggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

describe("MobileNav", () => {
  it("keeps the menu closed initially", async () => {
    render(<MobileNav />);

    expect(await screen.findByLabelText("Toggle navigation menu")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument();
  });

  it("opens the menu and renders all nav links with their hrefs", async () => {
    const user = userEvent.setup();
    render(<MobileNav />);

    await user.click(await screen.findByLabelText("Toggle navigation menu"));

    expect(await screen.findByRole("navigation")).toBeInTheDocument();
    const expected: Array<[string, string]> = [
      ["Overview", "/"],
      ["Board", "/board"],
      ["Projects", "/projects"],
      ["Agents", "/agents"],
      ["Automation", "/automation"],
      ["Groomer", "/groomer"],
    ];
    for (const [label, href] of expected) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
    expect(screen.getByText("v0.0.0-test")).toBeInTheDocument();
    expect(screen.getByTestId("auth-controls")).toBeInTheDocument();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  it("closes the menu when the toggle is clicked again", async () => {
    const user = userEvent.setup();
    render(<MobileNav />);

    const toggle = await screen.findByLabelText("Toggle navigation menu");
    await user.click(toggle);
    expect(await screen.findByRole("navigation")).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("closes the menu when a nav link is clicked", async () => {
    const user = userEvent.setup();
    render(<MobileNav />);

    await user.click(await screen.findByLabelText("Toggle navigation menu"));
    await user.click(await screen.findByRole("link", { name: "Board" }));

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});
