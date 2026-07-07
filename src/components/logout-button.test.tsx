import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogoutButton } from "./logout-button";

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

const signOutMock = vi.fn();
vi.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

const clearBasicAuthCredentialsMock = vi.fn();
const hasBasicAuthCredentialsMock = vi.fn();
vi.mock("@/lib/client-auth", () => ({
  clearBasicAuthCredentials: (...args: unknown[]) => clearBasicAuthCredentialsMock(...args),
  hasBasicAuthCredentials: (...args: unknown[]) => hasBasicAuthCredentialsMock(...args),
}));

describe("LogoutButton", () => {
  beforeEach(() => {
    pushMock.mockReset();
    refreshMock.mockReset();
    signOutMock.mockReset();
    clearBasicAuthCredentialsMock.mockReset();
    hasBasicAuthCredentialsMock.mockReset();
    hasBasicAuthCredentialsMock.mockReturnValue(false);
    signOutMock.mockResolvedValue(undefined);
  });

  it("signs out via NextAuth and redirects to /login in OIDC mode", async () => {
    const user = userEvent.setup();
    render(<LogoutButton />);

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledWith({ redirect: false });
      expect(pushMock).toHaveBeenCalledWith("/login");
      expect(refreshMock).toHaveBeenCalled();
    });
    expect(clearBasicAuthCredentialsMock).not.toHaveBeenCalled();
  });

  it("clears stored credentials instead of calling signOut in basic auth mode", async () => {
    hasBasicAuthCredentialsMock.mockReturnValue(true);
    const user = userEvent.setup();
    render(<LogoutButton />);

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(clearBasicAuthCredentialsMock).toHaveBeenCalled();
      expect(pushMock).toHaveBeenCalledWith("/login");
      expect(refreshMock).toHaveBeenCalled();
    });
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("shows a loading label and disables the button while logout is in flight", async () => {
    let resolveSignOut: () => void = () => {};
    signOutMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSignOut = resolve;
      })
    );
    const user = userEvent.setup();
    render(<LogoutButton />);

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    const busyButton = await screen.findByRole("button", { name: "Signing out..." });
    expect(busyButton).toBeDisabled();

    resolveSignOut();
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("still clears credentials and redirects when signOut throws", async () => {
    signOutMock.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(<LogoutButton />);

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(clearBasicAuthCredentialsMock).toHaveBeenCalled();
      expect(pushMock).toHaveBeenCalledWith("/login");
      expect(refreshMock).toHaveBeenCalled();
    });
  });
});
