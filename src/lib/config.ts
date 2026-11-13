import { prisma } from "@/lib/prisma";
import { isValidRepoName, parseRepoList } from "@/lib/config-parsers";

// The pure env parsers live in the Prisma-free `@/lib/config-parsers` so that
// client-reachable modules (issue-filters via the filter bar) can use them
// without pulling `@/lib/prisma` into the browser bundle. Re-exported here for
// the existing server-side callers.
export {
  isValidRepoName,
  parseAgentList,
  parseDelimitedList,
  parseExcludedLabels,
  parseRepoList,
} from "@/lib/config-parsers";

export async function getTrackedRepos(): Promise<string[]> {
  const dbRepos = await prisma.automationRepo.findMany({
    select: { fullName: true },
    orderBy: { fullName: "asc" },
  });

  if (dbRepos.length > 0) {
    return dbRepos.map((r) => r.fullName);
  }

  const envRepos = parseRepoList(process.env.GITHUB_REPOSITORIES);
  for (const fullName of envRepos) {
    await prisma.automationRepo.upsert({
      where: { fullName },
      create: {
        fullName,
        name: fullName.split("/")[1] || fullName,
        owner: fullName.split("/")[0] || fullName,
        source: "env",
      },
      update: {},
    });
  }

  return envRepos;
}

export async function getSyncRepos(): Promise<{ id: string; fullName: string }[]> {
  const trackedRepos = await getTrackedRepos();
  const results: { id: string; fullName: string }[] = [];

  for (const fullName of trackedRepos) {
    if (!isValidRepoName(fullName)) continue;

    const [owner, name] = fullName.split("/");
    const repo = await prisma.repository.upsert({
      where: { fullName },
      create: { fullName, owner, name, enabled: true },
      update: { owner, name, enabled: true },
      select: { id: true, fullName: true },
    });
    results.push(repo);
  }

  return results;
}
