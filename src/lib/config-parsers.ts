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
