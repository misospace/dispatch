import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { authorizeRequest } from "@/lib/auth";

/**
 * GET /api/automation/repos/tracked
 *
 * Returns the list of tracked repositories that are currently enabled,
 * suitable for automation and audit consumers.
 *
 * Response shape:
 *   { fullName, owner, name, enabled, defaultBranch, source?, lastSyncedAt? }
 *
 * - `source` comes from the linked AutomationRepo row (e.g. "user", "env").
 * - `lastSyncedAt` is only present when an AutomationRepo row exists.
 */
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    const repos = await prisma.repository.findMany({
      where: { enabled: true },
      orderBy: { fullName: "asc" },
    });

    // Automations created both a Repository and an AutomationRepo row;
    // join on fullName to surface source metadata.
    const automationRepos = await prisma.automationRepo.findMany({
      select: {
        fullName: true,
        defaultBranch: true,
        source: true,
        lastSyncedAt: true,
      },
    });

    const automationMap = new Map(
      automationRepos.map((ar) => [ar.fullName, ar]),
    );

    const result = repos.map((repo) => {
      const automation = automationMap.get(repo.fullName);
      const defaultBranch = automation?.defaultBranch ?? "main";
      if (!automation && defaultBranch === "main") {
        console.warn(
          `Tracked repos: no AutomationRepo row for ${repo.fullName}, defaulting defaultBranch to "main" — verify this is correct`,
        );
      }
      return {
        fullName: repo.fullName,
        owner: repo.owner,
        name: repo.name,
        enabled: repo.enabled,
        defaultBranch,
        source: automation?.source ?? "unknown",
        lastSyncedAt: automation?.lastSyncedAt ?? null,
      };
    });

    return NextResponse.json(jsonSafe(result));
  } catch (error) {
    console.error("Failed to fetch tracked repos:", error);
    return errorResponse("Failed to fetch tracked repositories", 500);
  }
}
