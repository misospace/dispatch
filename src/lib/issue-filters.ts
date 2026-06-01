import { AGENT_PREFIX, isAgentLabel, isOwnerLabel, OWNER_PREFIX } from "@/types";

export interface VisibleIssueWhereOptions {
  includeClosed?: boolean;
  doneRetentionDays?: number;
}

export interface LabelFilterOptions {
  agents: string[];
  owners: string[];
}

export function discoverLabelFilterOptions(issues: { labels: string[] }[]): LabelFilterOptions {
  const agents = new Set<string>();
  const owners = new Set<string>();

  for (const issue of issues) {
    for (const label of issue.labels) {
      if (isAgentLabel(label)) agents.add(label);
      if (isOwnerLabel(label)) owners.add(label);
    }
  }

  return {
    agents: Array.from(agents).sort(),
    owners: Array.from(owners).sort(),
  };
}

export function buildLabelWhere(labels: Array<string | null | undefined>) {
  const selectedLabels = labels.filter((label): label is string => Boolean(label));

  if (selectedLabels.length === 0) return undefined;
  if (selectedLabels.length === 1) return { has: selectedLabels[0] };

  return { hasEvery: selectedLabels };
}

export function isIssueExcludedByLabels(issueLabels: string[], excludedLabels: string[]): boolean {
  if (excludedLabels.length === 0) return false;
  for (const label of issueLabels) {
    if (excludedLabels.includes(label)) return true;
  }
  return false;
}

export function buildExcludedLabelWhere(excludedLabels: string[]) {
  if (excludedLabels.length === 0) return undefined;
  return { hasNone: excludedLabels };
}

export function toProjectLabel(project: string | null | undefined) {
  return project ? `project/${project}` : undefined;
}

export const DEFAULT_DONE_RETENTION_DAYS = 7;

export function getDoneRetentionDays(): number {
  const parsed = parseInt(process.env.DISPATCH_DONE_RETENTION_DAYS ?? String(DEFAULT_DONE_RETENTION_DAYS), 10);
  return parsed > 0 ? parsed : DEFAULT_DONE_RETENTION_DAYS;
}

export function buildVisibleIssueWhere(where: Record<string, unknown>, options?: VisibleIssueWhereOptions): void {
  const { includeClosed = false, doneRetentionDays } = options ?? {};
  const retentionDays = doneRetentionDays ?? getDoneRetentionDays();

  if (includeClosed) {
    // Show all issues regardless of state or age — no state filter
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  where.OR = [
    { state: "open" },
    {
      state: "closed",
      labels: { has: "status/done" },
      closedAt: { gte: cutoff },
    },
  ];
}

export const LABEL_FILTER_HELP = {
  agent: `Agent filters use ${AGENT_PREFIX} labels on synced GitHub issues.`,
  owner: `Owner filters use ${OWNER_PREFIX} labels on synced GitHub issues.`,
};
