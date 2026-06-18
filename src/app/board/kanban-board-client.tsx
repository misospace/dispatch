"use client";

import { KanbanBoard } from "@/components/kanban-board";
import { Issue } from "@/types";

interface LaneOption {
  id: string;
  title: string;
  claimable: boolean;
  color?: string;
}

interface KanbanBoardClientProps {
  initialIssues: Issue[];
  lanes?: LaneOption[];
}

export function KanbanBoardClient({ initialIssues, lanes }: KanbanBoardClientProps) {
  return <KanbanBoard initialIssues={initialIssues} lanes={lanes} />;
}
