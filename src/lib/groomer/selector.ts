import { prisma } from "@/lib/prisma";
import { isBacklogLane, getBacklogLane } from "@/lib/lane-config";
import {
  applyRenovateIssueExclusion,
  applyUmbrellaIssueExclusion,
  buildGroomingStateExclusionWhere,
  isRenovateIssue,
} from "@/lib/issue-filters";

export interface GroomingCandidate {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  repoFullName: string;
  labels: string[];
  currentLane: string | null;
}

export interface SelectGroomingCandidateOptions {
  repoFullName?: string;
  issueNumber?: number;
}

export async function selectGroomingCandidate(
  options: SelectGroomingCandidateOptions = {},
): Promise<GroomingCandidate | null> {
  const issueWhere: Record<string, unknown> = {
    state: "open",
    NOT: { labels: { has: "status/done" } },
    repository: { enabled: true },
  };

  if (options.issueNumber !== undefined) {
    issueWhere.number = options.issueNumber;
  }
  if (options.repoFullName) {
    issueWhere.repository = { enabled: true, fullName: options.repoFullName };
  }
  applyRenovateIssueExclusion(issueWhere);
  applyUmbrellaIssueExclusion(issueWhere);

  const groomingStateWhere = buildGroomingStateExclusionWhere(24);
  if (groomingStateWhere.AND) {
    const existing = issueWhere.AND;
    if (Array.isArray(existing)) {
      existing.push(...groomingStateWhere.AND);
    } else if (existing) {
      issueWhere.AND = [existing, ...groomingStateWhere.AND];
    } else {
      issueWhere.AND = groomingStateWhere.AND;
    }
  }

  const issues = await prisma.issue.findMany({
    where: issueWhere,
    select: {
      id: true,
      number: true,
      title: true,
      body: true,
      url: true,
      labels: true,
      currentLane: true,
      repository: { select: { fullName: true } },
    },
    orderBy: { number: "asc" },
  });

  const candidates = issues
    .filter((issue) => !isRenovateIssue(issue))
    .map((issue) => {
      const hasStatus = issue.labels.some((l) => l.startsWith("status/"));
      const hasPriority = issue.labels.some((l) => l.startsWith("priority/"));
      const hasAgent = issue.labels.some((l) => l.startsWith("agent/"));
      const hasLane = !!issue.currentLane;
      const isBacklogLaneValue = issue.currentLane ? isBacklogLane(issue.currentLane) : false;
      const isBacklog = isBacklogLaneValue || issue.labels.includes("status/backlog");
      const isUnlabeled = issue.labels.length === 0;

      const eligible =
        isUnlabeled || !hasStatus || !hasPriority || !hasAgent || !hasLane || isBacklog;

      let score = 0;
      if (isUnlabeled) score += 1000;
      if (!hasStatus) score += 500;
      if (!hasPriority) score += 250;
      if (isBacklog) score += 100;
      if (!hasAgent) score += 50;
      if (!hasLane && !isBacklog) score += 25;

      return { issue, eligible, score };
    })
    .filter((c) => c.eligible)
    .sort((a, b) => b.score - a.score || a.issue.number - b.issue.number);

  if (candidates.length === 0) {
    return null;
  }

  const best = candidates[0].issue;
  return {
    id: best.id,
    number: best.number,
    title: best.title,
    body: best.body,
    url: best.url,
    repoFullName: best.repository.fullName,
    labels: best.labels,
    currentLane: best.currentLane ?? getBacklogLane()?.id ?? "backlog",
  };
}
