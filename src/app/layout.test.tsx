import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { renderToString } from "react-dom/server";
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

vi.mock("@/lib/version-client", () => ({
  getClientVersionLabel: () => versionLabel,
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: function ThemeToggle() {
    return React.createElement("button", { "aria-label": "Switch to dark mode" }, "theme-toggle");
  },
}));

vi.mock("@/components/auth-controls", () => ({
  AuthControls: function AuthControls() {
    return null;
  },
}));

vi.mock("next/link", () => ({
  default: function NavLink({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) {
    return React.createElement("a", { href, "data-nav": "true", ...rest }, children);
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
    expect(desktopNav?.querySelectorAll("a").length).toBe(6);
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

  it("mobile nav toggle is inside a sm:hidden container", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const mobileContainer = container.querySelector('div[class*="sm:hidden"]');
    expect(mobileContainer).toBeTruthy();
  });

  it("mobile nav contains all primary nav links when open", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const checkbox = container.querySelector<HTMLInputElement>("#mobile-nav-toggle")!;
    fireEvent.change(checkbox, { target: { checked: true } });
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Board")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Automation")).toBeInTheDocument();
  });

  it("mobile nav contains theme toggle and version label when open", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const checkbox = container.querySelector<HTMLInputElement>("#mobile-nav-toggle")!;
    fireEvent.click(checkbox);
    const mobileNav = container.querySelector("nav.border-t");
    expect(mobileNav?.querySelector("button[aria-label='Switch to dark mode']")).toBeTruthy();
    expect(mobileNav?.querySelector("span")).toBeTruthy();
  });

  it("renders theme toggle in desktop header", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const desktopToggle = container.querySelector(".ml-auto button[aria-label='Switch to dark mode']");
    expect(desktopToggle).toBeTruthy();
  });

  it("renders a GitHub link in the desktop header cluster", () => {
    const { container } = render(
      <RootLayout>
        <span />
      </RootLayout>,
    );
    const cluster = container.querySelector(".ml-auto");
    expect(cluster).toBeTruthy();
    const link = cluster?.querySelector("a[aria-label='Dispatch on GitHub']");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("https://github.com/misospace/dispatch");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    // The button (rendered as the anchor via Radix `asChild`) should
    // also carry the aria-label so SR users hear "Dispatch on GitHub"
    // regardless of which element receives focus.
    const labeled = cluster?.querySelector("a[aria-label='Dispatch on GitHub']");
    expect(labeled).toBeTruthy();
    expect(labeled?.getAttribute("title")).toBe("Dispatch on GitHub");
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

describe("theme initialization under CSP (dispatch#841)", () => {
  // The served document, not the jsdom-mangled DOM: renderToString emits the
  // exact <html>/<head> markup the browser receives (jsdom hoists and drops
  // the nested <head> when rendered into the test document).
  function servedHtml(): string {
    return renderToString(
      <RootLayout>
        <span />
      </RootLayout>,
    );
  }

  it("loads the theme initialiser from a self-hosted script before first paint", () => {
    const html = servedHtml();
    const scriptIdx = html.indexOf('src="/theme-init.js"');
    const bodyIdx = html.indexOf("<body");
    // Must exist, and must sit in <head> (before <body>): a classic script
    // there is render-blocking, so the theme class is applied before first
    // paint. A script moved into the body (or made async/defer) fails this.
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeLessThan(bodyIdx);
    const scriptTag = html.slice(html.lastIndexOf("<script", scriptIdx), html.indexOf(">", scriptIdx) + 1);
    // Render-blocking: no async/defer/module, and served from 'self'.
    expect(scriptTag).not.toMatch(/\b(async|defer|module)\b/);
    expect(scriptTag).toContain('src="/theme-init.js"');
  });

  it("renders no inline script that the script-src 'self' policy would block", () => {
    // The policy (script-src 'self', no 'unsafe-inline'/hash/nonce — pinned in
    // middleware.test.ts) blocks every inline script. Asserting the header
    // string is what let #841 ship; this asserts the document instead: any
    // inline script reintroduced here is caught by this test.
    const html = servedHtml();
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    expect(inlineScripts).toEqual([]);
  });

  it("the self-hosted initialiser still implements theme restoration", () => {
    // Fails if the file is emptied, renamed, or stops restoring the stored
    // preference — i.e. if the initialiser stops doing its job.
    const src = readFileSync(resolve(process.cwd(), "public/theme-init.js"), "utf8");
    expect(src).toContain("dispatch-theme");
    expect(src).toContain("prefers-color-scheme: dark");
    expect(src).toContain('classList.add("dark")');
  });
});
