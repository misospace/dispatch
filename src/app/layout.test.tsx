import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

const versionLabel = "v0.2.1";

vi.mock("next/font/google", () => {
  function Inter() {
    // eslint-disable-next-line react/display-name
    return (props: { className?: string }) =>
      React.createElement("span", { className: props.className }, null);
  }
  return { Inter };
});

vi.mock("@/lib/version", () => ({
  getVersionLabel: () => versionLabel,
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: function ThemeToggle() {
    return React.createElement("button", { "aria-label": "Switch to dark mode" }, "theme-toggle");
  },
}));

vi.mock("next/link", () => ({
  default: function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
    return React.createElement("a", { href, "data-nav": "true" }, children);
  },
}));

import RootLayout from "./layout";

describe("RootLayout app shell", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders Dispatch logo link", () => {
    render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    expect(screen.getByText("Dispatch")).toBeInTheDocument();
  });

  it("renders desktop nav links on larger layouts", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const desktopNav = container.querySelector('nav[class*="sm:flex"]');
    expect(desktopNav).toBeTruthy();
    expect(desktopNav?.querySelectorAll("a").length).toBe(5);
  });

  it("renders children in the main content area", () => {
    render(
      <RootLayout>
        <div data-testid="page-content">Page content</div>
      </RootLayout>,
    );
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("applies responsive padding classes to header container", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const headerDiv = container.querySelector("header > div");
    expect(headerDiv).toBeTruthy();
    expect(headerDiv?.className).toContain("max-w-screen-2xl");
    expect(headerDiv?.className).toContain("px-4");
  });

  it("applies responsive padding classes to main content", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const mainEl = container.querySelector("main");
    expect(mainEl).toBeTruthy();
    expect(mainEl?.className).toContain("max-w-screen-2xl");
    expect(mainEl?.className).toContain("px-4");
  });

  it("renders mobile nav toggle button", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const mobileToggle = container.querySelector('label[aria-label="Toggle navigation menu"]');
    expect(mobileToggle).toBeTruthy();
  });

  it("mobile nav contains all primary nav links", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const mobileNav = container.querySelector('nav[class*="sm:hidden"]');
    expect(mobileNav).toBeTruthy();
    expect(mobileNav?.querySelectorAll("a").length).toBe(5);
  });

  it("renders theme toggle", () => {
    render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    expect(screen.getByLabelText("Switch to dark mode")).toBeInTheDocument();
  });

  it("renders version label", () => {
    render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    expect(screen.getByText(versionLabel)).toBeInTheDocument();
  });
});
