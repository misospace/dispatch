import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS } from "@/types";
import { getProjectIssueStatus, groupIssuesByProject } from "@/lib/projects";

export const dynamic = "force-dynamic";

async function getProjects() {
  const issues = await prisma.issue.findMany({
    where: { repository: { enabled: true } },
    include: { repository: true },
  });

  return {
    projects: groupIssuesByProject(issues),
    issueCount: issues.length,
  };
}

export default async function ProjectsPage() {
  const { projects } = await getProjects();

  if (projects.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-muted-foreground">Group synced issues by repository</p>
        </div>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No issues have been synced yet. Use Sync Issues on the Board to import GitHub issues first.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Projects</h1>
        <p className="text-muted-foreground">Group synced issues by repository</p>
      </div>

      <div className="grid gap-6">
        {projects.map((project) => (
          <Card key={project.key}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {project.name}
                <Badge variant="secondary">{project.issues.length} issues</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {STATUS_LABELS.map((status) => {
                  const statusIssues = project.issues.filter(
                    (i: any) => getProjectIssueStatus(i as any) === status
                  );
                  return (
                    <div key={status} className="space-y-2">
                      <h4 className="text-sm font-medium text-muted-foreground">
                        {status.replace("status/", "")}
                      </h4>
                      {statusIssues.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No issues</p>
                      ) : (
                        <div className="space-y-1">
                          {(statusIssues as any).map((issue: any) => (
                            <a
                              key={issue.id}
                              href={issue.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block text-sm p-2 rounded bg-muted hover:bg-muted/80"
                            >
                              <span className="font-mono text-xs text-muted-foreground">
                                #{issue.number}
                              </span>{" "}
                              {issue.title}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
