import { AGENT_PREFIX, isAgentLabel, isOwnerLabel, OWNER_PREFIX, STATUS_LABELS } from "@/types";

/**
 * Single source of truth for Renovate issue detection. Both the in-memory
 * predicate (`isRenovateIssue`) and the Prisma where clause
 * (`buildRenovateIssueExclusionWhere`) derive from these constants — keep
 * them in sync by editing only this definition.
 * Author detection is not available since the Issue model does not store author.
 */
export const RENOVATE_LABELS = ["renovate", "dependencies", "automated"] as const;

/** Case-insensitive title substrings that identify Renovate dashboard issues. */
export const RENOVATE_TITLE_SUBSTRINGS = ["dependency dashboard", "renovate dashboard"] as const;

/**
 * Case-insensitive title prefixes that identify Renovate update issues.
 * "update dep" covers "update dep...", "update deps...", and "update dependency...".
 */
export const RENOVATE_TITLE_PREFIXES = ["update dep", "update image"] as const;

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
  return { NOT: { labels: { hasSome: excludedLabels } } };
}

/**
 * Build a Prisma where clause that matches issues with no status/* label.
 * Used for grooming intake — surfaces untriaged open issues.
 */
export function buildNoStatusWhere(includeUntriaged: boolean) {
  if (!includeUntriaged) return undefined;
  return { NOT: { labels: { hasSome: STATUS_LABELS } } };
}

export function toProjectLabel(project: string | null | undefined) {
  return project ? `project/${project}` : undefined;
}

export function appendIssueWhere(where: Record<string, unknown>, clause: Record<string, unknown> | undefined): void {
  if (!clause) return;

  const existing = where.AND;
  if (Array.isArray(existing)) {
    existing.push(clause);
  } else if (existing) {
    where.AND = [existing, clause];
  } else {
    where.AND = [clause];
  }
}

/**
 * Detect Renovate issues by the shared title/label criteria above.
 * This is the in-memory counterpart of `buildRenovateIssueExclusionWhere`.
 */
export function isRenovateIssue(issue: { title: string; labels: string[] }): boolean {
  const title = issue.title.toLowerCase();

  if (RENOVATE_TITLE_SUBSTRINGS.some((substring) => title.includes(substring))) return true;
  if (RENOVATE_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) return true;

  const labels = issue.labels.map((l) => l.toLowerCase());
  return labels.some((label) => (RENOVATE_LABELS as readonly string[]).includes(label));
}

/**
 * Build a Prisma where clause excluding Renovate issues, derived from the
 * same criteria as `isRenovateIssue`. Note: label matching via `hasSome` is
 * case-sensitive (Prisma scalar-list limitation), so mixed-case labels are
 * only caught by the in-memory predicate.
 */
export function buildRenovateIssueExclusionWhere() {
  return {
    NOT: {
      OR: [
        { labels: { hasSome: [...RENOVATE_LABELS] } },
        ...RENOVATE_TITLE_SUBSTRINGS.map((substring) => ({
          title: { contains: substring, mode: "insensitive" },
        })),
        ...RENOVATE_TITLE_PREFIXES.map((prefix) => ({
          title: { startsWith: prefix, mode: "insensitive" },
        })),
      ],
    },
  };
}

export function applyRenovateIssueExclusion(where: Record<string, unknown>): void {
  appendIssueWhere(where, buildRenovateIssueExclusionWhere());
}

/**
 * Build a Prisma where clause that excludes umbrella issues (issues with the
 * "umbrella" label or titles starting with "Weekly tech debt audit:").
 */
export function buildUmbrellaIssueExclusionWhere() {
  return {
    NOT: {
      OR: [
        { labels: { has: "umbrella" } },
        { title: { startsWith: "Weekly tech debt audit:", mode: "insensitive" } },
      ],
    },
  };
}

export function applyUmbrellaIssueExclusion(where: Record<string, unknown>): void {
  appendIssueWhere(where, buildUmbrellaIssueExclusionWhere());
}

/**
 * Build a Prisma where clause that excludes issues already groomed within the
 * given cooldown (default 24h) or currently blocked/not-ready.
 */
export function buildGroomingStateExclusionWhere(cooldownHours: number = 24) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - cooldownHours);

  // A deferral expires. notReadyReason used to exclude an issue from grooming
  // permanently, which made a single sentence irreversible — and the groomer
  // writes that sentence itself. Four issues were parked indefinitely by
  // reasons like "Explicitly deferred by maintainer", "Kept in backlog per
  // audit decision" and "awaiting maintainer clarification", none of which
  // any maintainer said. After the TTL the issue is groomed again and can be
  // re-deferred on its merits, so a wrong call costs one cycle, not forever.
  const deferralCutoff = new Date();
  deferralCutoff.setDate(deferralCutoff.getDate() - getDeferralTtlDays());

  return {
    AND: [
      // Not recently groomed (or never groomed)
      { OR: [{ groomedAt: null }, { groomedAt: { lt: cutoff } }] },
      // Not currently blocked
      { blockedReason: null },
      // Not currently marked not-ready, unless the deferral has aged out
      { OR: [{ notReadyReason: null }, { groomedAt: { lt: deferralCutoff } }] },
    ],
  };
}

export const DEFAULT_DEFERRAL_TTL_DAYS = 14;

/** How long a not-ready deferral suppresses grooming before it is revisited. */
export function getDeferralTtlDays(): number {
  const parsed = parseInt(
    process.env.DISPATCH_DEFERRAL_TTL_DAYS ?? String(DEFAULT_DEFERRAL_TTL_DAYS),
    10,
  );
  return parsed > 0 ? parsed : DEFAULT_DEFERRAL_TTL_DAYS;
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
