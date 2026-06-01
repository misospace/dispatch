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
    const parts = trimmed.split("/");
    if (parts.length !== 2) continue;
    const [owner, repo] = parts;
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

export function parseExcludedLabels(input: string | undefined): string[] {
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
