import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getProjectFromLabels, STATUS_LABELS } from "@/types";

export const dynamic = "force-dynamic";

async function getProjects() {
  const issues = await prisma.issue.findMany({
    where: { repository: { enabled: true } },
    include: { repository: true },
  });

  const projectMap = new Map<string, { name: string; issues: typeof issues }>();

  for (const issue of issues) {
    const projectName = getProjectFromLabels(issue.labels);
    if (!projectName) continue;

    if (!projectMap.has(projectName)) {
      projectMap.set(projectName, { name: projectName, issues: [] });
    }
    projectMap.get(projectName)!.issues.push(issue);
  }

  return Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export default async function ProjectsPage() {
  const projects = await getProjects();

  if (projects.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-muted-foreground">Group issues by project/* labels</p>
        </div>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No projects found. Add project/* labels to your GitHub issues.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Projects</h1>
        <p className="text-muted-foreground">Group issues by project/* labels</p>
      </div>

      <div className="grid gap-6">
        {projects.map((project) => (
          <Card key={project.name}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {project.name}
                <Badge variant="secondary">{project.issues.length} issues</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {STATUS_LABELS.map((status) => {
                  const statusIssues = project.issues.filter((i) => i.labels.includes(status));
                  return (
                    <div key={status} className="space-y-2">
                      <h4 className="text-sm font-medium text-muted-foreground">
                        {status.replace("status/", "")}
                      </h4>
                      {statusIssues.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No issues</p>
                      ) : (
                        <div className="space-y-1">
                          {statusIssues.map((issue) => (
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