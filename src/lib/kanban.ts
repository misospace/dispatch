import { Issue, StatusLabel, STATUS_LABELS } from "@/types";

export function getIssueStatus(issue: Pick<Issue, "labels" | "state">): StatusLabel {
  const explicitStatus = STATUS_LABELS.find((status) => issue.labels.includes(status));
  if (explicitStatus) return explicitStatus;
  return "status/backlog";
}

export function getIssuesByStatus<T extends Pick<Issue, "labels" | "state">>(issues: T[], status: StatusLabel): T[] {
  return issues.filter((issue) => getIssueStatus(issue) === status);
}
