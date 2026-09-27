import { prisma } from "@/lib/prisma";
import {
  dependencyKey,
  formatDependencyBlockReason,
  parseIssueDependencies,
  parseNativeBlockedBy,
  mergeDependencyRefs,
  resolveOpenBlockers,
} from "@/lib/issue-dependencies";

interface AnnotatableIssue {
  number: number;
  state: string;
  body?: string | null;
  nativeBlockedBy?: string[] | null;
  repository: { fullName: string };
}

/**
 * Keys (`owner/repo#N`) of the open issues, in enabled repos, among the given
 * issue numbers: the universe the agent queue gates dependencies on. One
 * query, skipped entirely when no number is given.
 */
export async function findOpenIssueKeys(numbers: number[], client: typeof prisma = prisma): Promise<Set<string>> {
  const openIssueKeys = new Set<string>();
  if (numbers.length === 0) return openIssueKeys;
  const openIssues = await client.issue.findMany({
    where: {
      state: "open",
      repository: { enabled: true },
      number: { in: [...new Set(numbers)] },
    },
    select: { number: true, repository: { select: { fullName: true } } },
  });
  for (const open of openIssues) {
    openIssueKeys.add(dependencyKey(open.repository.fullName, open.number));
  }
  return openIssueKeys;
}

/**
 * Attach `dependencyBlockReason` to each issue, resolving blockers against the
 * same universe the agent queue gates on (every open issue in an enabled repo),
 * NOT against the caller's filtered list. A board filtered to one repo, agent,
 * lane or status therefore still reports a blocker the filter hides, so the
 * card agrees with the queue.
 *
 * Only open issues are annotated (the queue only considers open issues); closed
 * issues and issues without dependency refs get `null`. The open-issue lookup
 * runs only when some issue declares a ref, and is narrowed to the referenced
 * issue numbers.
 */
export async function withDependencyBlockReasons<T extends AnnotatableIssue>(
  issues: T[],
): Promise<Array<T & { dependencyBlockReason: string | null }>> {
  const refsByIssue = issues.map((issue) => {
    if (issue.state !== "open") return [];
    const bodyRefs = parseIssueDependencies(issue.body);
    const nativeKeys = issue.nativeBlockedBy;
    if (!nativeKeys || nativeKeys.length === 0) return bodyRefs;
    // `repository` is only needed to resolve native refs; keep it unaccessed for
    // issues with no native keys, matching the prior lazy contract.
    return mergeDependencyRefs(
      parseNativeBlockedBy(nativeKeys, issue.repository.fullName),
      bodyRefs,
    );
  });

  const referencedNumbers = new Set<number>();
  for (const refs of refsByIssue) {
    for (const ref of refs) referencedNumbers.add(ref.number);
  }

  const openIssueKeys = await findOpenIssueKeys(Array.from(referencedNumbers));

  return issues.map((issue, index) => {
    const refs = refsByIssue[index];
    if (refs.length === 0) return { ...issue, dependencyBlockReason: null };
    const repo = issue.repository.fullName;
    const blockers = resolveOpenBlockers(refs, openIssueKeys, repo, { repo, number: issue.number });
    return { ...issue, dependencyBlockReason: formatDependencyBlockReason(blockers, repo) || null };
  });
}
