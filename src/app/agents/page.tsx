import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AGENT_LABELS } from "@/types";

export const dynamic = "force-dynamic";

async function getAgentStats() {
  const issues = await prisma.issue.findMany({
    where: { state: "open", repository: { enabled: true } },
  });

  const agentMap: Record<string, { assigned: number; inProgress: number; inReview: number }> = {};

  for (const label of AGENT_LABELS) {
    agentMap[label] = { assigned: 0, inProgress: 0, inReview: 0 };
  }

  for (const issue of issues) {
    for (const label of AGENT_LABELS) {
      if (issue.labels.includes(label)) {
        agentMap[label].assigned++;
        if (issue.labels.includes("status/in-progress")) {
          agentMap[label].inProgress++;
        }
        if (issue.labels.includes("status/in-review")) {
          agentMap[label].inReview++;
        }
      }
    }
  }

  return agentMap;
}

async function getRecentRuns() {
  return prisma.agentRun.findMany({
    take: 20,
    orderBy: { createdAt: "desc" },
  });
}

export default async function AgentsPage() {
  const [agentStats, recentRuns] = await Promise.all([getAgentStats(), getRecentRuns()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Agents</h1>
        <p className="text-muted-foreground">Agent activity and assignments</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {AGENT_LABELS.map((label) => {
          const stats = agentStats[label];
          return (
            <Card key={label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium capitalize">
                  {label.replace("agent/", "")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Assigned</span>
                    <span className="font-medium">{stats.assigned}</span>
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
                {recentRuns.map((run) => (
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