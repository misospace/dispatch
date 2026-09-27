import { prisma } from "@/lib/prisma";
import {
  dependencyKey,
  formatDependencyBlockReason,
  parseIssueDependencies,
  resolveOpenBlockers,
} from "@/lib/issue-dependencies";

interface AnnotatableIssue {
  number: number;
  state: string;
  body?: string | null;
  repository: { fullName: string };
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
  const refsByIssue = issues.map((issue) =>
    issue.state === "open" ? parseIssueDependencies(issue.body) : [],
  );

  const referencedNumbers = new Set<number>();
  for (const refs of refsByIssue) {
    for (const ref of refs) referencedNumbers.add(ref.number);
  }

  const openIssueKeys = new Set<string>();
  if (referencedNumbers.size > 0) {
    const openIssues = await prisma.issue.findMany({
      where: {
        state: "open",
        repository: { enabled: true },
        number: { in: Array.from(referencedNumbers) },
      },
      select: { number: true, repository: { select: { fullName: true } } },
    });
    for (const open of openIssues) {
      openIssueKeys.add(dependencyKey(open.repository.fullName, open.number));
    }
  }

  return issues.map((issue, index) => {
    const refs = refsByIssue[index];
    if (refs.length === 0) return { ...issue, dependencyBlockReason: null };
    const repo = issue.repository.fullName;
    const blockers = resolveOpenBlockers(refs, openIssueKeys, repo, { repo, number: issue.number });
    return { ...issue, dependencyBlockReason: formatDependencyBlockReason(blockers, repo) || null };
  });
}
