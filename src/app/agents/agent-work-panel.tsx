"use client";

import { authedFetch } from "@/lib/client-auth";
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AgentWorkItem {
  id: string;
  agentName: string;
  issueId: string | null;
  runId: string | null;
  state: string;
  checkpoint: string;
  branch: string | null;
  prUrl: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date;
  summary: string | null;
  blockerReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  issueNumber: number | null;
  issueTitle: string | null;
  repoFullName: string | null;
}

interface AgentWorkResponse {
  activeWork: AgentWorkItem[];
  staleLeases: AgentWorkItem[];
}

interface ExecutionRow {
  id: string;
  agentName: string;
  source: string;
  executionId: string;
  workType: string;
  workRefUrl: string | null;
  issueId: string | null;
  executionState: string;
  startedAt: string | null;
  lastObservedAt: string;
  endedAt: string | null;
  summary: string | null;
  revision: number;
  staleness: "live" | "stale";
}

interface AgentExecutionsResponse {
  capability: { name: string; protocolVersion: number };
  executions: ExecutionRow[];
}

const STATE_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  CLAIMED: { label: "Claimed", variant: "secondary" },
  IN_PROGRESS: { label: "In Progress", variant: "default" },
  BLOCKED: { label: "Blocked", variant: "destructive" },
  STALE: { label: "Stale", variant: "outline" },
  DONE: { label: "Done", variant: "secondary" },
  RELEASED: { label: "Released", variant: "secondary" },
};

const EXECUTION_STATE_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  RUNNING: { label: "Running", variant: "default" },
  SUCCEEDED: { label: "Succeeded", variant: "secondary" },
  FAILED: { label: "Failed", variant: "destructive" },
  CANCELLED: { label: "Cancelled", variant: "outline" },
};

const WORK_TYPE_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  implement: { label: "Implement", variant: "secondary" },
  pr_fix: { label: "PR Fix", variant: "outline" },
};

function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatIssueUrl(item: AgentWorkItem): string | null {
  if (item.prUrl) return item.prUrl;
  if (item.issueNumber && item.repoFullName) {
    return `https://github.com/${item.repoFullName}/issues/${item.issueNumber}`;
  }
  return null;
}

function formatRepoUrl(item: AgentWorkItem): string | null {
  if (item.repoFullName) return `https://github.com/${item.repoFullName}`;
  return null;
}

function workRefLabel(workRefUrl: string | null): string {
  if (!workRefUrl) return "—";
  const segments = workRefUrl.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : workRefUrl;
}

function findLinkedLegacyWork(
  execution: ExecutionRow,
  activeWork: AgentWorkItem[],
): AgentWorkItem | null {
  if (!execution.workRefUrl) return null;
  return (
    activeWork.find((w) => {
      if (w.agentName.toLowerCase() !== execution.agentName.toLowerCase()) return false;
      if (w.prUrl && w.prUrl === execution.workRefUrl) return true;
      if (w.issueNumber && w.repoFullName) {
        return (
          execution.workRefUrl ===
          `https://github.com/${w.repoFullName}/issues/${w.issueNumber}`
        );
      }
      return false;
    }) ?? null
  );
}

export default function AgentWorkPanel() {
  const [data, setData] = useState<AgentWorkResponse | null>(null);
  const [executions, setExecutions] = useState<ExecutionRow[] | null>(null);
  const [executionsError, setExecutionsError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reassigning, setReassigning] = useState<string | null>(null);
  const [reassignAgent, setReassignAgent] = useState<Record<string, string>>({});
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchData = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/agent-work?include_stale=true`);
      if (res.ok) {
        const json: AgentWorkResponse = await res.json();
        setData(json);
      }
    } catch (e) {
      console.error("Failed to fetch agent work:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchExecutions = useCallback(async () => {
    try {
      const res = await authedFetch("/api/agent-executions");
      if (res.ok) {
        const json: AgentExecutionsResponse = await res.json();
        setExecutions(json.executions ?? []);
        setExecutionsError(false);
      } else {
        setExecutions(null);
        setExecutionsError(true);
      }
    } catch (e) {
      console.error("Failed to fetch agent executions:", e);
      setExecutions(null);
      setExecutionsError(true);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchData();
    fetchExecutions();
  }, [fetchData, fetchExecutions, refreshKey]);

  const handleRelease = async (workId: string | null, leaseId?: string) => {
    try {
      const res = await authedFetch("/api/agent-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release", workId, leaseId, reason: "Released by operator" }),
      });
      if (res.ok) {
        setRefreshKey((k) => k + 1);
      }
    } catch (e) {
      console.error("Failed to release:", e);
    }
  };

  const handleReassign = async (workId: string) => {
    const newAgent = reassignAgent[workId];
    if (!newAgent?.trim()) return;
    setReassigning(workId);
    try {
      const res = await authedFetch("/api/agent-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reassign", workId, newAgentName: newAgent.trim(), reason: "Reassigned by operator" }),
      });
      if (res.ok) {
        setRefreshKey((k) => k + 1);
      }
    } catch (e) {
      console.error("Failed to reassign:", e);
    } finally {
      setReassigning(null);
    }
  };

  if (loading && !data) return <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Loading agent work...</p></CardContent></Card>;

  const activeWork = data?.activeWork.filter((w) => w.state !== "STALE") ?? [];
  const staleWork = data?.activeWork.filter((w) => w.state === "STALE") ?? [];
  const staleLeases = data?.staleLeases ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Active Agent Work</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>Refresh</Button>
        </CardHeader>
        <CardContent>
          {activeWork.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active agent work</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Checkpoint</TableHead>
                  <TableHead>Last Heartbeat</TableHead>
                  <TableHead>Branch / PR</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeWork.map((w) => {
                  const badge = STATE_BADGE[w.state] ?? { label: w.state, variant: "secondary" };
                  return (
                    <TableRow key={w.id}>
                      <TableCell className="font-medium capitalize">{w.agentName}</TableCell>
                      <TableCell>
                        {w.issueTitle ? (
                          <div>
                            <a href={formatIssueUrl(w) || undefined} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                              #{w.issueNumber} {w.issueTitle}
                            </a>
                            {w.repoFullName && (
                              <div className="text-xs text-muted-foreground">
                                <a href={formatRepoUrl(w) || undefined} target="_blank" rel="noopener noreferrer">{w.repoFullName}</a>
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Unassigned</span>
                        )}
                      </TableCell>
                      <TableCell><Badge variant={badge.variant}>{badge.label}</Badge></TableCell>
                      <TableCell className="text-sm">{w.checkpoint}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatRelative(w.lastHeartbeatAt)}
                        {w.leaseExpiresAt && (
                          <div className="text-xs">Expires: {formatRelative(w.leaseExpiresAt)}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {w.branch && <div className="text-xs font-mono">{w.branch}</div>}
                        {w.prUrl && (
                          <a href={w.prUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">PR</a>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => handleRelease(w.id)}>Release</Button>
                          {w.state !== "DONE" && w.state !== "RELEASED" && (
                            <div className="flex items-center gap-1">
                              <Input
                                placeholder="New agent"
                                className="h-7 w-24 text-xs"
                                value={reassignAgent[w.id] ?? ""}
                                onChange={(e) => setReassignAgent((prev) => ({ ...prev, [w.id]: e.target.value }))}
                                onKeyDown={(e) => e.key === "Enter" && handleReassign(w.id)}
                              />
                              <Button variant="ghost" size="sm" onClick={() => handleReassign(w.id)} disabled={reassigning === w.id}>→</Button>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source-Reported Executions</CardTitle>
        </CardHeader>
        <CardContent>
          {executionsError ? (
            <p className="text-sm text-destructive">Failed to load source-reported executions</p>
          ) : executions === null ? (
            <p className="text-sm text-muted-foreground">Loading source-reported executions...</p>
          ) : executions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No source-reported executions</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Work</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Last Observation</TableHead>
                  <TableHead>Legacy session</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.map((execution) => {
                  const badge =
                    EXECUTION_STATE_BADGE[execution.executionState] ?? {
                      label: execution.executionState,
                      variant: "secondary" as const,
                    };
                  const typeBadge = WORK_TYPE_BADGE[execution.workType] ?? {
                    label: execution.workType,
                    variant: "outline" as const,
                  };
                  const linked = findLinkedLegacyWork(execution, activeWork);
                  return (
                    <TableRow key={execution.id}>
                      <TableCell className="font-medium capitalize">{execution.agentName}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Badge variant={typeBadge.variant}>{typeBadge.label}</Badge>
                          {execution.workRefUrl ? (
                            <a
                              href={execution.workRefUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-500 hover:underline"
                            >
                              {workRefLabel(execution.workRefUrl)}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell><Badge variant={badge.variant}>{badge.label}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{execution.source}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatRelative(execution.lastObservedAt)}
                        {execution.staleness === "stale" && (
                          <Badge variant="outline" className="ml-1">Stale</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {linked ? (
                          <span>
                            Linked
                            {linked.state && ` (${STATE_BADGE[linked.state]?.label ?? linked.state})`}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {(staleWork.length > 0 || staleLeases.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Stale Work & Expired Leases</CardTitle>
          </CardHeader>
          <CardContent>
            {staleWork.length === 0 && staleLeases.length === 0 ? (
              <p className="text-sm text-muted-foreground">No stale work detected</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Issue</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Last Activity</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staleWork.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell><Badge variant="outline">AgentWork</Badge></TableCell>
                      <TableCell className="font-medium capitalize">{w.agentName}</TableCell>
                      <TableCell>
                        {w.issueTitle ? (
                          <a href={formatIssueUrl(w) || undefined} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                            #{w.issueNumber} {w.issueTitle}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">Unassigned</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{w.blockerReason ?? "No heartbeat"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatRelative(w.lastHeartbeatAt)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => handleRelease(w.id)}>Release</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {staleLeases.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell><Badge variant="outline">Lease</Badge></TableCell>
                      <TableCell className="font-medium capitalize">{l.agentName}</TableCell>
                      <TableCell>
                        {l.issueTitle ? (
                          <a href={formatIssueUrl(l) || undefined} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                            #{l.issueNumber} {l.issueTitle}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">Unassigned</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{l.blockerReason}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{l.leaseExpiresAt ? formatRelative(l.leaseExpiresAt) : '-'}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => handleRelease(null, l.id.replace("lease-", ""))}>Release</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
