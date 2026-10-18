import { prMergeTimestamp, recordPrMergedEvent } from "./issue-lifecycle";
import type { LifecycleEventClient } from "./issue-lifecycle";

/**
 * Bounded, idempotent backfill of `pr_merged` lifecycle events (#1203).
 *
 * Older issues predate the lifecycle stream, so their merges were never
 * recorded — only their merge evidence still exists: a worker `AgentRun`
 * attached to the issue whose `touchedIssueUrls` name a PR, and that PR's
 * authoritative GitHub merge timestamp already persisted in Dispatch
 * (`GithubPullRequest.mergedAt`). This backfill derives the event solely from
 * those two records, one issue at a time:
 *
 * - It never fabricates claim events or first-claim times. The merge time is
 *   GitHub's own `mergedAt`; the run's `startedAt` and the issue's
 *   `createdAt` are never read, so nothing here can be mistaken for when the
 *   work was claimed.
 * - A PR without an authoritative `mergedAt` (closed-unmerged, or an
 *   unparseable value) is skipped — merge evidence is never inferred from a
 *   merge state alone.
 * - The correlation matches a run's touched URL to a PR row either exactly
 *   (whitespace-trimmed, trailing `/` treated as equal) or as the same PR in
 *   the other URL shape: workers report `github.com/.../pull/N`, the sync
 *   persists `api.github.com/repos/.../pulls/N`.
 * - Every write goes through `recordPrMergedEvent`, whose dedupe key is the
 *   canonical merge identity shared with the reconciler and sync observers,
 *   so re-running the backfill over the same records upserts onto the rows
 *   that already exist instead of duplicating them.
 *
 * A client failure propagates to the caller; this module never swallows one.
 */

export interface BackfillPullRequestRecord {
  number: number;
  url: string;
  mergedAt: Date | string | null;
}

export interface BackfillAgentRunRecord {
  touchedIssueUrls: readonly string[];
}

export interface BackfillResult {
  /** Distinct merged PRs recorded this call. */
  recorded: number;
  /** Touched PRs that carry no authoritative `mergedAt`. */
  skippedUnmerged: number;
  /** Merged PRs of the repo no run of this issue ever touched. */
  skippedNoLink: number;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/[?#].*$/, "");
}

/**
 * Parse a GitHub PR URL in either shape a record in this database can carry:
 * the html form a worker reports in `AgentRun.touchedIssueUrls`
 * (https://github.com/owner/repo/pull/N) and the API form persisted by the
 * automation sync into `GithubPullRequest.url`
 * (https://api.github.com/repos/owner/repo/pulls/N). Repo comparison is
 * case-insensitive, as on GitHub itself.
 */
export function parsePullRequestReference(url: string): { repo: string; number: number } | null {
  const match = normalizeUrl(url).match(
    /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+)\/([^/]+)\/(?:pulls|pull)\/(\d+)$/i,
  );
  if (!match) return null;
  return { repo: `${match[1]}/${match[2]}`, number: Number.parseInt(match[3], 10) };
}

/** Canonical html URL for a PR of this repo, used as recorded provenance. */
export function pullRequestHtmlUrl(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}

export async function backfillMergesFromRunHistory(
  client: LifecycleEventClient,
  input: {
    issueId: string;
    repoFullName: string;
    issueNumber: number;
    agentRuns: readonly BackfillAgentRunRecord[];
    /** Merged-or-not PR rows for the repo. */
    pullRequests: readonly BackfillPullRequestRecord[];
    actor?: string;
  },
): Promise<BackfillResult> {
  const actor = input.actor ?? "lifecycle-backfill";

  const touchedUrls = new Set<string>();
  const touchedPrRefs = new Set<string>();
  for (const run of input.agentRuns) {
    for (const url of run.touchedIssueUrls) {
      touchedUrls.add(normalizeUrl(url));
      const ref = parsePullRequestReference(url);
      if (ref) touchedPrRefs.add(`${ref.repo.toLowerCase()}#${ref.number}`);
    }
  }

  const result: BackfillResult = { recorded: 0, skippedUnmerged: 0, skippedNoLink: 0 };
  const seenPrNumbers = new Set<number>();

  // Deterministic order: ascending PR number, one pass per distinct PR, so a
  // PR touched by several runs records exactly one event.
  for (const pr of [...input.pullRequests].sort((a, b) => a.number - b.number)) {
    if (seenPrNumbers.has(pr.number)) continue;
    seenPrNumbers.add(pr.number);

    const mergedAtIso = prMergeTimestamp(pr.mergedAt);
    // A touched URL matches a PR row either exactly, or as the same PR in the
    // other URL shape (workers report html URLs; the sync persists API URLs).
    const prRef = parsePullRequestReference(pr.url);
    const rowRepoKey = `${(prRef?.repo ?? input.repoFullName).toLowerCase()}#${pr.number}`;
    const touched = touchedUrls.has(normalizeUrl(pr.url)) || touchedPrRefs.has(rowRepoKey);

    if (!touched) {
      // Only a merged PR that the issue's runs never name is a "no link"
      // skip; a closed-unmerged PR is simply not merge evidence at all.
      if (mergedAtIso !== null) result.skippedNoLink += 1;
      continue;
    }

    if (mergedAtIso === null) {
      result.skippedUnmerged += 1;
      continue;
    }

    await recordPrMergedEvent(client, {
      issueId: input.issueId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      source: "backfill",
      actor,
      pr: {
        prNumber: pr.number,
        // Record the canonical html URL, not the stored API-form URL, so the
        // event's provenance is the link a human or reader can follow.
        prUrl: pullRequestHtmlUrl(input.repoFullName, pr.number),
        mergedAt: pr.mergedAt,
        linkSource: "agent-run-touch",
      },
      extraMetadata: {
        backfilled: true,
        mergeTimeSource: "github-pull-request-sync",
      },
    });
    result.recorded += 1;
  }

  return result;
}
