# AGENTS.md

## Mission Control Overview

Mission Control is a self-hosted Next.js/TypeScript dashboard that visualizes GitHub issues and agent activity. It uses Prisma with PostgreSQL as its database.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Database**: PostgreSQL via Prisma ORM
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

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token |
| `MISSION_CONTROL_AGENT_TOKEN` | Yes | Bearer token for agent API |
| `GITHUB_REPOSITORIES` | Yes | Bootstrap seed config for tracked repos (comma or newline separated). Also managed via UI/API after boot. |
| `NEXTAUTH_SECRET` | No | NextAuth.js secret |
| `NEXTAUTH_URL` | No | NextAuth.js URL |

### Label Conventions

Labels follow a `category/value` pattern:

- **Status**: `status/backlog`, `status/in-progress`, `status/in-review`, `status/done`
- **Owner**: `owner/*` (e.g., `owner/alice`)
- **Agent**: `agent/*` (e.g., `agent/alpha`)
- **Project**: `project/*` (e.g., `project/k8s`)
- **Note:** `project/*` labels are **optional** and not required for the Projects view. Projects groups issues by repository by default.
- **Priority**: `priority/p0` through `priority/p3`
- **Type**: `type/bug`, `type/feature`, `type/chore`, `type/research`, `type/security`

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

- Base image: `node:20-bookworm-slim`
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
      issues/      # Issue listing and movement
      repos/       # Repository config
      sync/        # Issue sync
      audit/       # Audit log
      health/      # Health check endpoint
    automation/    # Automation UI pages
    board/         # Kanban board
    projects/      # Project view
    agents/        # Agent activity page
  lib/
    prisma.ts      # Prisma client singleton
    github.ts      # GitHub API helpers
```

## Health Endpoint

`GET /api/health` returns:
```json
{
  "ok": true,
  "database": "ok",
  "version": "0.1.1"
}
```

Returns 503 if database is unreachable.