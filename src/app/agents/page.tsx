import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import AgentWorkPanel from "@/app/agents/agent-work-panel";
import {
  getAgentActivityWindowMs,
  getAgentDirectory,
  type AgentDirectoryEntry,
} from "@/lib/agent-directory";

export const dynamic = "force-dynamic";

interface AgentRun {
  id: string;
  agentName: string;
  runType: string;
  status: string;
  startedAt: Date;
  summary?: string;
  errorMessage?: string;
}

async function getRecentRuns(): Promise<AgentRun[]> {
  const runs = await prisma.agentRun.findMany({
    take: 20,
    orderBy: { createdAt: "desc" },
  });
  return runs.map((run) => ({
    ...run,
    summary: run.summary ?? undefined,
    errorMessage: run.errorMessage ?? undefined,
  }));
}

function formatActivityWindow(windowMs: number): string {
  const day = 24 * 60 * 60 * 1000;
  if (windowMs % day === 0) {
    const days = windowMs / day;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const hour = 60 * 60 * 1000;
  if (windowMs % hour === 0) {
    const hours = windowMs / hour;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${Math.max(1, Math.round(windowMs / (60 * 1000)))} minutes`;
}

interface PageProps {
  searchParams: Promise<{ inactive?: string }>;
}

export default async function AgentsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const includeInactive = params.inactive === "1" || params.inactive === "true";
  const [directory, recentRuns] = await Promise.all([
    getAgentDirectory({ includeInactive }),
    getRecentRuns(),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-muted-foreground">
            Current agent activity and assignments. Active means an open assignment, live
            work, or a report/heartbeat within the last {formatActivityWindow(getAgentActivityWindowMs())}.
          </p>
        </div>
        {includeInactive ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/agents">Hide inactive/history</Link>
          </Button>
        ) : directory.inactiveHidden > 0 ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/agents?inactive=1">
              Show inactive/history ({directory.inactiveHidden})
            </Link>
          </Button>
        ) : null}
      </div>

      {directory.totalIdentities === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              No agents have reported yet. Agents appear after POSTing to /api/agent-runs with your agent token.
            </p>
          </CardContent>
        </Card>
      ) : directory.agents.length === 0 ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            <p className="text-sm text-muted-foreground">
              No active agents. {directory.inactiveHidden} inactive{" "}
              {directory.inactiveHidden === 1 ? "identity is" : "identities are"} hidden: no open
              assignments, no live work, and no recent report. No recent report does not prove an
              agent is offline — history is preserved and any new activity makes it visible again.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/agents?inactive=1">Show inactive/history</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {directory.agents.map((entry: AgentDirectoryEntry) => (
              <Card key={entry.agentName}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-medium capitalize">
                      {entry.agentName}
                    </CardTitle>
                    <Badge variant={entry.active ? "default" : "outline"}>
                      {entry.active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Assigned (open)</span>
                      <span className="font-medium">{entry.assignedOpen}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Executing</span>
                      <span className="font-medium">{entry.executing}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Ready</span>
                      <span className="font-medium">{entry.ready}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">In Progress</span>
                      <span className="font-medium">{entry.inProgress}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">In Review</span>
                      <span className="font-medium">{entry.inReview}</span>
                    </div>
                    <div
                      className="flex justify-between"
                      title="Latest report/heartbeat Dispatch recorded for this identity. This is ledger time, not inferred execution liveness."
                    >
                      <span className="text-muted-foreground">Last seen</span>
                      <span className="font-medium">
                        {entry.lastSeenAt ? entry.lastSeenAt.toLocaleString() : "No reports recorded"}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {includeInactive && directory.inactiveHidden > 0 && (
            <p className="text-xs text-muted-foreground">
              Inactive identities have no open assignment, no live work, and no report/heartbeat
              within the activity window. Hiding is display-only: AgentRun and audit history stay
              intact, and later activity makes an identity visible again.
            </p>
          )}
        </>
      )}

      <AgentWorkPanel />

      <Card>
        <CardHeader>
          <CardTitle>Recent Agent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent runs recorded</p>
          ) : (
            <Table>
              <TableBody>
                {recentRuns.map((run: AgentRun) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium capitalize">{run.agentName}</TableCell>
                    <TableCell>{run.runType}</TableCell>
                    <TableCell>
                      <Badge variant={
                        run.status === "success" ? "default" :
                        run.status === "error" ? "destructive" : "secondary"
                      }>
                        {run.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {run.startedAt.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {run.summary || "-"}
                    </TableCell>
                    {run.errorMessage && (
                      <TableCell className="text-destructive text-sm">
                        {run.errorMessage}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
