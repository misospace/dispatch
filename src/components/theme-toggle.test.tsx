import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
  });

  it("toggles and persists the dark theme class", async () => {
    const user = userEvent.setup();
    render(React.createElement(ThemeToggle));

    const button = screen.getByRole("button", { name: "Switch to dark mode" });
    await user.click(button);

    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("mission-control-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
  });

  it("toggles back to light mode", async () => {
    const user = userEvent.setup();
    localStorage.setItem("mission-control-theme", "dark");

    render(React.createElement(ThemeToggle));

    const button = await screen.findByRole("button", { name: "Switch to light mode" });
    await user.click(button);

    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("mission-control-theme")).toBe("light");
  });
});
