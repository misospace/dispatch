import { AGENT_PREFIX, getAgentFromLabels } from "@/types";
import { removeIssueLabel } from "@/lib/github";
import { transitionIssueStatus } from "@/lib/issue-status";
import { fetchPullRequestState } from "@/lib/github-prs";

/** The issue fields needed by the shared claim-release policy. */
export interface IssueClaimRecord {
  id: string;
  state: string;
  labels: string[];
  blockedReason?: string | null;
  linkedPrNumber?: number | null;
}

export interface ReleaseIssueClaimOptions {
  /** Allow retries after a previous process removed the label successfully. */
  allowMissingAgent?: boolean;
  /** Release ownership only; preserve the current status label. */
  preserveStatus?: boolean;
}

export interface ReleaseIssueClaimResult {
  released: boolean;
  labels: string[];
  status: string | null;
  statusNote: string | null;
  skipReason?: string;
}

export interface IssueClaimClient {
  issue: {
    update: (args: any) => Promise<unknown>;
    findUnique?: (args: any) => Promise<any>;
  };
}

/**
 * Release an issue's agent claim and mirror the result in the local cache.
 *
 * The operator unclaim route and stale-work recovery use this same mutation
 * core. Stale recovery uses ownership-only mode so it never rewrites a status
 * label while recovering an abandoned claim.
 */
export async function releaseIssueClaim(params: {
  prisma: IssueClaimClient;
  issue: IssueClaimRecord;
  repoFullName: string;
  issueNumber: number;
  agentName: string;
  options?: ReleaseIssueClaimOptions;
}): Promise<ReleaseIssueClaimResult> {
  const { prisma, issue, repoFullName, issueNumber, agentName } = params;
  const options = params.options ?? {};
  const agentLabel = `${AGENT_PREFIX}${agentName}`;
  const currentAgent = getAgentFromLabels(issue.labels);

  // Never remove a newer agent's claim while an old AgentWork row is being
  // recovered. The stale-work caller can still retire the old local row.
  if (currentAgent && currentAgent !== agentLabel) {
    return {
      released: false,
      labels: issue.labels,
      status: issue.labels.find((label) => label.startsWith("status/")) ?? null,
      statusNote: null,
      skipReason: `agent claim belongs to ${currentAgent}`,
    };
  }

  if (!currentAgent) {
    if (!options.allowMissingAgent) {
      throw new Error(`Issue is not assigned to ${agentName}`);
    }

    // DELETE is idempotent in the GitHub adapter (404 means already gone), so
    // this repairs a cache that is behind GitHub without touching other labels.
    await removeIssueLabel(repoFullName, issueNumber, agentLabel);
    const latestIssue = prisma.issue.findUnique
      ? await prisma.issue.findUnique({ where: { id: issue.id }, select: { labels: true } })
      : null;
    const cacheLabels = latestIssue?.labels ?? issue.labels;
    await prisma.issue.update({
      where: { id: issue.id },
      data: { labels: cacheLabels, lastSyncedAt: new Date() },
    });
    return {
      released: true,
      labels: cacheLabels,
      status: cacheLabels.find((label: string) => label.startsWith("status/")) ?? null,
      statusNote: "agent claim already released: agent label is absent",
    };
  }

  let updatedLabels = issue.labels.filter((label) => label !== agentLabel);
  let statusNote: string | null = null;

  // Stale recovery intentionally changes ownership only. In particular, it
  // must not drag an in-review or blocked issue back into the ready column.
  if (options.preserveStatus) {
    await removeIssueLabel(repoFullName, issueNumber, agentLabel);
    const latestIssue = prisma.issue.findUnique
      ? await prisma.issue.findUnique({ where: { id: issue.id }, select: { labels: true } })
      : null;
    const cacheLabels = latestIssue?.labels?.filter((label: string) => label !== agentLabel) ?? updatedLabels;
    await prisma.issue.update({
      where: { id: issue.id },
      data: { labels: cacheLabels, lastSyncedAt: new Date() },
    });
    return {
      released: true,
      labels: cacheLabels,
      status: cacheLabels.find((label: string) => label.startsWith("status/")) ?? null,
      statusNote: null,
    };
  }

  // Keep the existing operator-unclaim resting-status policy centralized:
  // in-progress -> ready, unexplained blocked -> ready, deliberate blocked
  // stays blocked, and in-review stays in-review.
  if (updatedLabels.includes("status/in-progress")) {
    updatedLabels = await transitionIssueStatus(
      repoFullName,
      issueNumber,
      updatedLabels,
      "status/ready",
    );
  } else if (updatedLabels.includes("status/blocked")) {
    if (issue.blockedReason == null) {
      updatedLabels = await transitionIssueStatus(
        repoFullName,
        issueNumber,
        updatedLabels,
        "status/ready",
      );
    } else {
      statusNote =
        "status/blocked retained: blockedReason is set, so the block was a deliberate decision";
    }
  } else if (updatedLabels.includes("status/in-review")) {
    if (issue.linkedPrNumber != null) {
      const pr = await fetchPullRequestState(repoFullName, issue.linkedPrNumber);
      if (pr.state === "open") {
        statusNote = `status/in-review retained: linked PR #${issue.linkedPrNumber} is still open`;
      } else if (pr.state === null) {
        statusNote = `status/in-review retained: linked PR #${issue.linkedPrNumber} state is unknown`;
      } else {
        statusNote = `status/in-review retained: linked PR #${issue.linkedPrNumber} is no longer open; use set_issue_status to move the issue`;
      }
    } else {
      statusNote =
        "status/in-review retained: no linked PR recorded; use set_issue_status to move the issue";
    }
  }

  // Only targeted label writes reach GitHub here: the agent label is removed
  // directly and any status transition goes through transitionIssueStatus,
  // which itself uses add/remove primitives. Never replace the whole label
  // set — the cached row can be behind GitHub, and a full-set write would
  // silently revert every label change made on GitHub since the last sync.
  await removeIssueLabel(repoFullName, issueNumber, agentLabel);

  await prisma.issue.update({
    where: { id: issue.id },
    data: { labels: updatedLabels, lastSyncedAt: new Date() },
  });

  return {
    released: true,
    labels: updatedLabels,
    status: updatedLabels.find((label) => label.startsWith("status/")) ?? null,
    statusNote,
  };
}
