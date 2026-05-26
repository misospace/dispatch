import { AGENT_PREFIX, isAgentLabel, isOwnerLabel, OWNER_PREFIX } from "@/types";

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

export function toProjectLabel(project: string | null | undefined) {
  return project ? `project/${project}` : undefined;
}

export const LABEL_FILTER_HELP = {
  agent: `Agent filters use ${AGENT_PREFIX} labels on synced GitHub issues.`,
  owner: `Owner filters use ${OWNER_PREFIX} labels on synced GitHub issues.`,
};

// ---------------------------------------------------------------------------
// Centralized visible-issue filtering (Board, Issues API, Agent Queue)
// ---------------------------------------------------------------------------

export interface VisibleIssueWhereOptions {
  /** When true, return every issue regardless of state or age. */
  includeClosed?: boolean;
  /** Number of days to retain closed/Done issues. Defaults to 7. */
  doneRetentionDays?: number;
}

/**
 * Build a Prisma `where` clause that implements the visibility policy:
 * - Open issues are always visible.
 * - Closed/Done issues are visible within the retention window (default 7 days).
 * - `includeClosed=true` bypasses all state/age filters.
 */
export function buildVisibleIssueWhere(
  opts: VisibleIssueWhereOptions = {},
): Record<string, unknown> {
  const { includeClosed = false, doneRetentionDays = 7 } = opts;

  if (includeClosed) {
    // No state filter — let downstream grouping/sorting decide.
    return {};
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - doneRetentionDays);

  return {
    OR: [
      { state: "open" },
      {
        state: "closed",
        labels: { has: "status/done" },
        closedAt: { gte: cutoff },
      },
    ],
  };
}

/**
 * Derive the retention cutoff date for display / message text.
 */
export function getDoneRetentionCutoff(days = 7): Date {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
}
