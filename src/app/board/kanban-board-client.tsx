"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { KanbanBoard } from "@/components/kanban-board";
import { Issue } from "@/types";

interface KanbanBoardClientProps {
  initialIssues: Issue[];
}

export function KanbanBoardClient({ initialIssues }: KanbanBoardClientProps) {
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [refreshing, setRefreshing] = useState(false);

  async function refreshBoard() {
    setRefreshing(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const query = params.toString();
      const url = `/api/issues${query ? `?${query}` : ""}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setIssues(data);
      }
    } catch {
      // Silent fail — user can manually sync
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button onClick={refreshBoard} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh board"}
        </Button>
      </div>
      <KanbanBoard initialIssues={issues} />
    </div>
  );
}
