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
- `project/*` - Issue belongs to a project (e.g., `project/k8s`, `project/web`)

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
| `GITHUB_REPOSITORIES` | Yes | Comma-separated list of repos to track for automation visibility (e.g., `misospace/windowstead,misospace/miso-chat`) |
| `NEXTAUTH_SECRET` | No | Secret for NextAuth.js (stub in Phase 1) |
| `NEXTAUTH_URL` | No | URL for NextAuth.js (stub in Phase 1) |

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
   - Group issues by `project/*` labels
   - Show issues by status per project

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

## Database Setup

Mission Control uses Prisma with PostgreSQL. The current schema does not have migrations yet (as of v0.1.1).

### Local Development
- Use `npm run db:push` to apply schema changes without migrations.

### Production Deployment
- Once migrations are added, use `npm run db:deploy` to apply migrations in production.
- For v0.1.1 initial deploy, `npm run db:push` is still acceptable since no migrations exist.

```bash
# For production with migrations:
npm run db:deploy

# For initial v0.1.1 deploy (no migrations yet):
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
List configured repositories

### POST /api/repos
Add a repository. Body: `{ fullName: "owner/repo" }`

### POST /api/sync
Sync all issues from configured repositories

### GET /api/agent-runs
List agent runs. Query params: `limit`

### POST /api/agent-runs
Create agent run. Requires `MISSION_CONTROL_AGENT_TOKEN` bearer auth.

### GET /api/audit
List audit logs. Query params: `limit`, `repo`

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
| `GITHUB_REPOSITORIES` | Yes | Comma-separated list of repos to track (e.g., `misospace/windowstead,misospace/miso-chat,misospace/miso-gallery`) |

### Screens Added

1. **Automation Overview** (`/automation`)
   - One card per tracked repo
   - Shows: repo name, default branch, latest commit SHA, workflow status, failing/running counts, latest release, open PR count
   - Sync button to refresh data
   - Link to GitHub repo

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

### Known Limitations

1. **No workflow YAML parsing**: Trigger types (push, PR, schedule, manual) are not parsed from workflow files. GitHub shows workflow state (active/inactive) but not trigger configuration.
2. **No branch-specific runs**: Only the most recent runs per workflow are fetched, not runs across all branches historically.
3. **No check runs/check suites**: Job-level visibility is limited to Actions jobs; separate status checks from other integrations are not fetched.
4. **No Secrets scanning**: Secret detection results from GitHub's secret scanning are not fetched (requires additional API endpoint).
5. **Package visibility**: GitHub packages require the user to have appropriate permissions to view; private packages may not be visible.
6. **No automatic sync**: Sync is manual-triggered via API; no webhook receiver for real-time updates.
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
9. **Scheduled sync** via cron or background job

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