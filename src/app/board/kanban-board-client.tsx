"use client";

import { KanbanBoard } from "@/components/kanban-board";
import { Issue } from "@/types";
import type { LaneConfig } from "@/lib/lane-config";

interface KanbanBoardClientProps {
  initialIssues: Issue[];
  lanes?: LaneConfig[];
}

export function KanbanBoardClient({ initialIssues, lanes }: KanbanBoardClientProps) {
  return <KanbanBoard initialIssues={initialIssues} lanes={lanes} />;
}
