import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock Next.js navigation hooks
const mockReplace = vi.fn();
const mockSearchParams = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  useSearchParams: () => mockSearchParams(),
}));

// Track href assignments
let trackedHref = "";
Object.defineProperty(window, "location", {
  value: {
    set href(val: string) {
      trackedHref = val;
    },
  },
  writable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  trackedHref = "";
  mockReplace.mockReset();
  mockSearchParams.mockReset();
  // Default fetch to resolve with no-user session (so page stays)
  window.fetch = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({}),
  });
});

function getLoginPage(callbackUrl?: string) {
  if (callbackUrl) {
    mockSearchParams.mockReturnValue({ get: (key: string) => key === "callbackUrl" ? callbackUrl : null });
  } else {
    mockSearchParams.mockReturnValue({ get: (key: string) => (key === "callbackUrl" ? null : null) });
  }
}

describe("LoginPage", () => {
  it("renders the sign-in button with correct text", async () => {
    getLoginPage();
    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /sign in with sso/i })).toBeInTheDocument();
  });

  it("navigates to /api/login with encoded callbackUrl when button is clicked", async () => {
    getLoginPage("/board");
    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);

    await userEvent.click(screen.getByRole("button", { name: /sign in with sso/i }));

    expect(trackedHref).toBe("/api/login?callbackUrl=%2Fboard");
  });

  it("uses custom callbackUrl from query string when provided", async () => {
    getLoginPage("/custom/return");
    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);

    await userEvent.click(screen.getByRole("button", { name: /sign in with sso/i }));

    expect(trackedHref).toBe("/api/login?callbackUrl=%2Fcustom%2Freturn");
  });

  it("defaults callbackUrl to /board when not provided", async () => {
    getLoginPage();
    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);

    await userEvent.click(screen.getByRole("button", { name: /sign in with sso/i }));

    expect(trackedHref).toBe("/api/login?callbackUrl=%2Fboard");
  });

  it("redirects when already logged in", async () => {
    getLoginPage();
    vi.mocked(window.fetch).mockResolvedValueOnce({
      json: () => Promise.resolve({ user: { email: "test@example.com" } }),
    } as Response);

    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/board");
    });
  });

  it("shows loading state on button click", async () => {
    getLoginPage();
    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);

    const button = screen.getByRole("button", { name: /sign in with sso/i });
    fireEvent.click(button);

    expect(button).toHaveTextContent("Signing in...");
    expect(button).toBeDisabled();
  });

  it("rejects absolute https callbackUrl from query string and falls back to /board", async () => {
    getLoginPage("https://evil.example.com");
    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);

    await userEvent.click(screen.getByRole("button", { name: /sign in with sso/i }));

    expect(trackedHref).toBe("/api/login?callbackUrl=%2Fboard");
  });

  it("rejects protocol-relative callbackUrl from query string and falls back to /board", async () => {
    getLoginPage("//evil.example.com");
    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);

    await userEvent.click(screen.getByRole("button", { name: /sign in with sso/i }));

    expect(trackedHref).toBe("/api/login?callbackUrl=%2Fboard");
  });
});
