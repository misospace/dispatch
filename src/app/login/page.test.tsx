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

  async function renderAuthenticated(callbackUrl: string) {
    getLoginPage(callbackUrl);
    vi.mocked(window.fetch).mockResolvedValueOnce({
      json: () => Promise.resolve({ user: { email: "test@example.com" } }),
    } as Response);

    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);
  }

  it("redirects an authenticated user to a valid local callback with query and fragment", async () => {
    await renderAuthenticated("/board?tab=issues#card-7");

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/board?tab=issues#card-7");
    });
  });

  it("does not redirect an authenticated user through a slash-backslash external callback", async () => {
    await renderAuthenticated("/\\evil.example/path");

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/board");
    });
    expect(mockReplace).not.toHaveBeenCalledWith("/\\evil.example/path");
  });

  it.each([
    ["tab", "/\t/evil.example"],
    ["newline", "/\n/evil.example"],
    ["carriage return", "/\r/evil.example"],
  ])("does not redirect an authenticated user through a callback with an embedded %s", async (_name, callbackUrl) => {
    await renderAuthenticated(callbackUrl);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/board");
    });
    expect(mockReplace).not.toHaveBeenCalledWith(callbackUrl);
  });

  it("encodes a rejected slash-backslash callback as /board on the sign-in link", async () => {
    getLoginPage("/\\evil.example/path");
    const { default: LoginPage } = await import("./page");
    render(<LoginPage />);

    await userEvent.click(screen.getByRole("button", { name: /sign in with sso/i }));

    expect(trackedHref).toBe("/api/login?callbackUrl=%2Fboard");
  });
});
