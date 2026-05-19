# Dispatch MCP Bridge

Local stdio MCP server that bridges OpenCode to Dispatch issue APIs.

## Prerequisites

- Node.js 18+ (the repo ships with Node 24)
- A running Dispatch instance
- `DISPATCH_URL` and `DISPATCH_AGENT_TOKEN` set in your environment

## Installation

No additional packages are needed — the MCP server lives in the Dispatch repo and uses the existing dependencies:

```bash
npm ci
npx prisma generate
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISPATCH_URL` | Yes | Base URL of your Dispatch instance (e.g. `http://localhost:3000` or `https://dispatch.example.com`) |
| `DISPATCH_AGENT_TOKEN` | Yes | Bearer token for agent API authentication |

The token is **never** printed or logged. Missing variables produce a clear error on startup.

## Running the Server

```bash
npm run mcp:stdio
```

This starts a stdio MCP server that listens for tool calls from the OpenCode MCP client. The process stays alive via the stdio event loop — no explicit keepalive is needed.

## OpenCode MCP Configuration

Add the following to your OpenCode configuration (e.g. `.opencode.json` or `opencode.jsonc`):

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "npx",
      "args": ["tsx", "./src/mcp/server.ts"],
      "env": {
        "DISPATCH_URL": "http://localhost:3000",
        "DISPATCH_AGENT_TOKEN": "your-agent-token-here"
      }
    }
  }
}
```

Or if you have the repo cloned locally and want to use an absolute path:

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/dispatch/src/mcp/server.ts"],
      "env": {
        "DISPATCH_URL": "https://dispatch.example.com",
        "DISPATCH_AGENT_TOKEN": "$DISPATCH_AGENT_TOKEN"
      }
    }
  }
}
```

### Using with environment variable expansion

If your OpenCode config supports env var interpolation (e.g. `$VAR`), you can reference the token from your shell environment:

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "npx",
      "args": ["tsx", "./src/mcp/server.ts"],
      "env": {
        "DISPATCH_URL": "https://dispatch.example.com",
        "DISPATCH_AGENT_TOKEN": "$DISPATCH_AGENT_TOKEN"
      }
    }
  }
}
```

## Available Tools

### `resolve_issue`

Resolve a Dispatch issue by repo full name and issue number.

**Inputs:**
- `repoFullName` (string) — GitHub repo full name (e.g. `'org/repo'`)
- `issueNumber` (number) — GitHub issue number

**Returns:** `issueId`, `repoFullName`, `issueNumber`, `title`, `url`, `labels`, `status`, `lane`

### `claim_issue`

Claim a Dispatch issue for an agent. Adds the `agent/*` label on GitHub and in the local cache.

**Inputs:**
- `repoFullName` (string) — GitHub repo full name
- `issueNumber` (number) — GitHub issue number
- `agentName` (string) — Agent identifier to claim the issue
- `force` (boolean, optional) — Force claim even if another agent is already assigned

**Returns:** `success`, `labels`

### `set_issue_status`

Set the status label on a Dispatch issue (e.g. `'in-progress'`, `'in-review'`, `'done'`).

**Inputs:**
- `repoFullName` (string) — GitHub repo full name
- `issueNumber` (number) — GitHub issue number
- `status` (string) — Status label value: `backlog`, `in-progress`, `in-review`, or `done`
- `agentName` (string, optional) — Agent name for audit trail

**Returns:** `success`, `status`, `labels`

### `claim_work` (convenience)

Resolves, claims, and sets status on an issue in one call. Returns a compact task contract with issue context.

**Inputs:**
- `repoFullName` (string) — GitHub repo full name
- `issueNumber` (number) — GitHub issue number
- `agentName` (string) — Agent identifier claiming the work
- `status` (string, optional) — Status to set after claiming (default: `'in-progress'`)
- `force` (boolean, optional) — Force claim even if another agent is already assigned
- `refreshBeforeClaim` (boolean, optional) — Auto-refresh the issue from GitHub if not found in cache (default: `true`)

**Returns:** `issueId`, `repoFullName`, `issueNumber`, `title`, `url`, `labels`, `lane`, `status`, `taskContract`

The `taskContract` field contains a structured prompt telling the agent to work only on this issue. If `refreshBeforeClaim` is enabled (default) and the issue was not in the cache, the task contract includes a note about the refresh.

**Auto-refresh behavior:** When `refreshBeforeClaim` is `true` (the default), if `resolveIssue` fails because the issue is not in the Dispatch cache, the tool automatically calls `refreshIssue` to fetch the issue from GitHub before retrying. This allows agents to claim newly-created GitHub issues without requiring a manual sync first. Set `refreshBeforeClaim: false` to disable this behavior.

### `refresh_issue`

Refreshes a single issue from GitHub and upserts it into the Dispatch cache. Useful for syncing newly-created issues before claiming them.

**Inputs:**
- `repoFullName` (string) — GitHub repo full name
- `issueNumber` (number) — GitHub issue number

**Returns:** `success`, `repo`, `issueNumber`, `action` (`"created"` or `"updated"`), `error`

### `sync_repo`

Syncs all open issues for a specific tracked repository. Faster than a full sync when you only need one repo updated.

**Inputs:**
- `repoFullName` (string) — GitHub repo full name

**Returns:** `success`, `repos`, `syncedCount`, `results` (array of per-repo sync results)

## Example Usage in OpenCode

Natural language request:

> Claim and work issue #103 in misospace/dispatch.

OpenCode will:
1. Call `claim_work` with `repoFullName: "misospace/dispatch"`, `issueNumber: 103`, `agentName: "<your-agent-id>"`
2. Receive the task contract with issue context
3. Work on the issue following the contract

### Handling newly-created issues

When a GitHub issue is created but not yet synced to Dispatch, `claim_work` automatically refreshes it before claiming (since `refreshBeforeClaim` defaults to `true`). This means agents can claim freshly-created issues without any manual sync step.

If auto-refresh is not desired (e.g., for performance-critical flows), set `refreshBeforeClaim: false`:

> Claim issue #103 in misospace/dispatch but don't refresh first.

## Security

- The `DISPATCH_AGENT_TOKEN` is used for bearer auth on all mutating API calls.
- The token is **never** printed, echoed, or persisted to disk by the MCP server.
- Missing environment variables produce a clear error message at startup.
- All tools that mutate state (claim, set status, claim_work) require valid bearer authentication.

## Testing

Run the test suite:

```bash
npm run test
```

Tests cover:
- `src/lib/mc-client.test.ts` — HTTP client: config validation, resolve, claim, set status, claim work (with refreshBeforeClaim), refreshIssue, syncRepo, error handling
- `src/mcp/server.test.ts` — MCP tool handlers: input/output shapes, error propagation, task contract generation, refresh_issue, sync_repo tools

## Troubleshooting

### "DISPATCH_URL is not set"

Set the environment variable before starting OpenCode or the MCP server:

```bash
export DISPATCH_URL="http://localhost:3000"
export DISPATCH_AGENT_TOKEN="your-token-here"
```

Or add it to your OpenCode MCP config `env` block (see configuration above).

### "DISPATCH_AGENT_TOKEN is not set"

Same as above — ensure the token is set. Verify your Dispatch instance has an agent token configured.

### "Issue #N not found in org/repo"

With `refreshBeforeClaim: true` (default), `claim_work` automatically refreshes the issue from GitHub before failing. If you still see this error:

1. Verify the repo is tracked (check `/api/repos` or the UI)
2. Confirm the issue number and repo full name are correct
3. Try calling `refresh_issue` manually to diagnose the issue
4. If the issue exists on GitHub but refresh fails, check your `GITHUB_TOKEN` permissions

To disable auto-refresh and get immediate errors, set `refreshBeforeClaim: false`.

### Token not logged — how to verify it's set?

The server will throw a descriptive `McClientError` if the token is missing. If you're getting 401 responses from the Dispatch API, verify:
1. The token in your env matches the one configured in Dispatch
2. The token hasn't been rotated or expired
3. The `DISPATCH_URL` points to the correct instance

### TypeScript errors when running

Ensure dependencies are installed:

```bash
npm ci
npx prisma generate
```

The MCP server uses `tsx` for TypeScript execution — no manual compilation step is needed.
