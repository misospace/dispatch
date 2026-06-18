import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimIssue,
  claimWork,
  resolveAgentName,
  refreshIssue,
  syncRepo,
  resolveIssue,
  setIssueStatus,
  DispatchClientError,
} from "../lib/mc-client.js";

type ExtraArgs = Record<string, unknown>;

function getArg(args: ExtraArgs, key: string): unknown {
  return args[key];
}

export async function resolveIssueHandler(args: ExtraArgs) {
  try {
    const result = await resolveIssue(
      getArg(args, "repoFullName") as string,
      getArg(args, "issueNumber") as number,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof DispatchClientError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
}

export async function claimIssueHandler(args: ExtraArgs) {
  try {
    const explicitAgentName = getArg(args, "agentName") as string | undefined;
    const resolvedAgentName = resolveAgentName(explicitAgentName);

    if (!resolvedAgentName) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "agentName is required. Either pass an explicit agentName argument or set the DISPATCH_AGENT_NAME environment variable. Do not use generic identities like 'Dispatch MCP'.",
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    const result = await claimIssue(
      getArg(args, "repoFullName") as string,
      getArg(args, "issueNumber") as number,
      resolvedAgentName,
      getArg(args, "force") as boolean | undefined,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof DispatchClientError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
}

export async function setIssueStatusHandler(args: ExtraArgs) {
  try {
    const result = await setIssueStatus(
      getArg(args, "repoFullName") as string,
      getArg(args, "issueNumber") as number,
      getArg(args, "status") as string,
      getArg(args, "agentName") as string | undefined,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof DispatchClientError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
}

export async function claimWorkHandler(args: ExtraArgs) {
  try {
    const explicitAgentName = getArg(args, "agentName") as string | undefined;
    const result = await claimWork(
      getArg(args, "repoFullName") as string,
      getArg(args, "issueNumber") as number,
      explicitAgentName,
      {
        status: (getArg(args, "status") as string) ?? "in-progress",
        force: getArg(args, "force") as boolean | undefined,
        refreshBeforeClaim: getArg(args, "refreshBeforeClaim") as boolean | undefined,
      },
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof DispatchClientError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
}

export async function refreshIssueHandler(args: ExtraArgs) {
  try {
    const result = await refreshIssue(
      getArg(args, "repoFullName") as string,
      getArg(args, "issueNumber") as number,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof DispatchClientError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
}

export async function syncRepoHandler(args: ExtraArgs) {
  try {
    const result = await syncRepo(
      getArg(args, "repoFullName") as string,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof DispatchClientError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
}

export function createServer(): McpServerType {
  const server = new McpServer(
    {
      name: "dispatch",
      version: "1.0.0",
    },
    {
      instructions:
        "Dispatch MCP bridge — claim and manage GitHub issues via the Dispatch API.",
    },
  );

  // ── resolve_issue ────────────────────────────────────────────────────────

  server.registerTool(
    "resolve_issue",
    {
      description:
        "Resolve a Dispatch issue by repo full name and issue number. Returns issue ID, title, URL, labels, status, and lane classification.",
      inputSchema: {
        repoFullName: z.string().describe("GitHub repo full name (e.g. 'org/repo')"),
        issueNumber: z.number().int().positive().describe("GitHub issue number"),
      },
    },
    resolveIssueHandler,
  );

  // ── claim_issue ──────────────────────────────────────────────────────────

  server.registerTool(
    "claim_issue",
    {
      description:
        "Claim a Dispatch issue for an agent. Adds the agent/* label on GitHub and in the local cache. Use force=true to override existing assignments. If agentName is omitted, falls back to DISPATCH_AGENT_NAME env var. Error if neither is set — do not use generic identities like 'Dispatch MCP'.",
      inputSchema: {
        repoFullName: z.string().describe("GitHub repo full name (e.g. 'org/repo')"),
        issueNumber: z.number().int().positive().describe("GitHub issue number"),
        agentName: z.string().optional().describe("Agent identifier claiming the issue. Falls back to DISPATCH_AGENT_NAME env var if omitted. Required unless DISPATCH_AGENT_NAME is set."),
        force: z
          .boolean()
          .optional()
          .describe("Force claim even if another agent is already assigned"),
      },
    },
    claimIssueHandler,
  );

  // ── set_issue_status ─────────────────────────────────────────────────────

  server.registerTool(
    "set_issue_status",
    {
      description:
        "Set the status label on a Dispatch issue (e.g. 'in-progress', 'in-review', 'done'). Transitions the status/ label on GitHub and in the local cache.",
      inputSchema: {
        repoFullName: z.string().describe("GitHub repo full name (e.g. 'org/repo')"),
        issueNumber: z.number().int().positive().describe("GitHub issue number"),
        status: z
          .string()
          .describe("Status label value: backlog, ready, in-progress, in-review, or done"),
        agentName: z
          .string()
          .optional()
          .describe("Agent name for audit trail (optional)"),
      },
    },
    setIssueStatusHandler,
  );

  // ── claim_work (convenience) ─────────────────────────────────────────────

  server.registerTool(
    "claim_work",
    {
      description:
        "Convenience tool that resolves, claims, and sets status on an issue in one call. Returns a compact task contract with issue context for the agent to work against. Automatically refreshes the issue from GitHub if not found in cache (refreshBeforeClaim defaults to true). If agentName is omitted, falls back to DISPATCH_AGENT_NAME env var. Error if neither is set — do not use generic identities like 'Dispatch MCP'.",
      inputSchema: {
        repoFullName: z.string().describe("GitHub repo full name (e.g. 'org/repo')"),
        issueNumber: z.number().int().positive().describe("GitHub issue number"),
        agentName: z.string().optional().describe("Agent identifier claiming the work. Falls back to DISPATCH_AGENT_NAME env var if omitted. Required unless DISPATCH_AGENT_NAME is set."),
        status: z
          .string()
          .optional()
          .describe("Status to set after claiming (default: 'in-progress')"),
        force: z
          .boolean()
          .optional()
          .describe("Force claim even if another agent is already assigned"),
        refreshBeforeClaim: z
          .boolean()
          .optional()
          .describe("Auto-refresh the issue from GitHub if not found in cache (default: true)"),
      },
    },
    claimWorkHandler,
  );

  // ── refresh_issue ────────────────────────────────────────────────────────

  server.registerTool(
    "refresh_issue",
    {
      description:
        "Refresh a single issue from GitHub and upsert it into the Dispatch cache. Useful for syncing newly-created issues before claiming them.",
      inputSchema: {
        repoFullName: z.string().describe("GitHub repo full name (e.g. 'org/repo')"),
        issueNumber: z.number().int().positive().describe("GitHub issue number"),
      },
    },
    refreshIssueHandler,
  );

  // ── sync_repo ────────────────────────────────────────────────────────────

  server.registerTool(
    "sync_repo",
    {
      description:
        "Sync all open issues for a specific tracked repository. Faster than a full sync when you only need one repo updated.",
      inputSchema: {
        repoFullName: z.string().describe("GitHub repo full name (e.g. 'org/repo')"),
      },
    },
    syncRepoHandler,
  );

  return server;
}

// ── Main entry point (stdio) ───────────────────────────────────────────────

/**
 * Logs a startup warning when DISPATCH_AGENT_NAME is unset.
 * Mirrors the DISPATCH_AUTH_MODE=disabled warning in docker-entrypoint.sh.
 * Tools that accept explicit agentName still work; this is a heads-up only.
 */
export function warnIfAgentNameUnset(): void {
  if (!process.env.DISPATCH_AGENT_NAME) {
    console.warn(
      "[MCP] DISPATCH_AGENT_NAME is not set. claim_issue and claim_work will " +
        "require an explicit agentName argument. Do not use generic identities " +
        "like 'Dispatch MCP'.",
    );
  }
}

async function main() {
  warnIfAgentNameUnset();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server stays alive via stdio event loop — no explicit keepalive needed.
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
