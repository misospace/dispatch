import { getStatusFromLabels, StatusLabel } from "@/types";

export interface ProjectGroup<T> {
  key: string;
  name: string;
  issues: T[];
}

export function getProjectIssueStatus(issue: { labels: string[]; state: string }): StatusLabel {
  const status = getStatusFromLabels(issue.labels);

  if (issue.state === "closed") return "status/done";
  if (status) return status;

  return "status/backlog";
}

export function groupIssuesByProject<T extends { repository: { fullName: string; name: string } }>(issues: T[]): ProjectGroup<T>[] {
  const projectMap = new Map<string, ProjectGroup<T>>();

  for (const issue of issues) {
    const projectKey = issue.repository.fullName;
    const projectName = issue.repository.name;

    if (!projectMap.has(projectKey)) {
      projectMap.set(projectKey, { key: projectKey, name: projectName, issues: [] });
    }
    projectMap.get(projectKey)!.issues.push(issue);
  }

  return Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
