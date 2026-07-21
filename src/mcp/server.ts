import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimIssue,
  claimWork,
  unclaimIssue,
  resolveAgentName,
  refreshIssue,
  syncRepo,
  resolveIssue,
  setIssueStatus,
  DispatchClientError,
} from "../lib/mc-client.js";

type ExtraArgs = Record<string, unknown>;

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * Shared tool-handler skeleton: run the client call, wrap the result as
 * pretty-printed JSON text, and translate DispatchClientError into the
 * standard error shape. Other errors are rethrown.
 */
async function wrapToolCall(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
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

export async function resolveIssueHandler(args: ExtraArgs): Promise<ToolResult> {
  return wrapToolCall(() =>
    resolveIssue(
      args.repoFullName as string,
      args.issueNumber as number,
    ),
  );
}

export async function claimIssueHandler(args: ExtraArgs): Promise<ToolResult> {
  const resolvedAgentName = resolveAgentName(args.agentName as string | undefined);

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

  return wrapToolCall(() =>
    claimIssue(
      args.repoFullName as string,
      args.issueNumber as number,
      resolvedAgentName,
      args.force as boolean | undefined,
    ),
  );
}

export async function unclaimIssueHandler(args: ExtraArgs): Promise<ToolResult> {
  const resolvedAgentName = resolveAgentName(args.agentName as string | undefined);

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

  return wrapToolCall(() =>
    unclaimIssue(
      args.repoFullName as string,
      args.issueNumber as number,
      resolvedAgentName,
    ),
  );
}

export async function setIssueStatusHandler(args: ExtraArgs): Promise<ToolResult> {
  return wrapToolCall(() =>
    setIssueStatus(
      args.repoFullName as string,
      args.issueNumber as number,
      args.status as string,
      args.agentName as string | undefined,
    ),
  );
}

export async function claimWorkHandler(args: ExtraArgs): Promise<ToolResult> {
  return wrapToolCall(() =>
    claimWork(
      args.repoFullName as string,
      args.issueNumber as number,
      args.agentName as string | undefined,
      {
        status: (args.status as string) ?? "in-progress",
        force: args.force as boolean | undefined,
        refreshBeforeClaim: args.refreshBeforeClaim as boolean | undefined,
      },
    ),
  );
}

export async function refreshIssueHandler(args: ExtraArgs): Promise<ToolResult> {
  return wrapToolCall(() =>
    refreshIssue(
      args.repoFullName as string,
      args.issueNumber as number,
    ),
  );
}

export async function syncRepoHandler(args: ExtraArgs): Promise<ToolResult> {
  return wrapToolCall(() =>
    syncRepo(
      args.repoFullName as string,
    ),
  );
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

  // ── unclaim_issue ────────────────────────────────────────────────────────

  server.registerTool(
    "unclaim_issue",
    {
      description:
        "Release an agent's claim on a Dispatch issue: removes the agent/* label, releases the lease (and AgentWork records on the operator path), and flips status/in-progress to status/ready — the issue keeps its groomed lane, so it is immediately re-claimable. Refuses closed/done issues and issues not assigned to the given agent. If agentName is omitted, falls back to DISPATCH_AGENT_NAME env var. Error if neither is set — do not use generic identities like 'Dispatch MCP'.",
      inputSchema: {
        repoFullName: z.string().describe("GitHub repo full name (e.g. 'org/repo')"),
        issueNumber: z.number().int().positive().describe("GitHub issue number"),
        agentName: z.string().optional().describe("Agent whose claim is being released. Falls back to DISPATCH_AGENT_NAME env var if omitted. Required unless DISPATCH_AGENT_NAME is set."),
      },
    },
    unclaimIssueHandler,
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
