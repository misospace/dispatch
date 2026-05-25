"use client";

import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { cn } from "@/lib/utils";
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
import { Button } from "@/components/ui/button";
import { Issue, StatusLabel } from "@/types";
import { getIssuesByStatus, getIssueStatus } from "@/lib/kanban";

const COLUMNS: { id: StatusLabel; title: string }[] = [
  { id: "status/backlog", title: "Backlog" },
  { id: "status/ready", title: "Ready" },
  { id: "status/in-progress", title: "In Progress" },
  { id: "status/in-review", title: "In Review" },
  { id: "status/done", title: "Done" },
];

const AUTO_REFRESH_INTERVAL_MS = 30_000; // 30 seconds

interface KanbanBoardProps {
  initialIssues: Issue[];
}

export interface KanbanBoardRef {
  refresh: () => void;
}

export const KanbanBoard = forwardRef<KanbanBoardRef, KanbanBoardProps>(function KanbanBoard(
  { initialIssues },
  ref
) {
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  // Store latest issues in a ref for doRefresh to always use current state
  const issuesRef = useRef(issues);
  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    setIssues(initialIssues);
  }, [initialIssues]);

  useEffect(() => {
    setLastRefreshedAt(new Date());
  }, []);

  // Auto-dismiss notification after 5 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const query = params.toString();
      const url = `/api/issues${query ? `?${query}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error("Failed to refresh board");
      }
      const data = await res.json();
      setIssues(data);
      setLastRefreshedAt(new Date());
      setRefreshError(null);
    } catch {
      setRefreshError("Board refresh failed. Showing previous state.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const intervalId = setInterval(async () => {
      await doRefresh();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [doRefresh]);

  // Refresh when tab/window regains focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void doRefresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [doRefresh]);

  // Expose refresh method via ref
  useImperativeHandle(ref, () => ({
    refresh: doRefresh,
  }), [doRefresh]);

  function handleDragStart(event: DragStartEvent) {
    const { active } = event;
    const issue = issuesRef.current.find((i) => i.id === active.id);
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
      const overIssue = issuesRef.current.find((i) => i.id === overId);
      if (!overIssue) return;

      await moveIssue(activeId, getIssueStatus(overIssue));
    } else {
      await moveIssue(activeId, overColumn.id);
    }
  }

  async function moveIssue(issueId: string, newStatus: StatusLabel) {
    const issue = issuesRef.current.find((i) => i.id === issueId);
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-muted-foreground">
          {lastRefreshedAt ? `Last refreshed ${lastRefreshedAt.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}` : "Last refreshed after page load"}
        </div>
        <Button onClick={() => void doRefresh()} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh board"}
        </Button>
      </div>
      {refreshError && (
        <div className="bg-yellow-50 text-yellow-900 text-sm p-3 rounded flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span>{refreshError}</span>
          <button
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => void doRefresh()}
            disabled={refreshing}
          >
            Retry
          </button>
        </div>
      )}
      {error && (
        <div className="bg-destructive/10 text-destructive text-sm p-3 rounded flex items-center justify-between">
          <span>{error}</span>
          <button
            className="text-destructive hover:text-destructive-foreground ml-4"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}
      {notification && (
        <div className={cn(
          "text-sm p-3 rounded flex items-center justify-between",
          notification.type === "success" ? "bg-green-50 text-green-800" : "bg-destructive/10 text-destructive"
        )}>
          <span>{notification.message}</span>
          <button
            className="ml-4 opacity-60 hover:opacity-100"
            onClick={() => setNotification(null)}
          >
            ✕
          </button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {COLUMNS.map((column) => {
            const columnIssues = getIssuesByStatus(issues, column.id);
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
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        onIssueUpdate={() => doRefresh()}
                      />
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
});
