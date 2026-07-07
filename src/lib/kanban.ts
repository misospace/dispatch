import { Issue, StatusLabel, getEffectiveStatus } from "@/types";

export function getIssueStatus(issue: Pick<Issue, "labels" | "state">): StatusLabel {
  return getEffectiveStatus(issue.labels, issue.state);
}

export function getIssuesByStatus<T extends Pick<Issue, "labels" | "state">>(issues: T[], status: StatusLabel): T[] {
  return issues.filter((issue) => getIssueStatus(issue) === status);
}
