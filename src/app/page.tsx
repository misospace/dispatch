import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { STATUS_LABELS } from "@/types";

export const dynamic = "force-dynamic";

async function getStats() {
  const [issues, recentRuns, recentLogs] = await Promise.all([
    prisma.issue.findMany({
      where: { state: "open", repository: { enabled: true } },
      include: { repository: true },
    }),
    prisma.agentRun.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
    }),
    prisma.auditLog.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const byStatus = STATUS_LABELS.reduce(
    (acc, label) => {
      acc[label] = issues.filter((i) => i.labels.includes(label)).length;
      return acc;
    },
    {} as Record<string, number>
  );

  const byAgent = issues.reduce(
    (acc, issue) => {
      const agent = issue.labels.find((l) => l.startsWith("agent/"));
      if (agent) {
        acc[agent] = (acc[agent] || 0) + 1;
      }
      return acc;
    },
    {} as Record<string, number>
  );

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const staleInProgress = issues.filter(
    (i) =>
      i.labels.includes("status/in-progress") &&
      i.updatedAt < oneWeekAgo
  ).length;

  return { byStatus, byAgent, staleInProgress, recentRuns, recentLogs, totalOpen: issues.length };
}

export default async function OverviewPage() {
  const { byStatus, byAgent, staleInProgress, recentRuns, recentLogs, totalOpen } = await getStats();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-muted-foreground">Mission Control overview</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Open Issues</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalOpen}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">In Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{byStatus["status/in-progress"] || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">In Review</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{byStatus["status/in-review"] || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Stale (7d+)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{staleInProgress}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Issues by Agent</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(byAgent).length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent assignments</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(byAgent).map(([agent, count]) => (
                  <div key={agent} className="flex justify-between text-sm">
                    <span>{agent.replace("agent/", "")}</span>
                    <span className="font-medium">{(count as number)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Issues by Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {STATUS_LABELS.map((label) => (
                <div key={label} className="flex justify-between text-sm">
                  <span>{label.replace("status/", "")}</span>
                  <span className="font-medium">{byStatus[label] || 0}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
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
                    <TableCell className="font-medium">{run.agentName}</TableCell>
                    <TableCell>{run.runType}</TableCell>
                    <TableCell>
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        run.status === "success" ? "bg-green-100 text-green-700" :
                        run.status === "error" ? "bg-red-100 text-red-700" :
                        "bg-yellow-100 text-yellow-700"
                      }`}>
                        {run.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {run.createdAt.toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Audit Log</CardTitle>
        </CardHeader>
        <CardContent>
          {recentLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audit logs</p>
          ) : (
            <Table>
              <TableBody>
                {recentLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="font-medium">{log.actor}</TableCell>
                    <TableCell>{log.action}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.repoFullName} #{log.issueNumber}
                    </TableCell>
                    <TableCell>
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        log.success ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                      }`}>
                        {log.success ? "success" : "failed"}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.createdAt.toLocaleDateString()}
                    </TableCell>
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