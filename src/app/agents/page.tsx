import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AGENT_PREFIX } from "@/types";
import AgentWorkPanel from "@/app/agents/agent-work-panel";

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

interface AgentStats {
  assigned: number;
  ready: number;
  inProgress: number;
  inReview: number;
}

async function getAgentStats() {
  const issues = await prisma.issue.findMany({
    where: { state: "open", repository: { enabled: true } },
  });

  const agentMap: Record<string, AgentStats> = {};

  const agentIssues = await prisma.issue.findMany({
    where: { repository: { enabled: true } },
    select: { labels: true },
  });

  for (const issue of agentIssues) {
    for (const label of issue.labels) {
      if (label.startsWith(AGENT_PREFIX)) {
        if (!agentMap[label]) agentMap[label] = { assigned: 0, ready: 0, inProgress: 0, inReview: 0 };
        agentMap[label].assigned++;
        if (issue.labels.includes("status/ready")) agentMap[label].ready++;
        if (issue.labels.includes("status/in-progress")) agentMap[label].inProgress++;
        if (issue.labels.includes("status/in-review")) agentMap[label].inReview++;
      }
    }
  }

  return agentMap;
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

async function getDiscoveredAgents(): Promise<string[]> {
  const runs = await prisma.agentRun.findMany({
    distinct: ["agentName"],
    select: { agentName: true },
  });
  return runs.map((r: { agentName: string }) => r.agentName);
}

export default async function AgentsPage() {
  const [agentStats, recentRuns, discoveredAgents] = await Promise.all([
    getAgentStats(),
    getRecentRuns(),
    getDiscoveredAgents(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Agents</h1>
        <p className="text-muted-foreground">Agent activity and assignments</p>
      </div>

      {discoveredAgents.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              No agents have reported yet. Agents appear after POSTing to /api/agent-runs with your agent token.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {discoveredAgents.map((agentName: string) => {
            const label = `${AGENT_PREFIX}${agentName}`;
            const stats = agentStats[label] || { assigned: 0, ready: 0, inProgress: 0, inReview: 0 };
            return (
              <Card key={agentName}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium capitalize">
                    {agentName.replace(AGENT_PREFIX, "")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Assigned</span>
                      <span className="font-medium">{stats.assigned}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Ready</span>
                      <span className="font-medium">{stats.ready}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">In Progress</span>
                      <span className="font-medium">{stats.inProgress}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">In Review</span>
                      <span className="font-medium">{stats.inReview}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
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
