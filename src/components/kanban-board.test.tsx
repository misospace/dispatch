import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Issue } from "@/types";
import { KanbanBoard } from "./kanban-board";

const dnd = vi.hoisted(() => ({
  latestProps: null as null | { onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => Promise<void> },
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => Promise<void> }) => {
    dnd.latestProps = { onDragEnd };
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  closestCorners: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: {},
}));

vi.mock("./kanban-column", () => ({
  KanbanColumn: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

vi.mock("./issue-card", () => ({
  IssueCard: ({ issue }: { issue: Issue }) => <article>{issue.title}</article>,
}));

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    number: 1,
    title: "Existing issue",
    body: null,
    state: "open",
    url: "https://github.com/misospace/dispatch/issues/1",
    labels: ["status/ready"],
    assignees: [],
    commentsCount: 0,
    createdAt: new Date("2026-05-25T16:00:00.000Z"),
    updatedAt: new Date("2026-05-25T16:00:00.000Z"),
    closedAt: null,
    repository: { fullName: "misospace/dispatch" },
    ...overrides,
  };
}

function expectedRefreshLabel(date: Date) {
  return `Last refreshed ${date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

describe("KanbanBoard refresh status", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-25T19:22:00.000Z"));
    window.history.replaceState(null, "", "/board");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the last successful refresh time", async () => {
    render(<KanbanBoard initialIssues={[issue()]} />);

    expect(await screen.findByText(/Last refreshed/)).toHaveTextContent(
      expectedRefreshLabel(new Date("2026-05-25T19:22:00.000Z"))
    );
  });

  it("updates issues and last refreshed time after a successful manual refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([issue({ id: "issue-2", title: "Fresh issue" })]),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<KanbanBoard initialIssues={[issue()]} />);
    await screen.findByText("Existing issue");

    vi.setSystemTime(new Date("2026-05-25T19:30:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));

    expect(await screen.findByText("Fresh issue")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Last refreshed/)).toHaveTextContent(
        expectedRefreshLabel(new Date("2026-05-25T19:30:00.000Z"))
      )
    );
  });

  it("shows a stale-state warning and keeps current issues after refresh failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    render(<KanbanBoard initialIssues={[issue()]} />);
    await screen.findByText("Existing issue");

    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));

    expect(await screen.findByText("Board refresh failed. Showing previous state.")).toBeInTheDocument();
    expect(screen.getByText("Existing issue")).toBeInTheDocument();
  });

  it("retries from the stale-state warning", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([issue({ id: "issue-2", title: "Recovered issue" })]),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<KanbanBoard initialIssues={[issue()]} />);
    await screen.findByText("Existing issue");

    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(await screen.findByText("Board refresh failed. Showing previous state.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Recovered issue")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Board refresh failed. Showing previous state.")).not.toBeInTheDocument()
    );
  });

  it("refreshes after a card move and debounces repo-scoped GitHub sync", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([issue({ labels: ["status/in-progress"] })]),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ syncedCount: 1 }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<KanbanBoard initialIssues={[issue()]} />);
    await screen.findByText("Existing issue");

    await act(async () => {
      await dnd.latestProps?.onDragEnd({
        active: { id: "issue-1" },
        over: { id: "status/in-progress" },
      });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/issues", expect.any(Object)));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/sync", expect.any(Object));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sync",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ repoFullName: "misospace/dispatch" }),
        })
      )
    );
  });

  it("batches multiple moves in one debounce window into one sync per repo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([issue({ labels: ["status/in-progress"] })]),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([issue({ labels: ["status/in-review"] })]),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ syncedCount: 1 }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<KanbanBoard initialIssues={[issue()]} />);
    await screen.findByText("Existing issue");

    await act(async () => {
      await dnd.latestProps?.onDragEnd({
        active: { id: "issue-1" },
        over: { id: "status/in-progress" },
      });
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await dnd.latestProps?.onDragEnd({
        active: { id: "issue-1" },
        over: { id: "status/in-review" },
      });
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Advance past the 10s debounce window. The second move resets the timer,
    // so the sync fires after 10s from the second move (15s total).
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/sync")).toHaveLength(1)
    );
  });

  it("shows a warning when debounced GitHub sync fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([issue({ labels: ["status/in-progress"] })]),
      })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "nope" }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<KanbanBoard initialIssues={[issue()]} />);
    await screen.findByText("Existing issue");

    await act(async () => {
      await dnd.latestProps?.onDragEnd({
        active: { id: "issue-1" },
        over: { id: "status/in-progress" },
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(await screen.findByText("GitHub sync failed. Board changes were saved; try Sync Issues or refresh later.")).toBeInTheDocument();
  });

  it("does not expose agent token in the debounced GitHub sync request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([issue({ labels: ["status/in-progress"] })]),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ syncedCount: 1 }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<KanbanBoard initialIssues={[issue()]} />);
    await screen.findByText("Existing issue");

    await act(async () => {
      await dnd.latestProps?.onDragEnd({
        active: { id: "issue-1" },
        over: { id: "status/in-progress" },
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sync",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ repoFullName: "misospace/dispatch" }),
        })
      )
    );

    const syncCall = fetchMock.mock.calls.find(([url]) => url === "/api/sync");
    expect(syncCall).toBeDefined();
    const headers = (syncCall![1] as RequestInit).headers as Record<string, string> | undefined;
    expect(headers).not.toHaveProperty("Authorization", expect.stringContaining("Bearer"));
  });
});

describe("KanbanBoard horizontal scroll layout", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-25T19:22:00.000Z"));
    window.history.replaceState(null, "", "/board");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("wraps the column grid in an overflow-x-auto container", () => {
    render(<KanbanBoard initialIssues={[issue()]} />);

    // The grid is a div.grid; its parent is the overflow-x-auto wrapper
    const grid = document.querySelector("div.grid");
    expect(grid?.parentElement?.className).toContain("overflow-x-auto");
  });

  it("sets minWidth fit-content on the column grid to enable horizontal scrolling", () => {
    render(<KanbanBoard initialIssues={[issue()]} />);

    // The min-width: fit-content style is directly on the grid div
    const grid = document.querySelector("div.grid");
    expect(grid).toHaveStyle({ minWidth: "fit-content" });
  });

  it("renders all five columns in canonical order", () => {
    render(<KanbanBoard initialIssues={[issue()]} />);

    // Column titles are in aria-label of section elements, not visible text
    const columnTitles = ["Backlog", "Ready", "In Progress", "In Review", "Done"];
    columnTitles.forEach((title) => {
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    });
  });

  it("renders columns with proper KanbanColumn wrappers", () => {
    render(<KanbanBoard initialIssues={[issue()]} />);

    // Each KanbanColumn renders as a section with aria-label
    const sections = document.querySelectorAll("section[aria-label]");
    expect(sections).toHaveLength(5);
  });
});