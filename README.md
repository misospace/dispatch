# Mission Control

OpenClaw Mission Control is a self-hosted dashboard that visualizes GitHub issues and OpenClaw agent activity. It replaces dependency on GitHub Projects while keeping GitHub Issues and PRs as the public collaboration surface.

## Architecture

### Source of Truth Rules

1. **GitHub is the authoritative source** for all issue/PR data
2. **Mission Control Postgres** stores:
   - Cached issue metadata (not the authoritative source)
   - Local project metadata
   - Agent runs
   - Audit logs
3. **Mission Control does NOT**:
   - Mount OpenClaw config files
   - Require access to OpenClaw's local filesystem
   - Use GitHub Projects
   - Require cluster-admin or broad Kubernetes RBAC
   - Automatically close or complete tasks

### Data Flow

```
GitHub API → Mission Control (cache) → UI
GitHub Labels ↔ Kanban Board ↔ Audit Log
Agent Runs → Mission Control → Agent Activity Page
```

## Required Labels

### Status Labels
- `status/backlog` - Issue is in backlog
- `status/in-progress` - Issue is being worked on
- `status/in-review` - Issue is under review
- `status/done` - Issue is completed

### Owner Labels
- `owner/*` - Issue is owned by a specific person (e.g., `owner/alice`, `owner/bob`)

### Agent Labels
- `agent/*` - Issue is being worked on by an agent (e.g., `agent/alpha`, `agent/beta`)

### Project Labels
- Optional: `project/*` labels may exist on issues, but Mission Control Projects group issues by repository by default.

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

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token or GitHub App token |
| `MISSION_CONTROL_AGENT_TOKEN` | Yes | Bearer token for agent API authentication |
| `GITHUB_REPOSITORIES` | Yes | Bootstrap seed config for repos to track. Accepts comma-separated or newline-separated values (e.g., `myorg/repo1,myorg/repo2` or `myorg/repo1` on separate lines). Repos can also be managed via Mission Control UI after initial setup. |
| `NEXTAUTH_SECRET` | No | Secret for NextAuth.js (stub in Phase 1) |
| `NEXTAUTH_URL` | No | URL for NextAuth.js (stub in Phase 1) |

## First-Run Flow

To get started with Mission Control:

1. **Configure repos**: Set `GITHUB_REPOSITORIES` env var (comma or newline separated) _or_ add tracked repos via the UI after boot. `GITHUB_REPOSITORIES` is a **one-time bootstrap seed** — it is read only when the tracked-repos table is empty. Once any repo exists (seeded or added via UI), the env var is not consulted again, so updates must go through the UI or API (`POST /api/repos` / `POST /api/automation/repos`). Env-seeded repos are tagged `source: "env"` and shown with a `seed` badge in `/automation`; user-added repos are tagged `source: "user"`.
2. **Deploy** with your database and GitHub token configured.
3. **Sync automation data**: `POST /api/automation/sync` (or use the Sync button on the Automation page).
4. **Sync issues**: `POST /api/sync` (or use the Sync Issues action in the board UI). OpenClaw agent heartbeats also trigger best-effort issue sync automatically.
5. **View results**: The Kanban Board shows synced issues; the Projects view groups them by repository.

Production database migrations (`prisma migrate deploy`) run automatically on container startup — no manual intervention needed.

## Security

Mission Control is designed as an **internal-only** application. It does not include public-facing authentication in Phase 1 (NextAuth.js is a stub for local development). The app remains internal unless external auth integration (e.g., OIDC/Authentik) is added later.

Ensure it is only accessible within your trusted network via ingress rules.

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
   - Columns: Backlog, In Progress, In Review, Done
   - Drag-and-drop between columns updates GitHub labels
   - Audit log entry on every mutation
   - Visible error on GitHub mutation failure

4. **Filtering**
   - Filter by repo, agent, owner, project, priority

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
   - Dockerfile for app
   - Kubernetes manifests (bjw-s/app-template style)
   - ExternalSecret placeholders for all secrets
   - Internal-only ingress

### Intentionally Not Included in Phase 1

- GitHub Projects integration
- Full OIDC/Authentik authentication (stub for local dev only)
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

Mission Control uses Prisma with PostgreSQL. Migrations are used for production; `db push` is for local development only.

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

The app uses the bjw-s/app-template Helm chart. See `home-ops/kubernetes/apps/base/llm/mission-control/` for manifests.

Required secrets (via ExternalSecret):
- `MISSION_CONTROL_DATABASE_URL` - PostgreSQL connection string
- `GITHUB_TOKEN` - GitHub authentication
- `MISSION_CONTROL_AGENT_TOKEN` - Agent API bearer token

## API Endpoints

### GET /api/issues
List cached issues. Query params: `repo`, `agent`, `owner`, `project`, `priority`

### POST /api/issues/move
Move issue between status columns. Body: `{ issueId, repoFullName, issueNumber, oldLabels, newLabels }`

### GET /api/repos
List configured repositories (board/issue-sync view; `Repository` rows).

### POST /api/repos
Add a tracked repository. Body: `{ fullName: "owner/repo" }`. Creates an `AutomationRepo` row with `source: "user"` (canonical tracked-repos list) **and** a mirror `Repository` row so the board sees it immediately. Returns 409 if the repo is already tracked. Writes an `add_tracked_repo` AuditLog entry.

### POST /api/automation/repos
Same shape and semantics as `POST /api/repos` but scoped to the automation surface. Used by the `/automation` Add Repo button.

### DELETE /api/automation/repos/[repo]
Stop tracking a repository. `[repo]` is the URL-encoded `owner/repo` fullName. Hard-deletes the `AutomationRepo` row (cascading workflow/run/release history) and soft-disables the mirror `Repository` row (`enabled = false`) so cached issues remain visible for history but are excluded from active board filters. Writes a `remove_tracked_repo` AuditLog entry.

### POST /api/sync
Sync all issues from configured repositories. Intended callers are:

- the board UI's manual **Sync Issues** action
- openclaw agent heartbeat best-effort cache refresh (see Scheduled Issue Sync Strategy below)

### GET /api/agent-runs
List agent runs. Query params: `limit`

### POST /api/agent-runs
Create agent run. Requires `MISSION_CONTROL_AGENT_TOKEN` bearer auth.

### GET /api/audit
List audit logs. Query params: `limit`, `repo`

**Note: Issue sync and automation sync are separate concerns.**
- **Issue sync** (`POST /api/sync`) refreshes GitHub issues into the Kanban board. It is heartbeat-driven (best-effort via openclaw agent) or manual via UI.
- **Automation sync** (`POST /api/automation/sync`) refreshes CI/CD, workflow runs, releases, and packages data. It is managed independently on the Automation page.
- Each sync operates on its own data models and caching layer.

## Automation Section

Mission Control includes an Automation section that discovers and visualizes CI/CD, builds, tests, security scans, releases, and scheduled workflows from GitHub repositories.

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

Run this checklist before pointing an OpenClaw agent at Mission Control as its task-visibility layer (instead of a GitHub Project board). Every step should pass; stop and investigate on the first failure.

Set `BASE` to your Mission Control URL (e.g. `BASE=https://mission-control.internal`) before running.

| # | Check | Expected |
|---|-------|----------|
| 1 | `curl -fsS "$BASE/api/health"` | `{"ok":true,"database":"ok",...}` |
| 2 | `curl -fsS -X POST "$BASE/api/automation/sync"` | 2xx, no error body |
| 3 | `curl -fsS "$BASE/api/automation/repos"` | JSON array, non-empty if repos are configured |
| 4 | `curl -fsS -X POST "$BASE/api/sync"` | `syncedCount > 0` |
| 5 | `curl -fsS "$BASE/api/issues"` | JSON array, length > 0 |
| 6 | Open `/board` in a browser | Issues render — no "no issues synced yet" empty state |
| 7 | Open `/projects` | Repo groups render |
| 8 | Open `/agents` | Recent OpenClaw agent heartbeat visible with agent name |
| 9 | Move a low-risk test issue between columns | GitHub label changes; AuditLog row appears in `GET /api/audit` |
| 10 | `kubectl logs -n <ns> <pod>` (or equivalent) | No Prisma / BigInt / FK errors |

Only flip the agent's workflow over once all ten steps pass.

## Scheduled Issue Sync Strategy

Mission Control keeps GitHub as the source of truth and stores issues only as a local cache. Cache freshness is owned by **openclaw agent heartbeat sync** rather than by a Mission Control background worker or new cluster CronJob.

Decision:
- At the start of each openclaw agent heartbeat, the agent should make a best-effort `POST` request to Mission Control's `/api/sync` endpoint.
- The request must be non-blocking for heartbeat work: log/report a warning if the sync fails or times out, then continue the heartbeat.
- Manual UI sync remains supported for immediate refreshes and troubleshooting.

Rationale:
- Reuses the existing heartbeat that already reports to Mission Control, so no new Kubernetes manifests, images, queues, or background scheduler are required.
- Keeps cache freshness close to the agent workflow that consumes the board.
- Preserves Mission Control's simple app model: it serves API/UI requests and does not need long-running in-process scheduling state.

Rejected alternatives for the first implementation:
- **Kubernetes CronJob**: valid later if heartbeat-driven sync is too sparse, but it adds deployment and auth plumbing for little immediate benefit.
- **Mission Control internal scheduler**: would couple cache freshness to app process lifetime and introduces timer/queue behavior that Phase 1 intentionally avoids.

Operational notes:
- Configure the openclaw agent with `MISSION_CONTROL_URL` and any required network access to reach Mission Control.
- `/api/sync` currently does not require `MISSION_CONTROL_AGENT_TOKEN`; if auth is added later, update the heartbeat caller and this section together.
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

The Mission Control Docker image is built and published via GitHub Actions CI/CD.

### Image Name

```
ghcr.io/misospace/mission-control
```

### Workflow

`.github/workflows/image.yaml` - Build Mission Control Image

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

# Via web: Actions > Build Mission Control Image > Run workflow
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
    - image: ghcr.io/misospace/mission-control:main
```

The image tag `main` is updated on each push to the `main` branch via the CI workflow.

### Local Development Image Build

```bash
# Build locally
docker build -t ghcr.io/misospace/mission-control:local .

# Run locally
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e GITHUB_TOKEN="ghp_..." \
  -e MISSION_CONTROL_AGENT_TOKEN="..." \
  ghcr.io/misospace/mission-control:local
```
