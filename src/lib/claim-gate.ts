import { fetchIssue } from "@/lib/github";

/**
 * #1037 decision-gate re-read: fetch the issue's *live* labels straight from
 * GitHub.
 *
 * Claim/assign/status decisions must be made against the labels GitHub
 * currently has, not the Prisma cache: a claim made directly on GitHub
 * (`agent/<name>`) is invisible in the cache until the next sync, and a
 * decision made on the stale cache lets another automation steal the issue.
 *
 * Callers must fail-closed when this throws (GitHub unreachable): no
 * decision can be made, and no label or cache writes may happen.
 */
export async function getLiveIssueLabels(
  repoFullName: string,
  issueNumber: number,
): Promise<string[]> {
  const issue = await fetchIssue(repoFullName, issueNumber);
  return issue.labels.map((label) => label.name);
}
