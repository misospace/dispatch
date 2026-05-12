"use client";

import { useState, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { KanbanColumn } from "./kanban-column";
import { IssueCard } from "./issue-card";
import { Issue, StatusLabel } from "@/types";

const COLUMNS: { id: StatusLabel; title: string }[] = [
  { id: "status/backlog", title: "Backlog" },
  { id: "status/in-progress", title: "In Progress" },
  { id: "status/in-review", title: "In Review" },
  { id: "status/done", title: "Done" },
];

interface KanbanBoardProps {
  initialIssues: Issue[];
}

export function KanbanBoard({ initialIssues }: KanbanBoardProps) {
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    setIssues(initialIssues);
  }, [initialIssues]);

  function getIssuesByStatus(status: StatusLabel): Issue[] {
    if (status === "status/backlog") {
      return issues.filter(
        (issue) =>
          issue.labels.includes(status) ||
          !issue.labels.some((l) => l.startsWith("status/"))
      );
    }
    return issues.filter((issue) => issue.labels.includes(status));
  }

  function getIssueStatus(issue: Issue): StatusLabel {
    return COLUMNS.find((c) => issue.labels.includes(c.id))?.id ?? "status/backlog";
  }

  function handleDragStart(event: DragStartEvent) {
    const { active } = event;
    const issue = issues.find((i) => i.id === active.id);
    if (issue) setActiveIssue(issue);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveIssue(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const overColumn = COLUMNS.find((c) => c.id === overId);
    if (!overColumn) {
      const overIssue = issues.find((i) => i.id === overId);
      if (!overIssue) return;

      await moveIssue(activeId, getIssueStatus(overIssue));
    } else {
      await moveIssue(activeId, overColumn.id);
    }
  }

  async function moveIssue(issueId: string, newStatus: StatusLabel) {
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    const oldLabels = [...issue.labels];
    const statusLabel = `status/${newStatus.replace("status/", "")}`;
    const newLabels = oldLabels.filter((l) => !l.startsWith("status/"));
    newLabels.push(statusLabel);

    setIssues((prev) =>
      prev.map((i) =>
        i.id === issueId ? { ...i, labels: newLabels } : i
      )
    );

    setError(null);

    try {
      const response = await fetch("/api/issues/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueId: issue.id,
          repoFullName: issue.repository.fullName,
          issueNumber: issue.number,
          oldLabels,
          newLabels,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to move issue");
      }

      await fetch("/api/sync", { method: "POST" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move issue");
      setIssues((prev) =>
        prev.map((i) =>
          i.id === issueId ? { ...i, labels: oldLabels } : i
        )
      );
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-destructive/10 text-destructive text-sm p-3 rounded">
          {error}
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {COLUMNS.map((column) => {
            const columnIssues = getIssuesByStatus(column.id);
            return (
              <KanbanColumn
                key={column.id}
                id={column.id}
                title={column.title}
                count={columnIssues.length}
              >
                <SortableContext
                  items={columnIssues.map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {columnIssues.map((issue) => (
                      <IssueCard key={issue.id} issue={issue} />
                    ))}
                  </div>
                </SortableContext>
              </KanbanColumn>
            );
          })}
        </div>
        <DragOverlay>
          {activeIssue ? (
            <div className="rotate-3 opacity-90">
              <IssueCard issue={activeIssue} isDragging />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
