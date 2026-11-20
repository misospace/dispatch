/**
 * Pure parsers for delimited environment configuration values.
 *
 * Split out of src/lib/config.ts (which re-exports them for existing
 * callers) because config.ts owns database access via `@/lib/prisma`, and
 * modules reachable from the client bundle — e.g. `@/lib/issue-filters`
 * through the `"use client"` filter bar — must stay Prisma-free so pg and
 * Node builtins (`fs`, `net`, `tls`, …) never enter the browser graph.
 * This module must never import anything with database or Node-only
 * dependencies.
 */

/**
 * Parse a comma/newline-delimited list into trimmed, deduped entries
 * (order preserved). Shared by the agent, excluded-label, repo, and Courier
 * admission-namespace parsers (#1537).
 */
export function parseDelimitedList(input: string | undefined): string[] {
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

export function parseRepoList(input: string | undefined): string[] {
  return parseDelimitedList(input).filter(isValidRepoName);
}

export function parseAgentList(input: string | undefined): string[] {
  return parseDelimitedList(input);
}

export function isValidRepoName(fullName: string): boolean {
  const parts = fullName.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return Boolean(owner && repo && !owner.includes(" ") && !repo.includes(" "));
}

export function parseExcludedLabels(input: string | undefined): string[] {
  return parseDelimitedList(input);
}

/**
 * One operator-configured follow-up identity scope (#1665).
 *
 * A shared automation identity can open PRs for several unrelated workflows,
 * so an operator may narrow automatic PR follow-up for THAT login to PRs whose
 * head branch starts with one of these prefixes (and whose head repository is
 * the base repository — enforced by the ingestion gate). The login and the
 * prefixes are operator configuration; Dispatch never assumes which agent or
 * tool created a PR, and ships no default scopes.
 */
export interface FollowupIdentityScope {
  /** The GitHub login the scope narrows (compared as configured). */
  login: string;
  /** Head-branch prefixes that qualify a PR for automatic follow-up. */
  branchPrefixes: string[];
}

/**
 * Parse `PR_FOLLOWUP_BOT_IDENTITY_SCOPES` (#1665): a JSON object mapping a
 * GitHub login to its head-branch prefixes, e.g.
 * `{"renovate[bot]": ["renovate/"]}`. A bare string prefix is tolerated as a
 * one-element list. Entries are trimmed, empty prefixes dropped, prefix
 * duplicates removed (order preserved); the first entry for a login wins.
 *
 * Fail closed: an unparsable or non-object value yields no scopes at all, so
 * a login configured ONLY here is simply unconfigured (no automatic
 * follow-up for it) rather than silently unscoped. An entry whose prefixes
 * all end up empty is kept as a match-nothing scope — the literal reading of
 * "no branch qualifies", never a silent widening back to unscoped.
 */
export function parseFollowupIdentityScopes(input: string | undefined): FollowupIdentityScope[] {
  if (!input || !input.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const scopes: FollowupIdentityScope[] = [];
  const seenLogins = new Set<string>();
  for (const [rawLogin, rawPrefixes] of Object.entries(parsed as Record<string, unknown>)) {
    const login = rawLogin.trim();
    if (!login || seenLogins.has(login)) continue;
    const candidates = Array.isArray(rawPrefixes) ? rawPrefixes : [rawPrefixes];
    const prefixes: string[] = [];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const prefix = candidate.trim();
      if (prefix && !prefixes.includes(prefix)) prefixes.push(prefix);
    }
    seenLogins.add(login);
    scopes.push({ login, branchPrefixes: prefixes });
  }
  return scopes;
}
