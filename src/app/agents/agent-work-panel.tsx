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

const STATE_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  CLAIMED: { label: "Claimed", variant: "secondary" },
  IN_PROGRESS: { label: "In Progress", variant: "default" },
  BLOCKED: { label: "Blocked", variant: "destructive" },
  STALE: { label: "Stale", variant: "outline" },
  DONE: { label: "Done", variant: "secondary" },
  RELEASED: { label: "Released", variant: "secondary" },
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

export default function AgentWorkPanel() {
  const [data, setData] = useState<AgentWorkResponse | null>(null);
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

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData, refreshKey]);

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
