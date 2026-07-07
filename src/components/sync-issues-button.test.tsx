import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncIssuesButton } from "./sync-issues-button";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

const authedFetchMock = vi.fn();
vi.mock("@/lib/client-auth", () => ({
  authedFetch: (...args: unknown[]) => authedFetchMock(...args),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("SyncIssuesButton", () => {
  beforeEach(() => {
    authedFetchMock.mockReset();
    refreshMock.mockReset();
  });

  it("clicking the button POSTs to /api/sync and shows the success message", async () => {
    const user = userEvent.setup();
    authedFetchMock.mockResolvedValue(
      jsonResponse({ success: true, repos: 3, syncedCount: 12, results: [] })
    );

    render(<SyncIssuesButton />);
    await user.click(await screen.findByRole("button", { name: "Sync Issues" }));

    expect(authedFetchMock).toHaveBeenCalledWith("/api/sync", { method: "POST" });
    expect(await screen.findByText("Synced 12 issues from 3 repos.")).toBeInTheDocument();
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("shows a syncing label and disables the button while the request is in flight", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: Response) => void = () => {};
    authedFetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );

    render(<SyncIssuesButton />);
    await user.click(await screen.findByRole("button", { name: "Sync Issues" }));

    const busyButton = await screen.findByRole("button", { name: "Syncing..." });
    expect(busyButton).toBeDisabled();

    resolveFetch(jsonResponse({ repos: 1, syncedCount: 1, results: [] }));
    const idleButton = await screen.findByRole("button", { name: "Sync Issues" });
    expect(idleButton).toBeEnabled();
  });

  it("surfaces the API error message when the response is not ok", async () => {
    const user = userEvent.setup();
    authedFetchMock.mockResolvedValue(jsonResponse({ error: "GitHub rate limit hit" }, 500));

    render(<SyncIssuesButton />);
    await user.click(await screen.findByRole("button", { name: "Sync Issues" }));

    expect(await screen.findByText("GitHub rate limit hit")).toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("reports partial failures when some repos fail to sync", async () => {
    const user = userEvent.setup();
    authedFetchMock.mockResolvedValue(
      jsonResponse({
        repos: 2,
        syncedCount: 5,
        results: [
          { repo: "a/ok", synced: 5, error: null },
          { repo: "a/broken", synced: 0, error: "boom" },
        ],
      })
    );

    render(<SyncIssuesButton />);
    await user.click(await screen.findByRole("button", { name: "Sync Issues" }));

    expect(
      await screen.findByText("Synced 5 issues from 1/2 repos. 1 repos failed.")
    ).toBeInTheDocument();
  });
});
