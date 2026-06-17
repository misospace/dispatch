# Dispatch

<p align="center">
  <img src="public/images/logo.png" alt="Dispatch Logo" width="120" height="120" />
</p>

Kanban for AI agent work.

Dispatch is a harness-agnostic Kanban and work dispatch layer for AI agents. It turns GitHub Issues and PR follow-ups into claimable queues, tracks agent runs, manages status transitions, and keeps an audit trail while GitHub remains the source of truth.

## Tech Stack

- **Next.js**: 16.2.6 (App Router)
- **React**: v19
- **Prisma**: v7
- **Node**: v24 (Dockerfile uses `node:24-bookworm-slim`)
- **TypeScript**: v6
- **Tailwind CSS**: v4

## Architecture

### Source of Truth Rules

1. **GitHub is the authoritative source** for all issue/PR data
2. **Dispatch Postgres** stores:
    - Cached issue metadata (not the authoritative source)
    - Local project metadata
    - Agent runs
    - Audit logs
3. **Dispatch does NOT**:
    - Mount agent harness configuration files
    - Require access to an agent harness local workspace
    - Use GitHub Projects
   - Require cluster-admin or broad Kubernetes RBAC
   - Automatically close or complete tasks

### Data Flow

```
GitHub API → Dispatch (cache) → UI
GitHub Labels ↔ Kanban Board ↔ Audit Log
Agent Runs → Dispatch → Agent Activity Page
```

## Required Labels

### Status Labels
- `status/backlog` - Issue needs triage/grooming; not yet ready for agents
- `status/ready` - Issue is groomed and actionable; available for agents to claim
- `status/in-progress` - Issue is being worked on
- `status/in-review` - Issue has an open PR pending review/merge
- `status/done` - Issue is completed (closed)

### Owner Labels
- `owner/*` - Issue is owned by a specific person (e.g., `owner/alice`, `owner/bob`). The Board Owner filter is derived only from synced `owner/*` labels, not GitHub assignees.

### Agent Labels
- `agent/*` - Issue is assigned to or being worked on by an agent (e.g., `agent/alpha`, `agent/beta`). The Board Agent filter is derived only from synced `agent/*` labels, not `AgentRun` names, configured agents, or GitHub assignees.

### Project Labels
- Optional: `project/*` labels may exist on issues, but Dispatch Projects groups issues by repository by default.

### Priority Labels
- `priority/p0` - Critical
- `priority/p1` - High
- `priority/p2` - Medium
- `priority/p3` - Low

### Type Labels
- `type/bug`
- `type/feature`
- `type/chore`
- `type/research`
- `type/security`

## Environment Variables

### Preferred Variables (v0.2.1+)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (canonical) |
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token or GitHub App token (fallback when GitHub App auth is not configured) |
| `DISPATCH_AGENT_TOKEN` | Yes | Bearer token for agent API authentication |
| `GITHUB_REPOSITORIES` | Yes | Bootstrap seed config for repos to track. Accepts comma-separated or newline-separated values (e.g., `myorg/repo1,myorg/repo2` or `myorg/repo1` on separate lines). Repos can also be managed via Dispatch UI or `/api/automation/repos` after initial setup. |
| `DISPATCH_AUTH_MODE` | No | Authentication mode: `"basic"` (HTTP Basic Auth), `"oidc"` (OIDC/SSO), `"disabled"` (no auth, **local development only** — see [Operational Notes](#operational-notes)), or unset (legacy mode) |
| `DISPATCH_AUTH_USERNAME` | Conditional | Username for Basic Auth — required when `DISPATCH_AUTH_MODE=basic` |
| `DISPATCH_AUTH_PASSWORD` | Conditional | Password for Basic Auth — required when `DISPATCH_AUTH_MODE=basic` |
| `DISPATCH_OIDC_ISSUER` | Conditional | OIDC provider issuer URL (e.g., `https://auth.example.com`). Discovery URLs ending in `/.well-known/openid-configuration` are also accepted for compatibility. Required when `DISPATCH_AUTH_MODE=oidc` |
| `DISPATCH_OIDC_CLIENT_ID` | Conditional | OIDC client ID — required when `DISPATCH_AUTH_MODE=oidc` |
| `DISPATCH_OIDC_CLIENT_SECRET` | Conditional | OIDC client secret — required when `DISPATCH_AUTH_MODE=oidc`. Never exposed to the browser. |
| `DISPATCH_URL` | No | Base URL of your Dispatch instance (used by outbound clients and MCP bridge) |
| `DISPATCH_DATABASE_URL` | No | Alternative database URL alias — used if `DATABASE_URL` is not set |
| `NEXTAUTH_SECRET` | Conditional | Secret for NextAuth.js JWT signing — required when `DISPATCH_AUTH_MODE=oidc`. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NEXTAUTH_URL` | Conditional | Public Dispatch base URL used by NextAuth to derive callback URLs. Set this in OIDC deployments. |

### GitHub App Authentication (Optional)

Dispatch supports optional GitHub App authentication to provide a separate identity in GitHub issue timelines. When configured, mutations (label changes, state changes, etc.) appear under the GitHub App bot identity instead of the shared PAT account.

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Conditional | Your GitHub App's numeric ID |
| `GITHUB_APP_INSTALLATION_ID` | Conditional | The installation ID for the GitHub App on your org/repo |
| `GITHUB_APP_PRIVATE_KEY` | Conditional | PEM-formatted private key (supports real newlines and escaped `\n` form) |

**Behavior:**

- When **all three** GitHub App env vars are present, Dispatch uses GitHub App installation auth with token caching (refreshed ~5 minutes before expiry).
- When GitHub App env vars are **absent**, Dispatch falls back to the existing `GITHUB_TOKEN` PAT behavior.
- **Partial** configuration is silently ignored — Dispatch falls back to PAT without error.
- Secrets, tokens, and private keys are never logged.

**Resolution order:** `DATABASE_URL` > `DISPATCH_DATABASE_URL` (for database URLs). `DISPATCH_AGENT_TOKEN` (for agent tokens). `DISPATCH_URL` (for instance URL).

## First-Run Flow

To get started with Dispatch:

1. **Configure repos**: Set `GITHUB_REPOSITORIES` env var (comma or newline separated) _or_ add tracked repos via the UI after boot. `GITHUB_REPOSITORIES` is a **one-time bootstrap seed** — it is read only when the tracked-repos table is empty. Once any repo exists (seeded or added via UI), the env var is not consulted again, so updates must go through the UI or canonical API (`POST /api/automation/repos`). Env-seeded repos are tagged `source: "env"` and shown with a `seed` badge in `/automation`; user-added repos are tagged `source: "user"`.
2. **Deploy** with your database and GitHub token configured.
3. **Sync automation data**: `POST /api/automation/sync` (or use the Sync button on the Automation page).
4. **Sync issues**: `POST /api/sync` (or use the Sync Issues action in the board UI). Agent harnesses or worker heartbeats may also trigger best-effort issue sync automatically.
5. **View results**: The Kanban Board shows synced issues; the Projects view groups them by repository.

Production database migrations (`prisma migrate deploy`) run automatically on container startup — no manual intervention needed.

## Security

### Authentication

Dispatch supports three authentication models:

1. **Agent/Worker Auth** (`DISPATCH_AGENT_TOKEN`): Bearer token authentication for API calls from agents, MCP clients, and scheduled workers. This is required for all mutating API endpoints.

2. **Operator UI Auth**: Browser-based operator authentication with two modes:
   - **Basic Auth** (`DISPATCH_AUTH_MODE=basic`): HTTP Basic Auth — the browser prompts for username/password. Mutating API calls from the browser automatically include these credentials via `authedFetch()`.
   - **OIDC** (`DISPATCH_AUTH_MODE=oidc`): OIDC provider authentication (SSO). Operators sign in via a login page that redirects to the OIDC provider. Session cookies are managed by NextAuth.

3. **Disabled** (`DISPATCH_AUTH_MODE=disabled`): No auth enforcement — full open access. **Local development only — never use in production or any internet-facing deployment.** See [Operational Notes](#operational-notes).

### Auth Modes

| `DISPATCH_AUTH_MODE` | Behavior |
|---|---|
| *(not set)* | Legacy mode — no middleware enforcement. Agent routes use Bearer token auth via `DISPATCH_AGENT_TOKEN`. Browser UI has no separate auth model. |
| `basic` | HTTP Basic Auth required for operator UI routes. API routes also accept `DISPATCH_AGENT_TOKEN` bearer auth for agents and workers. |
| `oidc` | OIDC session-based authentication for operator UI routes. Route handlers accept either a valid NextAuth session cookie or `DISPATCH_AGENT_TOKEN` bearer auth. |
| `disabled` | **No auth enforcement — full open access.** All routes are publicly accessible without authentication. **Local development only.** See [Operational Notes](#operational-notes). |

### How it works

- **Middleware** (`src/middleware.ts`) protects operator UI pages. In Basic mode, UI pages require Basic Auth; API routes also allow agent Bearer auth. In OIDC mode, UI pages require a NextAuth session and unauthenticated users are redirected to `/login`; API routes are authorized by route handlers.
- **Route handlers** use a shared `authorizeRequest(request)` helper from `src/lib/auth.ts` that supports Basic Auth, Bearer token auth, and OIDC session cookies depending on the configured auth mode.
- **OIDC flow**: Operators visit `/login`, click "Sign in with SSO", are redirected to the OIDC provider, and return via `/api/auth/callback/oidc`. NextAuth issues a signed JWT session cookie.
- **Client components** (`kanban-board.tsx`, `sync-issues-button.tsx`) use `authedFetch()` which automatically attaches stored Basic Auth credentials to outgoing requests. In OIDC mode, cookies are sent automatically by the browser.


### Operational Notes

#### DISPATCH_AUTH_MODE=disabled — Security Warnings and Deployment Checks

Setting `DISPATCH_AUTH_MODE=disabled` disables all authentication enforcement for both operator UI routes and API routes. **This means every endpoint is publicly accessible without any credentials.**

**⚠️ CRITICAL: This mode MUST only be used for local development.** The following deployment checks are enforced when `DISPATCH_AUTH_MODE=disabled` is detected:

1. **Startup Warning**: A warning is logged to stdout on every application start, reminding operators that disabled auth mode is active.
2. **Health Endpoint Exposure**: The `/api/health` endpoint reports the current auth mode in its response (`{ ok: true, database: "ok", version: "...", authMode: "disabled" }`), allowing operators and monitoring tools to verify the configuration at a glance.
3. **Local-Only Guidance**: When deploying with disabled auth mode, ensure Dispatch is bound to `127.0.0.1` (localhost) only and is NOT exposed to any network interface that could be reached from outside the local machine. Do not set up reverse proxies, load balancers, or ingress rules that forward external traffic to a dispatch instance running with `DISPATCH_AUTH_MODE=disabled`.

**If you need Dispatch without authentication:**
- Use `DISPATCH_AUTH_MODE=basic` with strong credentials for internal deployments behind a trusted network.
- Use `DISPATCH_AUTH_MODE=oidc` with a proper OIDC provider for production deployments.
- Never expose a disabled-auth instance to the internet or untrusted networks.

**Security implications of disabled mode:**
- All mutating API endpoints (create/update/delete issues, claim work, sync repos, etc.) accept requests from any source.
- The operator UI is fully accessible — anyone can view and modify all kanban boards, trigger syncs, and manage tracked repositories.
- Agent tokens (`DISPATCH_AGENT_TOKEN`) are also ignored — there is no distinction between authenticated and unauthenticated requests.
- Webhook endpoints in `src/app/api/pr-followup/` that conditionally skip signature verification become completely unprotected.

---

### Agent Token vs Operator Auth

| | Agent/Worker Auth | Operator UI Auth (Basic) | Operator UI Auth (OIDC) |
|---|---|---|---|
| **Header/Cookie** | `Authorization: Bearer <token>` | `Authorization: Basic <base64(user:pass)>` | Session cookie (NextAuth JWT) |
| **Config** | `DISPATCH_AGENT_TOKEN` | `DISPATCH_AUTH_USERNAME` + `DISPATCH_AUTH_PASSWORD` | `DISPATCH_OIDC_ISSUER`, `DISPATCH_OIDC_CLIENT_ID`, `DISPATCH_OIDC_CLIENT_SECRET` |
| **Used by** | Agents, MCP clients, cron workers | Browser UI (human operators) | Browser UI (human operators) |
| **Protected routes** | Mutating API endpoints | Operator UI + mutating browser API calls | Operator UI + mutating browser API calls |

### OIDC Setup

To enable OIDC authentication:

1. **Register an OIDC client** with your identity provider (Keycloak, Authentik, Okta, Google, GitHub OAuth, etc.). Configure the redirect URI to point to your Dispatch instance:
   ```
   https://your-dispatch-url.example.com/api/auth/callback/oidc
   ```

2. **Set the required environment variables**:
   ```bash
   DISPATCH_AUTH_MODE="oidc"
   DISPATCH_OIDC_ISSUER="https://your-issuer.example.com"
   DISPATCH_OIDC_CLIENT_ID="your-client-id"
   DISPATCH_OIDC_CLIENT_SECRET="your-client-secret"
   NEXTAUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
   NEXTAUTH_URL="https://your-dispatch-url.example.com"
   ```

3. **Restart Dispatch**. Operators will see a login page at `/login` with a "Sign in with SSO" button.

4. **Agent tokens continue to work** — agents use `DISPATCH_AGENT_TOKEN` bearer auth regardless of the operator auth mode.

## Required Labels

## Phase 1 Features

### Implemented
1. **GitHub Repository Configuration**
   - Support configuring multiple GitHub repos to sync
   - Use env vars for GitHub auth (PAT support)

2. **Issue Sync**
   - Fetch open GitHub issues from configured repos
   - Cache issue metadata in Postgres
   - Store: number, repo, title, state, labels, assignees, URL, timestamps

3. **Kanban Board**
   - Columns: Backlog, Ready, In Progress, In Review, Done
   - Drag-and-drop between columns updates GitHub labels
   - Audit log entry on every mutation
   - Visible error on GitHub mutation failure

4. **Filtering**
   - Filter by repo and priority
   - Filter by agent and owner labels; empty agent/owner dropdowns mean no synced issues currently carry `agent/*` or `owner/*` labels

5. **Project View**
   - Group synced issues by repository
   - Show issues by status per repository project

6. **Agent Activity Ingestion**
   - `POST /api/agent-runs` with bearer token auth
   - Store agent name, run type, status, timestamps, summary, touched issues

7. **Overview Page**
   - Open issues by status
   - Issues per agent
   - Stale in-progress issues
   - Recent agent runs
   - Recent audit log entries

8. **Audit Log**
   - Record every board mutation with actor, action, before/after labels, success/failure

9. **Deployment**
    - Dockerfile for containerized deployment (Debian bookworm-slim)
    - Production database migrations run automatically on container startup

### Intentionally Not Included in Phase 1

- GitHub Projects integration
- Automatic task completion
- Broad Kubernetes RBAC
- S3/PVC storage
- Redis/Dragonfly caching
- Kanban card editing beyond status
- Complex project management features

## Local Development

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Push schema to database (local dev only - no migrations exist yet)
npm run db:push

# Start development server
npm run dev
```

## Testing

Run the smoke/regression suite locally with:

```bash
npm run test
```

The tests are intentionally lightweight and do not require Postgres, GitHub API access, or secrets. They cover:

- repository env parsing and validation
- BigInt-safe JSON serialization for automation API responses
- critical API route file presence
- issue sync response shaping and per-repo error handling
- Kanban status grouping, including no-status issues appearing in Backlog
- project grouping by repository boundaries
- dark mode toggle class and localStorage behavior

The `CI` workflow runs lint, typecheck, tests, and build. The image workflow builds the Docker image, publishes GHCR images on `main` and `v*` tags, and uploads advisory Trivy scan results.

Recommended Renovate flow:

1. Merge the test harness first.
2. Let Renovate PRs rebase onto the new checks.
3. Merge low-risk dependency PRs first.
4. Handle framework, Prisma, and React updates separately.

## Database Setup

Dispatch uses Prisma with PostgreSQL. Migrations are used for production; `db push` is for local development only.

### Local Development
- Use `npm run db:push` to apply schema changes without migrations.

### Production Deployment
- Production automatically runs `prisma migrate deploy` on container startup.
- First deploy against an empty database creates all tables automatically.
- No manual `kubectl exec` or `db push` is required.
- Set `SKIP_DB_MIGRATIONS=true` to skip migrations if needed.

```bash
# Production (automatic on startup):
npm run db:deploy

# Local dev only:
npm run db:push
```

## Deployment

Dispatch ships with a Dockerfile for containerized deployment. Orchestration manifests (Kubernetes, Docker Compose, etc.) are not included — deploy using whatever platform fits your infrastructure. Example Kubernetes manifests using the bjw-s/app-template Helm chart are available in optional example repos.

Required secrets:
- `DATABASE_URL` - PostgreSQL connection string (canonical)
- `GITHUB_TOKEN` - GitHub authentication
- `DISPATCH_AGENT_TOKEN` - Agent API bearer token

## API Endpoints

### GET /api/issues
List cached issues. Query params: `repo`, `agent`, `owner`, `project`, `priority`

### POST /api/issues/move
Move issue between status columns. Body: `{ issueId, repoFullName, issueNumber, oldLabels, newLabels }`

### GET /api/repos
List configured repositories for the board/issue-sync view (`Repository` rows). This is not the tracked repository management API.

### POST /api/repos
Deprecated compatibility endpoint for adding a tracked repository. Prefer `POST /api/automation/repos`; this endpoint delegates to the same behavior and returns deprecation headers.

### GET /api/automation/repos
Canonical tracked repository list for automation. Returns `AutomationRepo` rows with workflow/release summary fields used by `/automation`.

### POST /api/automation/repos
Canonical tracked repository add endpoint. Body: `{ fullName: "owner/repo" }`. Creates an `AutomationRepo` row with `source: "user"` **and** a mirror enabled `Repository` row so issue sync and the board see it immediately. Returns 409 if the repo is already tracked. Writes an `add_tracked_repo` AuditLog entry.

### DELETE /api/automation/repos/[repo]
Stop tracking a repository. `[repo]` is the URL-encoded `owner/repo` fullName. Hard-deletes the `AutomationRepo` row (cascading workflow/run/release history) and soft-disables the mirror `Repository` row (`enabled = false`) so cached issues remain visible for history but are excluded from active board filters. Writes a `remove_tracked_repo` AuditLog entry.

`/api/automation/repositories` and `/api/automation/repositories/[id]` were legacy duplicate routes and have been removed. Use `/api/automation/repos` for tracked repository management.

### POST /api/sync
Sync all issues from configured repositories. Intended callers are:

- the board UI's manual **Sync Issues** action
- agent harness or worker heartbeat best-effort cache refresh (see Scheduled Issue Sync Strategy below)

### GET /api/agent-runs
List agent runs. Query params: `limit`

### POST /api/agent-runs
Create agent run. Requires `DISPATCH_AGENT_TOKEN` bearer auth.

### GET /api/audit
List audit logs. Query params: `limit`, `repo`

**Note: Issue sync and automation sync are separate concerns.**
- **Issue sync** (`POST /api/sync`) refreshes GitHub issues into the Kanban board. It is heartbeat-driven (best-effort via agent harness) or manual via UI.
- **Automation sync** (`POST /api/automation/sync`) refreshes CI/CD, workflow runs, releases, and packages data. It is managed independently on the Automation page.
- Each sync operates on its own data models and caching layer.

## Automation Section

Dispatch includes an Automation section that discovers and visualizes CI/CD, builds, tests, security scans, releases, and scheduled workflows from GitHub repositories.

### Data Sources Used

- GitHub REST API (`/repos`, `/actions/workflows`, `/actions/runs`, `/actions/jobs`, `/releases`, `/pulls`, `/packages`)
- Local repository scanning (for workflow path discovery)

### GitHub Permissions Required

For read-only automation visibility:
- `metadata:read` - Repository metadata
- `contents:read` - Workflow file access
- `actions:read` - Workflow runs and jobs
- `pull_requests:read` - PR associations with runs
- `packages:read` - Container/package metadata (if applicable)

For control actions (rerun, dispatch):
- `actions:write` - Re-run workflows, trigger workflow_dispatch

### New Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_REPOSITORIES` | Yes | Bootstrap seed config for tracked repos. Accepts comma-separated or newline-separated values (e.g., `myorg/repo1,myorg/repo2`). Managed repos can also be added/removed via UI at `/automation`. |

### Screens Added

1. **Automation Overview** (`/automation`)
   - One card per tracked repo
   - Shows: repo name, default branch, latest commit SHA, workflow status, failing/running counts, latest release, open PR count
   - Sync button to refresh data
   - Link to GitHub repo
   - Add/remove tracked repos via UI

2. **Repo Automation Detail** (`/automation/repos/[repo]`)
   - Workflow list with recent runs per workflow
   - Release history
   - Package/image tags
   - Recent activity feed
   - Sync status and error display

3. **Workflow Detail** (`/automation/workflows/[id]`)
   - Workflow name, path, state
   - Recent runs with status, branch, SHA, actor, duration
   - Success rate and average duration
   - Jobs breakdown for latest run
   - Link to GitHub workflow page

4. **Activity Feed** (`/automation/activity`)
   - Unified event feed across all repos
   - Events include: workflow runs, releases, PRs, sync completions
   - Filterable by event type

### Control Actions Implemented

- **Re-run failed workflow**: POST to `/api/automation/runs/[runId]?action=rerun`
  - Audited in AuditLog
  - Requires: `repoFullName` query param, `runId` path param
  - Requires GitHub token with `actions:write` permission

- **Trigger workflow dispatch**: POST to `/api/automation/runs/[runId]?action=dispatch`
  - Audited in AuditLog
  - Triggers `workflow_dispatch` on the workflow associated with the run's branch
  - Requires GitHub token with `actions:write` permission

### Cache Behavior

- All GitHub automation state is cached in Postgres
- `lastSyncedAt` timestamp on `AutomationRepo` shows cache freshness
- `syncError` field stores last sync failure for visibility
- UI shows stale warnings when `lastSyncedAt` > 1 hour ago
- Sync runs are recorded in `AutomationSyncRun` table with stats

## Pre-migration Smoke Checklist

Run this checklist before pointing an agent harness at Dispatch as its task-visibility layer (instead of a GitHub Project board). Every step should pass; stop and investigate on the first failure.

Set `BASE` to your Dispatch URL (e.g. `BASE=https://dispatch.internal`) before running.

| # | Check | Expected |
|---|-------|----------|
| 1 | `curl -fsS "$BASE/api/health"` | `{"ok":true,"database":"ok",...}` |
| 2 | `curl -fsS -X POST "$BASE/api/automation/sync"` | 2xx, no error body |
| 3 | `curl -fsS "$BASE/api/automation/repos"` | JSON array, non-empty if repos are configured |
| 4 | `curl -fsS -X POST "$BASE/api/sync" -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN"` | `syncedCount > 0` |
| 5 | `curl -fsS "$BASE/api/issues"` | JSON array, length > 0 |
| 6 | Open `/board` in a browser | Issues render — no "no issues synced yet" empty state (or auth dialog if Basic Auth is enabled) |
| 7 | Open `/projects` | Repo groups render |
| 8 | Open `/agents` | Recent agent heartbeat visible with agent name |
| 9 | Move a low-risk test issue between columns | GitHub label changes; AuditLog row appears in `GET /api/audit` |
| 10 | `kubectl logs -n <ns> <pod>` (or equivalent) | No Prisma / BigInt / FK errors |

Only flip the agent's workflow over once all ten steps pass.

**When Basic Auth is enabled**, add `-u "$DISPATCH_AUTH_USERNAME:$DISPATCH_AUTH_PASSWORD"` to browser and curl requests, or use the browser's native auth dialog.

## Scheduled Issue Sync Strategy

Dispatch keeps GitHub as the source of truth and stores issues only as a local cache. Cache freshness is owned by **agent harness heartbeat sync** rather than by a Dispatch background worker or new cluster CronJob.

Decision:
- At the start of each heartbeat, the agent harness should make a best-effort `POST` request to Dispatch's `/api/sync` endpoint.
- The request must be non-blocking for heartbeat work: log/report a warning if the sync fails or times out, then continue the heartbeat.
- Manual UI sync remains supported for immediate refreshes and troubleshooting.

Rationale:
- Reuses the existing heartbeat that already reports to Dispatch, so no new Kubernetes manifests, images, queues, or background scheduler are required.
- Keeps cache freshness close to the agent workflow that consumes the board.
- Preserves Dispatch's simple app model: it serves API/UI requests and does not need long-running in-process scheduling state.

Rejected alternatives for the first implementation:
- **Kubernetes CronJob**: valid later if heartbeat-driven sync is too sparse, but it adds deployment and auth plumbing for little immediate benefit.
- **Dispatch internal scheduler**: would couple cache freshness to app process lifetime and introduces timer/queue behavior that Phase 1 intentionally avoids.

Operational notes:
- Configure the agent harness with `DISPATCH_URL` and any required network access to reach Dispatch.
- `/api/sync` currently does not require `DISPATCH_AGENT_TOKEN`; if auth is added later, update the heartbeat caller and this section together.
- Treat sync failures as freshness warnings, not heartbeat failures, unless the heartbeat itself cannot complete.

### Known Limitations

1. **No workflow YAML parsing**: Trigger types (push, PR, schedule, manual) are not parsed from workflow files. GitHub shows workflow state (active/inactive) but not trigger configuration.
2. **No branch-specific runs**: Only the most recent runs per workflow are fetched, not runs across all branches historically.
3. **No check runs/check suites**: Job-level visibility is limited to Actions jobs; separate status checks from other integrations are not fetched.
4. **No Secrets scanning**: Secret detection results from GitHub's secret scanning are not fetched (requires additional API endpoint).
5. **Package visibility**: GitHub packages require the user to have appropriate permissions to view; private packages may not be visible.
6. **No webhook receiver for real-time updates**: Issue cache refresh is heartbeat-driven and best-effort, not push-based from GitHub.
7. **No workflow run logs**: Full logs are not stored; only run metadata and job status.

### Deferred Phase 2 Items

1. **Webhook receiver** for real-time automation updates
2. **Workflow trigger parsing** from YAML to show push/PR/schedule/dispatch triggers
3. **Branch-specific run history** with filtering
4. **Check runs integration** for non-Actions status checks
5. **Secret scanning results** visibility
6. **Artifact listing** for workflow runs
7. **Deployment status** correlation (link runs to environments)
8. **Caching improvements** with Redis if sync load becomes problematic
9. **Webhook-based issue sync** if heartbeat freshness is not enough

## Container Image

The Dispatch Docker image is built and published via GitHub Actions CI/CD.

### Image Name

```
ghcr.io/misospace/dispatch
```

### Workflow

`.github/workflows/image.yaml` - Build Dispatch Image

### Triggers

- Push to `main` branch
- Pull requests targeting `main`
- Version tags (`v*`)
- Manual workflow dispatch

### Tags Generated

| Event | Tags |
|-------|------|
| Push to `main` | `main`, `sha-<shortsha>` |
| Version tag `v1.2.3` | `1.2.3`, `1.2`, `latest`, `sha-<shortsha>` |
| Pull request | Build only, no push |

### How to Manually Trigger a Build

```bash
# Via GitHub CLI
gh workflow run image.yaml

# Via web: Actions > Build Dispatch Image > Run workflow
```

### Required GitHub Settings

1. **GHCR Package Visibility**: The package is published to `ghcr.io`. Ensure the repository's GHCR package visibility is set to appropriate level (public or private with OCI registry access).

2. **Workflow Permissions**: The workflow requires:
   - `contents: read` - for checkout
   - `packages: write` - for pushing to GHCR
   - `pull-requests: read` - for PR trigger context

   These are set via `GITHUB_TOKEN` which is automatically granted. No additional secrets needed.

3. **OIDC**: No cloud credentials required. Uses `GITHUB_TOKEN` for GHCR authentication.

### Home-ops Image Reference

The Kubernetes deployment references the image:

```yaml
spec:
  containers:
    - image: ghcr.io/misospace/dispatch:main
```

The image tag `main` is updated on each push to the `main` branch via the CI workflow.

### Local Development Image Build

```bash
# Build locally
docker build -t ghcr.io/misospace/dispatch:local .

# Run locally
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e GITHUB_TOKEN="ghp_..." \
  -e DISPATCH_AGENT_TOKEN="..." \
  # Optional: Enable Basic Auth for browser UI
  # -e DISPATCH_AUTH_MODE="basic" \
  # -e DISPATCH_AUTH_USERNAME="admin" \
  # -e DISPATCH_AUTH_PASSWORD="secure-password" \

  # Or enable OIDC/SSO for browser UI
  # -e DISPATCH_AUTH_MODE="oidc" \
  # -e DISPATCH_OIDC_ISSUER="https://auth.example.com" \
  # -e DISPATCH_OIDC_CLIENT_ID="your-client-id" \
  # -e DISPATCH_OIDC_CLIENT_SECRET="your-client-secret" \
  # -e NEXTAUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  ghcr.io/misospace/dispatch:local
```
