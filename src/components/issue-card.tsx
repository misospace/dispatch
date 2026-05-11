"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Issue, LABEL_COLORS } from "@/types";
import { GitPullRequest, MessageSquare, ExternalLink } from "lucide-react";

interface IssueCardProps {
  issue: Issue;
  isDragging?: boolean;
}

export function IssueCard({ issue, isDragging }: IssueCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: issue.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const statusColor = issue.labels
    .filter((l) => l.startsWith("status/"))
    .map((l) => LABEL_COLORS[l] || "6b7280")[0] || "6b7280";

  const agentLabel = issue.labels.find((l) => l.startsWith("agent/"));
  const priorityLabel = issue.labels.find((l) => l.startsWith("priority/"));

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-50 ring-2 ring-primary"
      )}
    >
      <CardHeader className="p-3 pb-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs font-mono text-muted-foreground">
            #{issue.number}
          </span>
          <div className="flex gap-1">
            {issue.commentsCount > 0 && (
              <span className="flex items-center text-xs text-muted-foreground">
                <MessageSquare className="h-3 w-3 mr-0.5" />
                {issue.commentsCount}
              </span>
            )}
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <p className="text-sm font-medium line-clamp-2">{issue.title}</p>
        <div className="flex flex-wrap gap-1 mt-2">
          <span
            className="px-1.5 py-0.5 text-xs rounded"
            style={{ backgroundColor: `#${statusColor}20`, color: `#${statusColor}` }}
          >
            {issue.labels.find((l) => l.startsWith("status/"))?.replace("status/", "") || "backlog"}
          </span>
          {agentLabel && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-purple-100 text-purple-700">
              {agentLabel.replace("agent/", "")}
            </span>
          )}
          {priorityLabel && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-red-100 text-red-700">
              {priorityLabel.replace("priority/", "p")}
            </span>
          )}
        </div>
        <div className="flex items-center mt-2 text-xs text-muted-foreground">
          <span>{issue.repository.fullName}</span>
          {issue.assignees.length > 0 && (
            <span className="ml-2">· {issue.assignees.join(", ")}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}