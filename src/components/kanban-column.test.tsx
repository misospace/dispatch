import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanColumn } from "./kanban-column";

const useDroppableMock = vi.fn();
vi.mock("@dnd-kit/core", () => ({
  useDroppable: (...args: unknown[]) => useDroppableMock(...args),
}));

describe("KanbanColumn", () => {
  beforeEach(() => {
    useDroppableMock.mockReset();
    useDroppableMock.mockReturnValue({ setNodeRef: vi.fn(), isOver: false });
  });

  it("scrolls its own card list instead of stretching the page", () => {
    // Done holds every issue closed inside the retention window — 92 cards as
    // of 2026-08-25 — which stretched the board far past the viewport and
    // buried the other columns below the fold.
    const { container } = render(
      <KanbanColumn id="status/done" title="Done" count={1}>
        <div>card</div>
      </KanbanColumn>
    );

    const list = container.querySelector("div.overflow-y-auto");
    expect(list).not.toBeNull();
    expect(list?.className).toContain("max-h-");
  });

  it("renders the column title, count, and issue cards", () => {
    render(
      <KanbanColumn id="status/ready" title="Ready" count={2}>
        <article>First issue</article>
        <article>Second issue</article>
      </KanbanColumn>
    );

    expect(screen.getByRole("heading", { name: "Ready" })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("First issue")).toBeInTheDocument();
    expect(screen.getByText("Second issue")).toBeInTheDocument();
  });

  it("renders an empty column with a zero count and no cards", () => {
    const { container } = render(
      <KanbanColumn id="status/backlog" title="Backlog" count={0}>
        {null}
      </KanbanColumn>
    );

    expect(screen.getByRole("heading", { name: "Backlog" })).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(container.querySelectorAll("article")).toHaveLength(0);
  });

  it("registers itself as a droppable zone using the column id", () => {
    render(
      <KanbanColumn id="status/in-progress" title="In Progress" count={0}>
        {null}
      </KanbanColumn>
    );

    expect(useDroppableMock).toHaveBeenCalledWith({ id: "status/in-progress" });
  });

  it("applies drop-target highlight styles when a draggable is over the column", () => {
    useDroppableMock.mockReturnValue({ setNodeRef: vi.fn(), isOver: true });

    const { container } = render(
      <KanbanColumn id="status/done" title="Done" count={1}>
        <article>Card</article>
      </KanbanColumn>
    );

    expect(container.firstElementChild).toHaveClass("ring-2");
  });

  it("does not apply drop-target highlight styles when nothing is over the column", () => {
    const { container } = render(
      <KanbanColumn id="status/done" title="Done" count={1}>
        <article>Card</article>
      </KanbanColumn>
    );

    expect(container.firstElementChild).not.toHaveClass("ring-2");
  });
});
