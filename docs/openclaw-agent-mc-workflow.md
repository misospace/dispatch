# OpenClaw Agent — Dispatch Phase 1 Workflow Contract

> **⚠️ HISTORICAL** — This document describes pre-cutover Phase 1 workflow.
> The cutover is complete. See [docs/worker-execution-contract.md](./worker-execution-contract.md) for the current canonical worker contract.
>
> **Issue:** [misospace/dispatch#53](https://github.com/misospace/dispatch/issues/53)
> **Date:** 2026-05-15

---

This document defines the operational contract between an OpenClaw agent and Dispatch during Phase 1 of the migration from GitHub Projects to Dispatch-backed visibility.

## Overview

The OpenClaw agent gradually moves from GitHub Projects grooming to Dispatch as the task visibility layer. During this period:

- **GitHub Issues and PRs remain the source of truth.** Dispatch's Postgres database is a cache, not authoritative storage.
- **GitHub Projects board is deprecated for this workflow** — group by repository instead.
- All Dispatch interactions are **best-effort**; failures must never break the agent heartbeat.
- General cache freshness is owned by Dispatch's scheduled sync runner (`POST /api/sync/scheduled`). Agent heartbeats may still call `POST /api/sync` for best-effort freshness, but they are no longer the primary freshness mechanism.

## Heartbeat Lifecycle

### Start of Heartbeat (Best-Effort Sync)

```
POST /api/sync
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
```

- **Purpose:** Refresh Dispatch's issue cache before selecting work (best-effort).
- **Auth:** Bearer token required (maintainer tier).
- **Expected response:** `{ syncedCount: N }` (N may be 0 if no repos configured).
- **Failure handling:** Treat any non-2xx, timeout, or network error as a freshness warning — log it and continue. **Do not fail the heartbeat on a sync failure.**

> **Note:** General cache freshness is now owned by the scheduled sync runner (`POST /api/sync/scheduled`), which runs on a regular cadence (recommended: every 10–30 minutes). Agent heartbeats may still call `POST /api/sync` for best-effort freshness, but they should not rely on it as the primary freshness mechanism.

### End of Heartbeat

```
POST /api/agent-runs
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
Content-Type: application/json
```

**Request body:**

```json
{
  "agentName": "openclaw-agent",
  "runType": "heartbeat",
  "status": "completed",
  "startedAt": "2026-05-15T13:44:00.000Z",
  "finishedAt": "2026-05-15T13:47:00.000Z",
  "summary": "Processed 3 issues, opened 1 PR",
  "touchedIssueUrls": [
    "https://github.com/misospace/dispatch/pull/74",
    "https://github.com/misospace/miso-gallery/issues/143"
  ]
}
```

**Required fields:** `agentName`, `runType`, `status`, `startedAt`
**Optional fields:** `finishedAt`, `summary`, `errorMessage`, `touchedIssueUrls`, `issueId`
**Response:** 201 with the created run object.

### Reading Work

```
GET /api/issues
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
```

- **Purpose:** Fetch the current issue list for the agent to select work from.
- **Auth:** Bearer token required (worker or maintainer tier).
- **Expected response:** Array of issue objects.
- **Selection priority:**
  1. Prefer issues labeled `agent/<agent-id>` if present (e.g. `agent/saffron`, `agent/matcha`).
  2. Fall back to general backlog if no agent-specific label exists.
  3. Treat "no status label" or `status/backlog` as backlog work — both are valid entry states.

## Source of Truth Rules

| Rule | Detail |
|------|--------|
| GitHub is authoritative | Issues and PRs on GitHub are the single source of truth. Dispatch's Postgres is a cache. |
| No direct DB writes | Never query or write to the Postgres cache directly — use the API. |
| No auto-close | Do not auto-close issues without explicit evidence of completion (green pipeline, merged PR, or human approval). |
| No GitHub Projects reliance | The Projects board is deprecated for this workflow. Group by repository instead. |

## Security Constraints

| Constraint | Detail |
|------------|--------|
| Never log `DISPATCH_AGENT_TOKEN` | Tokens must never be logged, echoed, or persisted to disk. |
| Never log `GITHUB_TOKEN` | Same constraint applies to GitHub tokens. |
| Audit trail required | Every state-changing move on Dispatch produces an `AuditLog` row. Operators trace agent activity through `/api/audit`. |

## Failure Modes

All Dispatch interactions are best-effort from the heartbeat's perspective:

1. **Sync failure** → Log warning, continue heartbeat.
2. **Agent-run POST failure** → Log warning, continue. The run record is a visibility aid, not a gating dependency.
3. **Issue read failure** → Fall back to GitHub Issues API directly.
4. **Health check failure** → If `/api/health` returns `{ ok: false }` with 503, the database may be unreachable but Dispatch itself is still responsive.

## Pre-Cutover Validation

Before the OpenClaw agent stops grooming GitHub Projects and fully adopts Dispatch, run the [smoke checklist](./smoke-checklist.md). The checklist documents 14 verification steps covering health, sync, repos, issues, board UI, projects UI, agent runs, queue, claim/unclaim lifecycle, audit trail, log errors, and failure resilience. All checks must pass (or be explicitly skipped with documented reason) before trusting Dispatch for assignment decisions.

## API Reference Summary

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/health` | GET | None | Health check — `{ ok: true, database: "ok" }` |
| `/api/sync` | POST | Bearer (maintainer) | Trigger issue sync from GitHub (best-effort) |
| `/api/sync/scheduled` | POST | Bearer (maintainer) | Scheduled sync runner — primary freshness mechanism |
| `/api/issues` | GET | Bearer (worker or maintainer) | List all issues in Dispatch cache |
| `/api/agents/<name>/queue` | GET | Bearer (worker or maintainer) | Agent-specific issue queue |
| `/api/issues/claim` | POST | Bearer (worker; `force` requires maintainer) | Claim an issue (adds agent label) |
| `/api/issues/unclaim` | POST | Bearer (worker or maintainer) | Release an issue (removes agent label) |
| `/api/issues/actions` | POST | Bearer (maintainer) | Assign/unassign agent or owner labels |
| `/api/issues/unassign` | POST | Bearer (maintainer) | Remove all agent/owner labels of a type |
| `/api/issues/move` | POST | Bearer (maintainer) | Move an issue on the board (writes audit log) |
| `/api/agent-runs` | GET | Bearer (maintainer) | List recent agent runs |
| `/api/agent-runs` | POST | Bearer (maintainer) | Submit a new agent run record |
| `/api/agents/{name}/heartbeat` | POST | Bearer (worker or maintainer) | Internal sync/reconcile pass |
| `/api/automation/repos` | GET | Bearer (maintainer) | List tracked repositories |
| `/api/audit` | GET | Bearer (maintainer) | Query audit log entries |

**Tiers:** `worker` = `DISPATCH_WORKER_TOKEN`; `maintainer` = `DISPATCH_AGENT_TOKEN` (or the `DISPATCH_MAINTAINER_TOKEN` alias). A worker token calling a maintainer-tier route gets `403`. The authoritative allowlist is `WORKER_ALLOWLIST` in `src/lib/auth.ts` — see [Token Tiers](./worker-execution-contract.md#token-tiers). Every row above is guarded by `authorizeRequest` except `/api/health`, the only unguarded endpoint in this table.

## Worker Execution Contract

For the detailed worker execution contract (PR fix queue precedence, duplicate PR avoidance, hard completion gates, branch naming conventions, failure response format), see [docs/worker-execution-contract.md](./worker-execution-contract.md). This supersedes ad-hoc behavior and applies to all agent workers.

## Migration Timeline

```
Phase 1 (now)          → Document workflow, run smoke checklist, dual-track with GitHub Projects
Phase 2 (after cutover) → Stop grooming GitHub Projects, Dispatch is primary visibility
Phase 3 (future)       → Evaluate whether GitHub Projects board can be fully retired
```

## History

- **2026-05-19** — Updated to reflect that scheduled sync (`POST /api/sync/scheduled`) is now the primary freshness mechanism. Agent heartbeats may still call `POST /api/sync` for best-effort freshness, but are no longer responsible for general cache freshness.
- **2026-05-15** — Created as part of OpenClaw agent Phase 1 pre-cutover validation (Issue #53). Consolidates workflow contract from AGENTS.md and smoke checklist into a single operational reference.
