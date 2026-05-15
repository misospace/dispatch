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
