"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Issue, LABEL_COLORS, AGENT_PREFIX, OWNER_PREFIX } from "@/types";
import { GitPullRequest, MessageSquare, ExternalLink, MoreVertical, User, Users, X } from "lucide-react";
import { useState, useCallback } from "react";

interface IssueCardProps {
  issue: Issue;
  isDragging?: boolean;
  onIssueUpdate?: (updatedIssue: Issue) => void;
}

export function IssueCard({ issue, isDragging, onIssueUpdate }: IssueCardProps) {
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

  const [menuOpen, setMenuOpen] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [fetchingAgents, setFetchingAgents] = useState(false);
  const [ownerNameInput, setOwnerNameInput] = useState("");

  const statusColor = issue.labels
    .filter((l) => l.startsWith("status/"))
    .map((l) => LABEL_COLORS[l] || "6b7280")[0] || "6b7280";

  const agentLabel = issue.labels.find((l) => l.startsWith("agent/"));
  const ownerLabel = issue.labels.find((l) => l.startsWith("owner/"));
  const priorityLabel = issue.labels.find((l) => l.startsWith("priority/"));

  // Fetch available agents on mount (once)
  const fetchAgents = useCallback(async () => {
    if (agents.length > 0 || fetchingAgents) return;
    setFetchingAgents(true);
    try {
      const res = await fetch("/api/issues/actions/agents");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.agents)) setAgents(data.agents);
      }
    } catch {
      // Silently fail — agents list is optional
    } finally {
      setFetchingAgents(false);
    }
  }, [agents.length, fetchingAgents]);

  // Trigger fetch when menu opens
  const handleMenuToggle = (open: boolean) => {
    setMenuOpen(open);
    if (open) fetchAgents();
  };

  // Refresh the board after a successful action
  const handleSuccess = async (actionType: string) => {
    setLoadingAction(null);
    setError(null);
    setOwnerNameInput("");

    // Trigger a sync to pick up label changes from GitHub
    try {
      await fetch("/api/sync", { method: "POST" });
    } catch {
      // Sync failure is non-blocking
    }

    if (onIssueUpdate) {
      // Re-fetch the issue data by triggering a board refresh
      onIssueUpdate(issue);
    }

    setMenuOpen(false);
  };

  const handleError = (msg: string) => {
    setError(msg);
    setLoadingAction(null);
  };

  async function handleAssign(type: "agent" | "owner", name: string) {
    setLoadingAction(`${type}-${name}`);
    setError(null);
    try {
      const value = type === "agent" ? `${AGENT_PREFIX}${name}` : `${OWNER_PREFIX}${name}`;
      const res = await fetch("/api/issues/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueId: issue.id,
          repoFullName: issue.repository.fullName,
          issueNumber: issue.number,
          action: type === "agent" ? "assign_agent" : "assign_owner",
          value,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      await handleSuccess(`${type}-assign`);
    } catch (err) {
      handleError(err instanceof Error ? err.message : "Assignment failed");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleUnassign(type: "agent" | "owner") {
    setLoadingAction(`unassign-${type}`);
    setError(null);
    try {
      const res = await fetch("/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueId: issue.id,
          repoFullName: issue.repository.fullName,
          issueNumber: issue.number,
          action: type === "agent" ? "unassign_agent" : "unassign_owner",
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      await handleSuccess(`unassign-${type}`);
    } catch (err) {
      handleError(err instanceof Error ? err.message : "Unassignment failed");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleAssignOwnerSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = ownerNameInput.trim();
    if (!trimmed) return;
    await handleAssign("owner", trimmed);
  }

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "cursor-grab active:cursor-grabbing relative",
        isDragging && "opacity-50 ring-2 ring-primary"
      )}
    >
      <CardHeader className="p-3 pb-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs font-mono text-muted-foreground">
            #{issue.number}
          </span>
          <div className="flex items-center gap-1">
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
            {/* Assignment controls dropdown trigger */}
            <div className="relative">
              <button
                className="text-muted-foreground hover:text-primary p-0.5 rounded"
                onClick={(e) => {
                  e.stopPropagation();
                  handleMenuToggle(!menuOpen);
                }}
                aria-label="Assignment controls"
              >
                <MoreVertical className="h-3 w-3" />
              </button>
              {menuOpen && (
                <>
                  {/* Backdrop to close menu */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => handleMenuToggle(false)}
                  />
                  {/* Dropdown menu */}
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 bg-popover border rounded-md shadow-lg p-2 text-popover-foreground">
                    {error && (
                      <div className="text-xs text-destructive mb-2 p-2 bg-destructive/10 rounded">
                        {error}
                      </div>
                    )}

                    {/* Current assignments */}
                    {(agentLabel || ownerLabel) && (
                      <div className="mb-2 pb-2 border-b">
                        <p className="text-xs font-medium mb-1 text-muted-foreground">Currently assigned</p>
                        {agentLabel && (
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                              Agent: {agentLabel.replace(AGENT_PREFIX, "")}
                            </span>
                            <button
                              className="text-muted-foreground hover:text-destructive ml-2"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUnassign("agent");
                              }}
                              disabled={loadingAction !== null}
                              aria-label={`Unassign agent ${agentLabel.replace(AGENT_PREFIX, "")}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                        {ownerLabel && (
                          <div className="flex items-center justify-between text-xs">
                            <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                              Owner: {ownerLabel.replace(OWNER_PREFIX, "")}
                            </span>
                            <button
                              className="text-muted-foreground hover:text-destructive ml-2"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUnassign("owner");
                              }}
                              disabled={loadingAction !== null}
                              aria-label={`Unassign owner ${ownerLabel.replace(OWNER_PREFIX, "")}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Assign agent */}
                    <div className="mb-2 pb-2 border-b">
                      <p className="text-xs font-medium mb-1 text-muted-foreground flex items-center gap-1">
                        <Users className="h-3 w-3" /> Assign agent
                      </p>
                      {fetchingAgents ? (
                        <p className="text-xs text-muted-foreground">Loading agents…</p>
                      ) : agents.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {agents.map((agent) => (
                            <button
                              key={agent}
                              className={cn(
                                "px-2 py-0.5 text-xs rounded transition-colors",
                                agentLabel === `${AGENT_PREFIX}${agent}`
                                  ? "bg-purple-200 text-purple-800 ring-1 ring-purple-400"
                                  : "bg-muted hover:bg-muted-foreground/20"
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAssign("agent", agent);
                              }}
                              disabled={loadingAction !== null}
                            >
                              {agent}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No agents configured. Set the AGENTS env var.</p>
                      )}
                    </div>

                    {/* Assign owner */}
                    <div>
                      <p className="text-xs font-medium mb-1 text-muted-foreground flex items-center gap-1">
                        <User className="h-3 w-3" /> Assign owner
                      </p>
                      <form onSubmit={handleAssignOwnerSubmit} className="flex gap-1">
                        <input
                          type="text"
                          placeholder="e.g. alice"
                          value={ownerNameInput}
                          onChange={(e) => setOwnerNameInput(e.target.value)}
                          disabled={loadingAction !== null}
                          className="flex-1 min-w-0 px-2 py-0.5 text-xs rounded border bg-background text-popover-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                          aria-label="Owner name"
                        />
                        <button
                          type="submit"
                          disabled={loadingAction !== null || !ownerNameInput.trim()}
                          className="px-2 py-0.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                          aria-label="Assign owner"
                        >
                          Assign
                        </button>
                      </form>
                      <p className="text-xs text-muted-foreground mt-1">
                        Owner labels are applied as <code>owner/{ownerNameInput || "name"}</code>.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
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
              {agentLabel.replace(AGENT_PREFIX, "")}
            </span>
          )}
          {ownerLabel && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-700">
              {ownerLabel.replace(OWNER_PREFIX, "")}
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
