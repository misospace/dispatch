# AGENTS.md

## Dispatch Overview

Dispatch is a self-hosted Next.js/TypeScript Kanban and work dispatch layer for AI agents. It uses Prisma with PostgreSQL as its database.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Database**: PostgreSQL via Prisma v7 ORM
- **Styling**: Tailwind CSS
- **Container**: Docker (Debian bookworm-slim based)

## Key Commands

```bash
npm install          # Install dependencies (runs `prisma generate` via postinstall)
npm run dev          # Start development server
npm run build        # Production build
npm run lint         # Lint check
npm run typecheck    # TypeScript check
npm run db:generate  # Regenerate Prisma client (also runs on postinstall; re-run after editing schema.prisma)
npm run db:push      # Push schema (dev)
npm run db:deploy    # Deploy migrations (prod)
```

## Important Conventions

### Environment Variables

#### Preferred (v0.2.1+)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (canonical) |
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token |
| `DISPATCH_AGENT_TOKEN` | Yes | Bearer token for agent API |
| `GITHUB_REPOSITORIES` | Yes | **One-time** bootstrap seed for tracked repos (comma or newline separated). Read only when `AutomationRepo` is empty. After first seed, manage via `/automation` UI or `POST /api/repos` / `POST /api/automation/repos`. Seeded repos carry `source: "env"`; UI-added repos carry `source: "user"`. |
| `DISPATCH_URL` | No | Base URL of your Dispatch instance (used by outbound clients and MCP bridge) |
| `DISPATCH_DATABASE_URL` | No | Alternative database URL alias — used if `DATABASE_URL` is not set |
| `NEXTAUTH_SECRET` | No | NextAuth.js secret |
| `NEXTAUTH_URL` | No | NextAuth.js URL |
| `DISPATCH_SCHEDULER_ENABLED` | No | `true` runs periodic jobs (sync, groomer, PR-followup, prune-closed) in-process instead of via external cronjobs. Off by default. Confine to a single replica. |
| `DISPATCH_SYNC_INTERVAL_MS` | No | Scheduled-sync interval when the scheduler is enabled (default 900000 = 15m; `0` disables the job) |
| `DISPATCH_GROOMER_INTERVAL_MS` | No | Groomer run interval (default 600000 = 10m; `0` disables) |
| `DISPATCH_PR_FOLLOWUP_INTERVAL_MS` | No | PR-followup sync interval (default 900000 = 15m; `0` disables) |
| `DISPATCH_PRUNE_CLOSED_INTERVAL_MS` | No | Closed-issue prune interval (default 86400000 = 24h; `0` disables) |

Resolution order: `DATABASE_URL` > `DISPATCH_DATABASE_URL`. `DISPATCH_AGENT_TOKEN` for agent API bearer auth.

### Label Conventions

Labels follow a `category/value` pattern:

- **Status**: `status/backlog`, `status/ready`, `status/in-progress`, `status/in-review`, `status/done`
- **Owner**: `owner/*` (e.g., `owner/alice`); Board owner filtering is label-based and does not use GitHub assignees
- **Agent**: `agent/*` (e.g., `agent/alpha`); Board agent filtering is label-based and does not use AgentRun names, configured agents, or GitHub assignees
- **Project**: `project/*` (e.g., `project/k8s`)
- **Note:** `project/*` labels are **optional** and not required for the Projects view. Projects groups issues by repository by default.
- **Priority**: `priority/p0` through `priority/p3`
- **Type**: `type/bug`, `type/feature`, `type/chore`, `type/research`, `type/security`


### Issue Execution Lane Classification

Dispatch classifies issues into three execution lanes:

- **NORMAL**: Concrete, scoped, testable implementation work suitable for a standard worker. Examples: bounded frontend/backend fixes, documentation, tests, CI/lint, release/version drift, dependency updates, concrete follow-up issues with clear acceptance criteria.
- **ESCALATED**: Requires higher-judgment model support (may be GPT-5.5, Claude Opus, GLM-5.1, or another provider). Examples: architecture/security/API/auth boundary design, database/schema migration strategy, distributed/cross-service design, ambiguous product behavior, broad refactor planning, RFC/design/alternatives decisions, audit parent decomposition.
- **BACKLOG**: Not actionable yet — placeholder, missing enough detail, or a parent/umbrella item that hasn't been decomposed into concrete work.

Each classification stores: `lane`, `confidence` (`high`/`medium`/`low`), `reason`, and `model/source`. A full history of classifications is maintained in the `IssueLane` table.

**Routing rules:**
- Do NOT route to ESCALATED only because labels include `needs-escalation`, legacy `needs-gpt`, `escalated`, or `priority/p1`.
- DO route broad audit parent/umbrella issues to ESCALATED for decomposition/design unless already decomposed.
- If the issue has clear acceptance criteria, prefer NORMAL.
- If confidence is low and the issue is not actionable, choose BACKLOG.

**API endpoints:**
- `GET /api/issues/[issueId]/lane` — get the current lane classification for an issue
- `POST /api/issues/[issueId]/lane` — classify or reclassify an issue (body: `{ force?: boolean, model?: string, classification?: Record<string, unknown> }`). Omit body to return current lane; provide `classification` to set it directly; use `force` to bypass lazy evaluation.

**Agent queue integration:**
- Agent queue endpoint (`GET /api/agents/[agentName]/queue`) accepts a `lane` query param to filter by lane.
- By default, BACKLOG issues are excluded from the normal agent queue.

**Sync integration:**
- The sync pipeline can optionally classify lanes after syncing issues. Classification failures default to NORMAL and do not break the sync.

### GitHub Permissions Required

For read-only automation visibility:
- `metadata:read`, `contents:read`, `actions:read`, `pull_requests:read`, `packages:read`

For control actions (rerun, dispatch):
- `actions:write`

## Code Standards

1. **No agent-specific names in generic docs** - Use generic patterns like `agent/*` not specific agent names
2. **Prisma schema** - Keep relations strict; do not make foreign keys nullable to hide bugs
3. **API routes** - Return appropriate HTTP status codes; use JSON for responses
4. **Error handling** - Use `error instanceof Error` pattern; provide meaningful error messages
5. **Validation** - Validate inputs before database operations
6. **No commit of secrets** - Never commit `.env` files, `node_modules`, `.next`, or build output

## Prisma Notes

- Schema is in `prisma/schema.prisma`
- Local dev: `db push` (push schema without migrations)
- Production: `prisma migrate deploy` runs automatically on container startup
- binaryTargets includes `linux-arm64-openssl-3.0.x` for Debian bookworm-slim runtime

## Docker

- Base image: `node:24-bookworm-slim`
- OpenSSL and ca-certificates installed in builder stage for Prisma generation
- Runtime image installs same packages for Prisma client operation
- Multi-stage build: deps → builder → runner

## GitHub Actions CI

- `.github/workflows/image.yaml` builds and publishes to GHCR
- Trivy scanning is advisory only (`continue-on-error: true`)
- Lint/typecheck blocks CI; must pass
- Push to `main` creates `main` and `sha-<shortsha>` tags

## Common Issues

### Prisma client fails to load
- Ensure `npx prisma generate` has run during build
- Check OpenSSL is installed in the image
- Verify correct binaryTargets for the runtime

### DATABASE_URL not found at build time
- Next.js static generation runs at build time; Prisma initializes lazily
- The error appears during build but does not block it; runtime needs the env var

## File Structure

```
src/
  app/
    api/           # API routes
      automation/  # Automation sync, runs, workflows, events
      agent-runs/  # Agent run ingestion
      issues/       # Issue listing, movement, and lane classification
      repos/       # Repository config
      sync/        # Issue sync
      audit/       # Audit log
      health/      # Health check endpoint
      pr-fix-queue/ # PR review-fix queue (enqueue, queued, mark)
      pr-followup/  # PR follow-up ingestion (sync, webhook)
    automation/    # Automation UI pages
    board/         # Kanban board
    projects/      # Project view
    agents/        # Agent activity page
  lib/
    prisma.ts      # Prisma client singleton
    github.ts      # GitHub API helpers
    pr-fix-queue.ts       # PR fix queue client and utilities
    pr-followup-ingestion.ts  # PR follow-up event ingestion
```

## Health Endpoint

`GET /api/health` returns:
```json
{
  "ok": true,
  "database": "ok",
  "version": "0.1.13"
}
```

Returns 503 if database is unreachable.

## Agent Workflow Contract

This section is the source of truth for how any agent (Saffron, or any other harness) interacts with Dispatch. It supersedes all prior workflow guidance.

### Canonical One-Task Worker Loop

Every agent heartbeat follows this loop:

1. **`GET /api/agents/{agentName}/next-task?lane=normal`** (bearer-auth required). Returns exactly one `AgentTask`. If idle (`shouldRun: false`), stop immediately — do not start the model.
2. **Execute exactly one task.** The task type determines what to do (see Task Types below).
3. **`POST /api/agents/{agentName}/tasks/report`** (bearer-auth required). Report the outcome, then stop.

```python
def heartbeat(agent_name, dispatch_url):
    auth = {"Authorization": f"Bearer {DISPATCH_AGENT_TOKEN}"}

    # Step 1: fetch next task (auth required)
    task = get(
        f"{dispatch_url}/api/agents/{agent_name}/next-task?lane=normal",
        headers=auth,
    )

    # Step 2: idle check — stop before model work
    if not task["shouldRun"]:
        return

    # Step 3: execute exactly one task
    result = execute(task)

    # Step 4: report outcome (auth required)
    post(
        f"{dispatch_url}/api/agents/{agent_name}/tasks/report",
        headers=auth,
        json={"taskType": task["type"], "outcome": result["outcome"], **result["metadata"]},
    )

    # Stop
```

**Optional preflight sync:** Agents may call `POST /api/sync` before fetching their next task to refresh Dispatch's issue cache. This is a best-effort, out-of-band operation — not required for the worker loop and not something agents depend on before every task. Sync failures should be logged as freshness warnings and must not block task execution.

### Auth Requirements

Both `next-task` and `tasks/report` require bearer token authentication via `DISPATCH_AGENT_TOKEN`. Use the existing Dispatch bearer token model — no new environment variables or auth schemes.

```bash
# Fetch next task
curl -s -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  "$DISPATCH_URL/api/agents/saffron/next-task?lane=normal"

# Report outcome
curl -s -X POST -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskType":"implement","outcome":"pr_opened","repoFullName":"org/repo","issueNumber":42,"pullRequestUrl":"https://github.com/org/repo/pull/50"}' \
  "$DISPATCH_URL/api/agents/saffron/tasks/report"
```

### Task Types

The `next-task` endpoint returns one of four task types:

| Type | `shouldRun` | Description |
|------|-------------|-------------|
| `idle` | `false` | No work available. Stop immediately — do not start the model. |
| `implement` | `true` | Work exactly one GitHub issue. Open or update one PR, then stop. |
| `followup-pr` | `true` | Update exactly one existing PR with requested changes, then stop. |
| `groom` | `true` | Triage and enrich exactly one issue (labels, lane, status), then stop. (Use `?mode=groom`) |

### Report Outcomes

The `tasks/report` endpoint accepts these outcomes:

| Outcome | Meaning |
|---------|---------|
| `pr_opened` | A new PR was opened for the issue |
| `pr_updated` | An existing PR was updated with changes |
| `issue_updated` | The issue was updated (labels, body, etc.) |
| `issue_closed` | The issue was closed |
| `blocked` | Work cannot proceed without external input |
| `failed` | The task failed unexpectedly |
| `no_changes_needed` | No action was required |

### Worker Boundaries

Workers must respect these constraints:

* **Do not merge PRs.** Workers never merge pull requests.
* **Do not groom unless taskType is `groom`.** Implementation workers do not triage issues.
* **Do not claim another issue after finishing one task.** Report outcome and stop. The next heartbeat fetches the next task.
* **Report outcome and stop.** Every heartbeat executes at most one task.

### Source of Truth

* **GitHub Issues and PRs remain the source of truth.** Dispatch's Postgres is a cache; do not write back to it as if it were authoritative.
* **Do not rely on GitHub Projects.** The Projects board is deprecated for this workflow — group by repository instead.
* **Do not auto-close issues without explicit evidence of completion.** A green pipeline, merged PR, or human approval is required.

### Failure Modes

* **`next-task` failure:** If the endpoint returns an error, log a warning and stop — do not start the model.
* **`tasks/report` failure:** If reporting fails after execution, log a warning and stop. The work was completed; the report is best-effort visibility.
* **Optional sync failure:** Log as a freshness warning. Never block task execution.
* **Tokens are secrets.** `DISPATCH_AGENT_TOKEN` and `GITHUB_TOKEN` must never be logged, echoed, or persisted to disk.

### Auditability

* Label, lane, and issue state changes that go through Dispatch mutation APIs produce AuditLog entries. Operators trace these through `/api/audit`.
* Task execution reports create AgentRun rows via `tasks/report`.

### Legacy APIs

The following endpoints remain available for internal use and backward compatibility but are **not** the primary agent workflow:

* `POST /api/sync` — optional best-effort cache refresh
* `POST /api/agent-runs` — legacy run ingestion (superseded by `tasks/report`)
* `GET /api/issues` — raw issue listing (superseded by `next-task`)
* `GET /api/agents/{name}/queue` — legacy queue endpoint (superseded by `next-task`)

### Detailed Worker Contract

For the detailed worker execution contract (PR fix queue precedence, duplicate PR avoidance, hard completion gates, branch naming conventions, failure response format), see [docs/worker-execution-contract.md](./docs/worker-execution-contract.md). This supersedes ad-hoc behavior and applies to all agent workers.

### Generic Harness Loop

For harness-agnostic integration examples (curl, OpenClaw, Codex, Claude Code), see [docs/generic-harness-loop.md](./docs/generic-harness-loop.md).

### Worker Cron Prompt Migration

Worker cron prompts have been migrated from GitHub Project board readers to Dispatch queue APIs. For migration details, affected cron jobs, and the deprecation of board-reading scripts, see [docs/worker-cron-prompt-migration.md](./docs/worker-cron-prompt-migration.md).

### Release cut process

Dispatch follows semver. Releases are started from **Actions → Manual Release → Run workflow** after notable fixes or features merge.

1. Enter the package version without a `v` prefix (for example `0.5.4`) and operator-focused Markdown release notes.
2. Follow the linked version-bump PR. It auto-merges after the protected branch checks pass.
3. `Publish Release` verifies the two package version files, creates `v<version>` at the merge commit, and publishes the supplied notes.

The tag triggers `Build Dispatch Image`, which publishes `ghcr.io/misospace/dispatch:<version>`. Do not use generated notes; keep the workflow input focused on user-visible fixes, features, and material maintenance.
