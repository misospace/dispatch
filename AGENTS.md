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
mise run bootstrap   # Pinned Node + deps + Prisma client (idempotent; no DATABASE_URL, no migrations, no git hooks)
mise run check       # Lint + typecheck (mirrors CI jobs)
mise run test        # Vitest suite
npm install          # Install dependencies (runs `prisma generate` via postinstall)
npm run dev          # Start development server
npm run build        # Production build
npm run lint         # Lint check
npm run typecheck    # TypeScript check
npm run db:generate  # Regenerate Prisma client (also runs on postinstall; re-run after editing schema.prisma)
npm run db:push      # Push schema (dev)
npm run db:deploy    # Deploy migrations (prod)
```

`.mise/config.toml` + `.mise/mise.lock` are the repository development-bootstrap contract
(Courier #414): Node is the pinned runtime tool, `bootstrap`/`check`/`test` are the shared task
names, and `check`/`test` delegate to the authoritative `npm run` commands. Do not add
git-hook installation, migrations, DATABASE_URL requirements, or test execution to `bootstrap`.

## Important Conventions

### Environment Variables

#### Preferred (v0.2.1+)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (canonical) |
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token |
| `DISPATCH_AGENT_TOKEN` | Yes | Bearer token for agent API (maintainer tier — full rights) |
| `DISPATCH_MAINTAINER_TOKEN` | No | Optional alias for the maintainer-tier bearer token (same rights as `DISPATCH_AGENT_TOKEN`) |
| `DISPATCH_WORKER_TOKEN` | No | Legacy **unbound** worker-tier bearer token. Explicit allowlist: next-task, tasks/report, heartbeat, active-work, queue, work-summary, agent-work start/checkpoint/finish + GET listing, non-force claim / unclaim, issue state/status, PR-fix queue reads + FIXED/BLOCKED/STALE marks, PR-fix hand-out ack. It carries **no agent identity**: identity-scoped routes (all `/api/agents/{agentName}/*`, agent-work start/checkpoint/finish + GET, claim/unclaim, status) now require a bound credential from `DISPATCH_WORKER_TOKENS` and return 403 for this token; it remains a migration-window fallback for identity-free routes (issue listing, PR-fix reads/marks) and logs a deprecation warning at boot. A value duplicating a maintainer token resolves to worker tier (fail-closed). |
| `DISPATCH_WORKER_TOKENS` | No | **Bound** worker credentials, comma/newline-separated `agentName:token` pairs. Each token authenticates as exactly that agent; the caller's identity is derived from the token, never from `x-agent-name` or a request-body `agentName`. A bound worker may only read/report/poll/start/checkpoint/finish/claim/unclaim/set-status for its own agent (status is additionally scoped to issues assigned to it); a token bound to two different agents is rejected (fail-closed). Multiple tokens per agent support rotation. Agent-work operator release/reassign and sweep stay maintainer-only. |
| `GITHUB_REPOSITORIES` | Yes | **One-time** bootstrap seed for tracked repos (comma or newline separated). Read only when `AutomationRepo` is empty. After first seed, manage via `/automation` UI or `POST /api/automation/repos`. Seeded repos carry `source: "env"`; UI-added repos carry `source: "user"`. |
| `DISPATCH_URL` | No | Base URL of your Dispatch instance (used by outbound clients and MCP bridge) |
| `DISPATCH_DATABASE_URL` | No | Alternative database URL alias — used if `DATABASE_URL` is not set |
| `NEXTAUTH_SECRET` | No | NextAuth.js secret |
| `NEXTAUTH_URL` | No | NextAuth.js URL |
| `DISPATCH_SCHEDULER_ENABLED` | No | `true` runs periodic jobs (sync, groomer, PR-followup, prune-closed) in-process instead of via external cronjobs. Off by default. Confine to a single replica. |
| `DISPATCH_SYNC_INTERVAL_MS` | No | Scheduled-sync interval when the scheduler is enabled (default 900000 = 15m; `0` disables the job) |
| `DISPATCH_GROOMER_INTERVAL_MS` | No | Groomer run interval (default 600000 = 10m; `0` disables) |
| `DISPATCH_PR_FOLLOWUP_INTERVAL_MS` | No | PR-followup sync interval (default 900000 = 15m; `0` disables) |
| `DISPATCH_PRUNE_CLOSED_INTERVAL_MS` | No | Closed-issue prune interval (default 86400000 = 24h; `0` disables) |
| `DISPATCH_CAPACITY_COOLDOWN_MS` | No | Bounded cooldown for explicit capacity-exhaustion handoffs (default 900000 = 15m, clamped 1m–6h). Scoped to the exhausted capacity on the handed item only; unrelated capacities keep dispatch. See [docs/capacity-handoff.md](./docs/capacity-handoff.md) |
| `DISPATCH_OWNERSHIP_ACTIVE_WINDOW_MS` | No | Ownership liveness window (#1251): renewals inside it keep a claim `CLAIMED_ACTIVE` (default 900000 = 15m, clamped 1m–6h). See [docs/worker-ownership-capability.md](./docs/worker-ownership-capability.md) |
| `DISPATCH_OWNERSHIP_LONG_RUN_GRACE_MS` | No | Long-run grace (#1251): sustained silence inside it is `CLAIMED_LONG_RUNNING`, never release (default 2700000 = 45m, clamped ≥ active window, ≤24h) |
| `DISPATCH_OWNERSHIP_RENEW_TTL_MS` | No | Expiry a renewed lease receives (#1251) (default 1800000 = 30m, clamped 1m–24h) |
| `DISPATCH_OWNERSHIP_RECONCILE_MODE` | No | Ownership reconciler (#1254): `off` (default — starts no new release, but still settles intents committed before the mode change), `audit` (annotate ladder candidates only — zero forge writes, zero release mutations, no replay either) or `enforce` (release confirmed-abandoned claims through the §8.7 two-sided intent protocol). Runs in the stale-work scheduler slot. |
| `DISPATCH_RECONCILE_MAX_RECLAIMS` | No | Per-claim reclaim counter cap (#1254); on exhaustion the claim parks as needs-human instead of churning (default 3, clamped 1–10). |
| `DISPATCH_RECONCILE_BATCH_SIZE` | No | Candidates examined per reconcile pass (#1254 per-run quota) (default 25, clamped 1–200). |
| `DISPATCH_RECONCILE_RECHECK_INTERVAL_MS` | No | Separation between the two confirmation observations of the ladder (#1254 §8.2) (default 300000 = 5m, clamped 1m–24h). |
| `DISPATCH_RECONCILE_RECLAIM_COOLDOWN_MS` | No | Minimum spacing between release attempts on the same claim (#1254 §8.3) (default = the re-check interval, clamped 0–24h). |
| `DISPATCH_RECONCILE_MAX_FORGE_RETRIES` | No | Bounded Phase-B forge retries before a pending release intent parks for the operator (#1254 §8.7 fail-closed) (default 5, clamped 1–20). |
| `DISPATCH_RECONCILE_ANNOTATION_REEMIT_MS` | No | Re-emit window for the reconciler's per-pass audit annotations (#1363): a per-candidate annotation identical to the candidate's latest one is suppressed until the window elapses, then re-emitted once as a fresh confirmation; state, ladder and label changes are always annotated (default 86400000 = 24h, clamped 1m–7d). |
| `DISPATCH_GITHUB_TIMEOUT_MS` | No | Hard per-attempt timeout on every GitHub REST request (#1347), plus a capped retry backoff — the enforced premise of the guard-override silence fence and the reconciler's commit-time re-checks (default 30000, floored at 1000). |
| `DISPATCH_REBASE_AGENTS` | No | Comma or whitespace separated agent names (case-insensitive) eligible for `REBASE` lane hand-outs (#1327) — the operator-declared local-only worker pool. An agent outside the pool defers the candidate (item stays QUEUED for an eligible poller). FAIL CLOSED by default: unset or empty admits no agent and the lane stops dispatching until the operator names workers; a bare `*` value is the explicit unrestricted opt-in (debugging/backcompat). |
| `DISPATCH_QUEUE_ADMISSION_MODE` | No | Grooming freshness admission for worker pickup: `off` (default, unchanged), `audit` (annotate queue items, filter nothing) or `enforce` (withhold ready issues without a current applied grooming decision or operator override). See [docs/hosted-groomer.md](./docs/hosted-groomer.md#worker-admission). |
| `DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS` | No | Age threshold for the read-only `GET /api/observability` snapshot (#1252): known-age `agent/*` assignments with no observed Lease/AgentWork execution past this age count as aged un-picked-up (default 1800000 = 30m, clamped 1m–24h). Assignments without persisted age evidence stay `unknown` and are never reported aged. See [docs/observability-snapshot.md](./docs/observability-snapshot.md). |
| `DISPATCH_METRICS_ENABLED` | No | Opt-in Prometheus text exposition of the observability catalogue at `GET /api/metrics` (#1255): strict `=== "true"`, default off (404 while disabled). Read-only, maintainer tier only. See [docs/observability-packaging.md](./docs/observability-packaging.md). |

Resolution order: `DATABASE_URL` > `DISPATCH_DATABASE_URL`. `DISPATCH_AGENT_TOKEN` for agent API bearer auth.

### Label Conventions

Labels follow a `category/value` pattern:

- **Status**: `status/backlog`, `status/ready`, `status/in-progress`, `status/in-review`, `status/blocked`, `status/done`
- **Owner**: `owner/*` (e.g., `owner/alice`); Board owner filtering is label-based and does not use GitHub assignees
- **Agent**: `agent/*` (e.g., `agent/alpha`); Board agent filtering is label-based and does not use AgentRun names, configured agents, or GitHub assignees
- **Project**: `project/*` (e.g., `project/k8s`)
- **Note:** `project/*` labels are **optional** and not required for the Projects view. Projects groups issues by repository by default.
- **Priority**: `priority/p0` through `priority/p3`
- **Type**: `type/bug`, `type/feature`, `type/chore`, `type/research`, `type/security`

#### Label hygiene

`.github/labels.yaml` is the source of truth for managed labels. The label-sync
workflow (`.github/workflows/label-sync.yaml`) keeps the repo in sync with it.

- **Umbrella labels are allowed; per-attempt / per-model variants are not.**
  `blocked/infra` is the single managed label for infrastructure-blocked work.
  Do NOT create `blocked/infra-attempt/<N>` or `blocked/infra-model/<name>`
  labels: an external emitter (bridge / pr-followup path) used to write a fresh
  one per failed GHA attempt, accumulating ~95 dead labels that polluted every
  kanban label filter, repo add-label call, and audit view (#916).
- The label-sync workflow prunes exactly the `blocked/infra-attempt/*` and
  `blocked/infra-model/*` shapes (on push to main touching the label files and
  on a weekly schedule) and keeps the `blocked/infra` umbrella.
- If you need to distinguish infra failure modes, encode them in the issue
  body / audit log, not in a new label. A single repo failure mode does not
  need N unique identifiers.


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
- Grooming admission (`DISPATCH_QUEUE_ADMISSION_MODE`, #1065): in `audit`/`enforce` each issue item carries an `admission` decision with machine-readable reason codes; in `enforce` withheld ready issues are left out (`?includeWithheld=true` lists them with `claimable: false`). PR-fix items are never gated. Operators admit an issue explicitly with `POST /api/issues/[issueId]/admission-override` (`DELETE` clears it); operator auth only (OIDC, basic, or auth disabled), agent bearer tokens get 403. A bare `status/ready` label is not an override.

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
    api/
      agents/[agentName]/   # next-task, tasks/report, queue, heartbeat, active-work
      agent-work/           # start, checkpoint, finish, operator release
      agent-runs/           # legacy run ingestion
      audit/                # audit log read
      automation/           # sync, runs, workflows, events, repos
      health/               # health check
      issues/               # listing, move, claim, unclaim, unassign, status, groom, lane, actions, reconcile, refresh, prune-closed, untriaged, webhook
      observability/        # read-only standalone signal snapshot (#1252)
      pr-fix-queue/         # enqueue, queued, mark
      pr-followup/          # sync, webhook
      repos/                # repository config
      sync/                 # issue sync (+ scheduled)
    automation/             # automation UI
    board/                  # Kanban board (page.tsx server, kanban-board-client.tsx client)
    projects/               # project view
    agents/                 # agent activity page
  components/
    kanban-board.tsx        # board DnD context, auto-refresh, move logic
    issue-card.tsx          # card + ⋮ assignment/groom dropdown
    kanban-column.tsx       # droppable column
    filter-bar.tsx          # board filters
  lib/
    prisma.ts               # Prisma client singleton
    github.ts               # GitHub label/comment API helpers
    auth.ts                 # authorizeRequest, getAuthorizedActor (bearer/basic/oidc)
    lease.ts                # Lease TTL, upsert, release, resolveActiveWork
    issue-lifecycle.ts      # IssueLifecycleEvent taxonomy + idempotent recorder
    agent-work.ts           # AgentWork start/checkpoint/finish, stale recovery
    assignment-conflicts.ts # label conflict analysis (agent/owner add/remove)
    kanban.ts               # getIssuesByStatus, getIssueStatus
    client-auth.ts          # authedFetch (browser → API, session-aware)
    version.ts              # version label for header
  types/index.ts            # Issue, StatusLabel, BOARD_COLUMNS, label helpers
```

### Subsystem Map

Cross-cutting concerns and where they live. Read these first when working in that area.

| Concern | Files |
|---|---|
| Issue status movement (board drag) | `components/kanban-board.tsx` (client move), `app/api/issues/move/route.ts` |
| Agent claim / unclaim (lease + status) | `app/api/issues/claim/route.ts`, `app/api/issues/unclaim/route.ts`, `lib/lease.ts` |
| Assign / unassign (label-only, no lease) | `app/api/issues/actions/route.ts`, `app/api/issues/unassign/route.ts`, `lib/assignment-conflicts.ts` |
| AgentWork lifecycle | `app/api/agent-work/route.ts`, `app/api/agent-work/{start,checkpoint,finish}/route.ts`, `lib/agent-work.ts` |
| Fenced capacity handoff (#1256) | `app/api/issues/capacity-handoff/route.ts`, `lib/issue-capacity-handoff.ts`, `lib/capacity-handoff.ts`, `lib/issue-handoff-settlement.ts` (durable replay, #1262), `lib/pr-fix-queue.ts` (report resolver), `lib/lease.ts` (claim token), [docs/capacity-handoff.md](./docs/capacity-handoff.md) |
| Worker ownership capability + derived states (#1251) | `app/api/agent-work/ownership/route.ts` (register/renew/disposition), `lib/worker-ownership.ts`, `lib/ownership-state.ts` (derivation), `lib/ownership-inspect.ts`, `app/api/issues/[issueId]/ownership/` + `app/api/issues/ownership/` (operator inspect), [docs/worker-ownership-capability.md](./docs/worker-ownership-capability.md) |
| Ownership reconciliation + §8.7 release intents (#1254) | `lib/ownership-reconciliation.ts` (ladder + Phase A/B/C + supersede), `OwnershipReleaseIntent`/`OwnershipReconcileCandidate` (schema), claim-route barrier (409 while intent pending) + lease-before-remote-add, [docs/ownership-reconciliation.md](./docs/ownership-reconciliation.md) |
| Auth & audit actor identity | `lib/auth.ts` (`authorizeRequest`, `getAuthorizedActor`) |
| Lifecycle event stream (claim/status evidence, #1202) | `lib/issue-lifecycle.ts`, `docs/issue-lifecycle-events.md` |
| Standalone observability snapshot (#1252) | `app/api/observability/route.ts`, `lib/observability-signals.ts` (pure derivation + allowlists), `lib/observability-snapshot.ts` (read-only collector), `docs/observability-snapshot.md` |
| Board UI component tree | `app/board/page.tsx` → `kanban-board-client.tsx` → `components/kanban-board.tsx` → `components/issue-card.tsx` |
| App shell / header / nav | `app/layout.tsx` |
| Label & status constants | `types/index.ts` (`BOARD_COLUMNS`, `StatusLabel`, `AGENT_PREFIX`, `OWNER_PREFIX`) |

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

The detailed worker API and lifecycle contract lives in
[.agents/skills/dispatch-worker-contract/SKILL.md](.agents/skills/dispatch-worker-contract/SKILL.md).
Load it before changing agent queue, auth, task execution, reporting, or worker
lifecycle behavior. It is normative for those areas.

### Source of Truth

GitHub Issues and PRs remain authoritative; Dispatch's Postgres is a cache, not a replacement source of truth. See the worker-contract skill for the full operational rules.

## Filing issues for the autonomous loop

Issues here are picked up by an autonomous coding loop (dispatch → foreman), and two
parts of the body feed deterministic reviewer rails. Agents filing issues in this repo
must include both.

**1. State the ask in one imperative sentence.** The reviewer quotes it verbatim to
prove it actually read the issue. If it can only paraphrase, its GO is demoted to NO-GO
unless the rail below vouches — costing a revision cycle and an escalation review.

**2. Name the concrete file paths the fix is expected to touch** (backticks are fine).
The scope-overlap rail vouches for a diff that touches a named file, and that vouch is
what survives a paraphrased ask.

Name only paths you are confident about. An issue that names files the diff does *not*
touch is read as scope drift and also gets the change rejected — so when unsure, name
none rather than guessing.
