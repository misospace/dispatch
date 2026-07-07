import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthControls } from "./auth-controls";

const getAuthModeMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  getAuthMode: () => getAuthModeMock(),
}));

const getSessionMock = vi.fn();
vi.mock("@/lib/session", () => ({
  getSession: () => getSessionMock(),
}));

// Stub the client-side LogoutButton so this server component test doesn't
// need next-auth / next/navigation mocks (covered in logout-button.test.tsx).
vi.mock("./logout-button", () => ({
  LogoutButton: () => <button data-testid="logout-button">Sign out</button>,
}));

describe("AuthControls", () => {
  beforeEach(() => {
    getAuthModeMock.mockReset();
    getSessionMock.mockReset();
  });

  it("renders nothing when auth is disabled", async () => {
    getAuthModeMock.mockReturnValue("disabled");

    expect(await AuthControls()).toBeNull();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("renders nothing when no auth mode is configured", async () => {
    getAuthModeMock.mockReturnValue(undefined);

    expect(await AuthControls()).toBeNull();
  });

  it("renders the logout button in basic auth mode without checking the session", async () => {
    getAuthModeMock.mockReturnValue("basic");

    render(await AuthControls());

    expect(screen.getByTestId("logout-button")).toBeInTheDocument();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("renders the logout button in OIDC mode when a session user exists", async () => {
    getAuthModeMock.mockReturnValue("oidc");
    getSessionMock.mockResolvedValue({ user: { email: "user@example.com" } });

    render(await AuthControls());

    expect(screen.getByTestId("logout-button")).toBeInTheDocument();
  });

  it("renders nothing in OIDC mode when there is no session", async () => {
    getAuthModeMock.mockReturnValue("oidc");
    getSessionMock.mockResolvedValue(null);

    expect(await AuthControls()).toBeNull();
  });
});
