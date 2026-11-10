import { Issue, StatusLabel, getEffectiveStatus } from "@/types";

export function getIssueStatus(issue: Pick<Issue, "labels" | "state">): StatusLabel {
  return getEffectiveStatus(issue.labels, issue.state);
}

export function getIssuesByStatus<T extends Pick<Issue, "labels" | "state">>(issues: T[], status: StatusLabel): T[] {
  return issues.filter((issue) => getIssueStatus(issue) === status);
}

/**
 * An issue is un-routable (#1590) when the board query annotated its
 * `currentLane` as neither configured nor alias-resolvable. The annotation is
 * computed server-side by `withUnroutableLaneAnnotations`; these helpers only
 * split the already-annotated list for display.
 */
export function isUnroutableLaneIssue(issue: Pick<Issue, "unroutableLane">): boolean {
  return issue.unroutableLane != null;
}

export function getUnroutableLaneIssues<T extends Pick<Issue, "unroutableLane">>(issues: T[]): T[] {
  return issues.filter(isUnroutableLaneIssue);
}

export function excludeUnroutableLaneIssues<T extends Pick<Issue, "unroutableLane">>(issues: T[]): T[] {
  return issues.filter((issue) => !isUnroutableLaneIssue(issue));
}
