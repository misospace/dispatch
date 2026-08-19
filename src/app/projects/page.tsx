import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BOARD_COLUMNS, STATUS_LABELS } from "@/types";
import type { IssueWithRepo } from "@/types";
import { applyRenovateIssueExclusion, buildVisibleIssueWhere } from "@/lib/issue-filters";
import { getProjectIssueStatus, groupIssuesByProject } from "@/lib/projects";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function getProjects() {
  // Fetch open issues + recently closed Done issues (within retention window)
  // to match Board page retention semantics.
  const where: Record<string, unknown> = { repository: { enabled: true } };
  buildVisibleIssueWhere(where);
  applyRenovateIssueExclusion(where);

  const issues = await prisma.issue.findMany({
    where,
    include: { repository: true },
  });

  return {
    projects: groupIssuesByProject(issues),
    issueCount: issues.length,
  };
}

export default async function ProjectsPage(_props: PageProps) {
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
              {/* Stacks on small screens, then becomes one scrollable row. A grid
                  with a fixed column count adds a ROW when BOARD_COLUMNS outgrows
                  it rather than overflowing this wrapper. */}
              <div className="overflow-x-auto pb-2">
                <div className="grid grid-cols-1 gap-4 lg:flex lg:min-w-max">
                  {BOARD_COLUMNS.map((column) => {
                    const statusIssues = project.issues.filter(
                      (i: IssueWithRepo) => getProjectIssueStatus(i) === column.id
                    );
                    return (
                      <div key={column.id} className="space-y-2 lg:w-72 lg:shrink-0">
                        <h4 className="text-sm font-medium text-muted-foreground">
                          {column.title}
                        </h4>
                        {statusIssues.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No issues</p>
                        ) : (
                          <div className="space-y-1">
                            {statusIssues.map((issue: IssueWithRepo) => (
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
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
