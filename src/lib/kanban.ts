import { Issue, StatusLabel, STATUS_LABELS } from "@/types";

export function getIssueStatus(issue: Pick<Issue, "labels">): StatusLabel {
  return STATUS_LABELS.find((status) => issue.labels.includes(status)) ?? "status/backlog";
}

export function getIssuesByStatus<T extends Pick<Issue, "labels">>(issues: T[], status: StatusLabel): T[] {
  return issues.filter((issue) => getIssueStatus(issue) === status);
}
