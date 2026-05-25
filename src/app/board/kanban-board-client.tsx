"use client";

import { KanbanBoard } from "@/components/kanban-board";
import { Issue } from "@/types";

interface KanbanBoardClientProps {
  initialIssues: Issue[];
}

export function KanbanBoardClient({ initialIssues }: KanbanBoardClientProps) {
  return <KanbanBoard initialIssues={initialIssues} />;
}
