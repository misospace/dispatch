import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GitHubLink } from "./github-link";

describe("GitHubLink", () => {
  it("renders a link with the expected accessible name", () => {
    render(<GitHubLink />);
    expect(
      screen.getByRole("link", { name: "Dispatch on GitHub" }),
    ).toBeInTheDocument();
  });

  it("renders an anchor that opens the dispatch repo in a new tab", () => {
    render(<GitHubLink />);
    const link = screen.getByLabelText("Dispatch on GitHub");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://github.com/misospace/dispatch");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders an inline svg mark so no external image is fetched", () => {
    const { container } = render(<GitHubLink />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});