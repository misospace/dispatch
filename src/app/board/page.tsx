import { Suspense } from "react";
import { prisma } from "@/lib/prisma";
import { KanbanBoard } from "@/components/kanban-board";
import { FilterBar } from "@/components/filter-bar";

export const dynamic = "force-dynamic";

async function getIssues(repo?: string, agent?: string, owner?: string, project?: string, priority?: string) {
  const where: Record<string, unknown> = { repository: { enabled: true } };

  if (repo) where.repository = { ...(where.repository as object), fullName: repo };
  if (agent) where.labels = { has: agent };
  if (owner) where.labels = { has: owner };
  if (project) where.labels = { has: `project/${project}` };
  if (priority) where.labels = { has: priority };

  return prisma.issue.findMany({
    where,
    include: { repository: true },
    orderBy: { updatedAt: "desc" },
  });
}

async function getRepos() {
  return prisma.repository.findMany({
    where: { enabled: true },
    orderBy: { fullName: "asc" },
  });
}

async function getFilterOptions() {
  const issues = await prisma.issue.findMany({
    where: { repository: { enabled: true } },
    select: { labels: true },
  });

  const agents = new Set<string>();
  const owners = new Set<string>();

  for (const issue of issues) {
    for (const label of issue.labels) {
      if (label.startsWith("agent/")) agents.add(label);
      if (label.startsWith("owner/")) owners.add(label);
    }
  }

  return {
    agents: Array.from(agents).sort(),
    owners: Array.from(owners).sort(),
  };
}

interface PageProps {
  searchParams: { repo?: string; agent?: string; owner?: string; project?: string; priority?: string };
}

export default async function BoardPage({ searchParams }: PageProps) {
  const [issues, repos, filterOptions] = await Promise.all([
    getIssues(searchParams.repo, searchParams.agent, searchParams.owner, searchParams.project, searchParams.priority),
    getRepos(),
    getFilterOptions(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Board</h1>
        <p className="text-muted-foreground">Kanban board view of issues</p>
      </div>

      <FilterBar
        repos={repos}
        agents={filterOptions.agents}
        owners={filterOptions.owners}
        activeFilters={{
          repo: searchParams.repo || "",
          agent: searchParams.agent || "",
          owner: searchParams.owner || "",
          project: searchParams.project || "",
          priority: searchParams.priority || "",
        }}
      />

      <KanbanBoard initialIssues={issues} />
    </div>
  );
}