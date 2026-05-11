import { prisma } from "@/lib/prisma";

export function parseRepoList(input: string | undefined): string[] {
  if (!input) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  const parts = input.split(/[,\n]/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    const [owner, repo] = trimmed.split("/");
    if (!owner || !repo || owner.includes(" ") || repo.includes(" ")) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

export function parseAgentList(input: string | undefined): string[] {
  if (!input) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  const parts = input.split(/[,\n]/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

export function isValidRepoName(fullName: string): boolean {
  const parts = fullName.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return Boolean(owner && repo && !owner.includes(" ") && !repo.includes(" "));
}

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
      create: { fullName, name: fullName.split("/")[1] || fullName, owner: fullName.split("/")[0] || fullName },
      update: {},
    });
  }

  return envRepos;
}