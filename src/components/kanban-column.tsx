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
        "bg-muted/50 rounded-lg p-3 min-h-[200px] lg:w-72 lg:shrink-0",
        isOver && "ring-2 ring-primary bg-primary/5"
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">{title}</h3>
        <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
          {count}
        </span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}