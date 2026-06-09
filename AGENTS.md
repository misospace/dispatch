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
npm install          # Install dependencies
npm run dev          # Start development server
npm run build        # Production build
npm run lint         # Lint check
npm run typecheck    # TypeScript check
npx prisma generate  # Generate Prisma client
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

## OpenClaw Agent Workflow Contract

This section is the source of truth for how an OpenClaw agent should interact with Dispatch. Agents should follow this contract instead of grooming a GitHub Project board.

### Heartbeat lifecycle

At the **start** of each heartbeat:

1. **Best-effort `POST /api/sync`** to refresh Dispatch's issue cache. Treat any non-2xx, timeout, or network error as a freshness warning — log it and continue. **Do not fail the heartbeat on a sync failure.**

At the **end** of each heartbeat:

2. **`POST /api/agent-runs`** (bearer-auth with `DISPATCH_AGENT_TOKEN`) with run metadata: `agentName`, `runType`, `status`, `startedAt`, `finishedAt`, `summary`, `touchedIssueUrls`.

### Reading work

3. **Read issues from `GET /api/issues`.** Do not query the Postgres cache directly — the API is the contract.
4. **Prefer issues assigned via `agent/<agent-id>` label** if present. If no `agent/*` label exists, pick from **Ready** by default. Agents pick `status/ready` issues — `status/backlog` and unlabeled issues need triage and are excluded from the default queue.
5. **Filter by execution lane** using the `lane` query param on `GET /api/agents/[agentName]/queue` (values: `NORMAL`, `ESCALATED`, `BACKLOG`). By default, BACKLOG issues are excluded from the normal agent queue.
6. **Agents pick from Ready by default.** `status/backlog` or unlabeled issues are not queueable unless triage marks them Ready — they need grooming before being actionable.
7. **Respect execution lane classification** when present: NORMAL issues are the primary queue for agents; ESCALATED issues may require higher-judgment support; BACKLOG issues are not actionable until decomposed.

### PR review-fix queue

8. **PR-fix items take precedence over issue work.** Before consuming from the assignment queue, query `GET /api/agents/[agentName]/queue?lane=normal` — `type: "pr-review-fix"` items appear first in the response array.
9. **For each PR-fix item:** verify the PR is open and authored by the expected bot account, checkout the queued branch, apply minimal changes based on `feedback[]`, validate locally, push to the same branch, then mark via `POST /api/pr-fix-queue/mark` with status `fixed`, `blocked`, `stale`, or `ignored`.
10. **Never open a new PR for a queued PR fix.** Workers only push to the existing branch.
11. **PR-fix queue is the sole source of truth.** Do not use workspace-local scripts (e.g., `pr_fix_queue.py`) or state files (e.g., `.state/pr_fix_queue.json`) for PR-fix orchestration — all queue operations go through Dispatch APIs.

### Source of truth

8. **GitHub Issues and PRs remain the source of truth.** Dispatch's Postgres is a cache; do not write back to it as if it were authoritative.
9. **Do not rely on GitHub Projects.** The Projects board is deprecated for this workflow — group by repository instead.
10. **Do not auto-close issues without explicit evidence of completion.** Dispatch's audit log is not a license to close — a green pipeline, merged PR, or human approval is.

### Failure modes

11. **Dispatch failures must not fail the heartbeat.** Sync, agent-run POST, and issue read are all best-effort from the heartbeat's perspective. Log a warning, continue.
12. **Tokens are secrets.** `DISPATCH_AGENT_TOKEN` and `GITHUB_TOKEN` must never be logged, echoed, or persisted to disk.

### Auditability

13. **Every state-changing move on Dispatch must produce an AuditLog row.** Operators trace agent activity through `/api/audit`. Drag-and-drop moves on the Kanban board already write audit entries via `POST /api/issues/move`; agents using the same endpoint inherit this behavior.

### Worker execution contract

For the detailed worker execution contract (PR fix queue precedence, duplicate PR avoidance, hard completion gates, branch naming conventions, failure response format), see [docs/worker-execution-contract.md](./docs/worker-execution-contract.md). This supersedes ad-hoc behavior and applies to all agent workers.

### Worker cron prompt migration

Worker cron prompts have been migrated from GitHub Project board readers to Dispatch queue APIs. For migration details, affected cron jobs, and the deprecation of board-reading scripts, see [docs/worker-cron-prompt-migration.md](./docs/worker-cron-prompt-migration.md).

### Release cut process

Dispatch follows semver. Releases are cut from `main` after each notable fix or feature merge.

1. **Branch from up-to-date main**
   ```bash
   git checkout main
   git pull --ff-only
   git checkout -b chore/release-v<version>
   ```

2. **Bump version (no git tag yet)**
   ```bash
   npm version <version> --no-git-tag-version
   ```
   This updates `package.json` and `package-lock.json`.

3. **Validate**
   ```bash
   npm run lint
   npm run typecheck
   npm run test
   npm run build
   ```

4. **Commit and open PR**
   ```bash
   git add package.json package-lock.json
   git commit -m "chore: release v<version>"
   git push -u origin chore/release-v<version>
   gh pr create \
     --repo misospace/dispatch \
     --base main \
     --head chore/release-v<version> \
     --title "chore: release v<version>" \
     --body "Bump Dispatch package metadata to v<version>.

   Validation:
   - npm run lint
   - npm run typecheck
   - npm run test
   - npm run build"
   ```

5. **Merge PR**
   ```bash
   gh pr merge --repo misospace/dispatch --squash --delete-branch
   ```

6. **Tag and publish release**
   ```bash
   git checkout main
   git pull --ff-only
   git tag -a v<version> -m "v<version>"
   git push origin v<version>
   gh release create v<version> \
     --repo misospace/dispatch \
     --title "v<version>" \
     --generate-notes
   ```

   The tag push triggers the `Build Dispatch Image` workflow on GitHub Actions, which publishes to `ghcr.io/misospace/dispatch:v<version>`.
