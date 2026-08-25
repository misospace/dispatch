"use client";

import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { StatusLabel } from "@/types";

interface KanbanColumnProps {
  id: StatusLabel;
  title: string;
  count: number;
  children: React.ReactNode;
}

export function KanbanColumn({ id, title, count, children }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "bg-muted/50 rounded-lg p-3 min-h-[200px] min-w-0",
        isOver && "ring-2 ring-primary bg-primary/5"
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">{title}</h3>
        <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
          {count}
        </span>
      </div>
      {/* A single column can hold every issue closed inside the Done retention
          window — 92 of them as of 2026-08-25 — which stretched the page far
          past the viewport and buried the other columns. Cap the list and let
          the column scroll itself instead. */}
      <div className="space-y-2 max-h-[calc(100vh-20rem)] overflow-y-auto pr-1">{children}</div>
    </div>
  );
}