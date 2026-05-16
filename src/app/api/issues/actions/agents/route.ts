import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseAgentList } from "@/lib/config";

/**
 * GET /api/issues/actions/agents
 * Returns the list of configured and discovered agent names.
 * - Configured agents come from the AGENTS env var (parseAgentList).
 * - Discovered agents come from unique agent/ labels on synced issues.
 * The combined set has no duplicates and is sorted alphabetically.
 */
export async function GET(request: Request) {
  try {
    // 1. Configured agents from env
    const configuredAgents = parseAgentList(process.env.AGENTS);

    // 2. Discovered agents from labels on synced issues
    const discoveredResult = await prisma.issue.findMany({
      select: { labels: true },
      where: { repository: { enabled: true } },
    });

    const discoveredSet = new Set<string>();
    for (const issue of discoveredResult) {
      for (const label of issue.labels) {
        if (label.startsWith("agent/")) {
          const name = label.replace("agent/", "");
          if (name) discoveredSet.add(name);
        }
      }
    }

    // Combine: configured first, then discovered (unique), sorted
    const allAgents = Array.from(
      new Set([...configuredAgents, ...Array.from(discoveredSet)])
    ).sort();

    return NextResponse.json({ agents: allAgents });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch agent list" },
      { status: 500 }
    );
  }
}
