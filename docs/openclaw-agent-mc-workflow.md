# OpenClaw Agent — Mission Control Phase 1 Workflow Contract

> **Status:** Pre-cutover documentation
> **Issue:** [misospace/mission-control#53](https://github.com/misospace/mission-control/issues/53)
> **Date:** 2026-05-15

This document defines the operational contract between an OpenClaw agent and Mission Control during Phase 1 of the migration from GitHub Projects to Mission Control-backed visibility.

## Overview

The OpenClaw agent gradually moves from GitHub Projects grooming to Mission Control as the task visibility layer. During this period:

- **GitHub Issues and PRs remain the source of truth.** Mission Control's Postgres database is a cache, not authoritative storage.
- **GitHub Projects board is deprecated for this workflow** — group by repository instead.
- All Mission Control interactions are **best-effort**; failures must never break the agent heartbeat.

## Heartbeat Lifecycle

### Start of Heartbeat

```
POST /api/sync
```

- **Purpose:** Refresh Mission Control's issue cache before selecting work.
- **Auth:** None required.
- **Expected response:** `{ syncedCount: N }` (N may be 0 if no repos configured).
- **Failure handling:** Treat any non-2xx, timeout, or network error as a freshness warning — log it and continue. **Do not fail the heartbeat on a sync failure.**

### End of Heartbeat

```
POST /api/agent-runs
Authorization: Bearer <MISSION_CONTROL_AGENT_TOKEN>
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
    "https://github.com/misospace/mission-control/pull/74",
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
```

- **Purpose:** Fetch the current issue list for the agent to select work from.
- **Auth:** None required.
- **Expected response:** Array of issue objects.
- **Selection priority:**
  1. Prefer issues labeled `agent/<agent-id>` if present (e.g. `agent/saffron`, `agent/matcha`).
  2. Fall back to general backlog if no agent-specific label exists.
  3. Treat "no status label" or `status/backlog` as backlog work — both are valid entry states.

## Source of Truth Rules

| Rule | Detail |
|------|--------|
| GitHub is authoritative | Issues and PRs on GitHub are the single source of truth. Mission Control's Postgres is a cache. |
| No direct DB writes | Never query or write to the Postgres cache directly — use the API. |
| No auto-close | Do not auto-close issues without explicit evidence of completion (green pipeline, merged PR, or human approval). |
| No GitHub Projects reliance | The Projects board is deprecated for this workflow. Group by repository instead. |

## Security Constraints

| Constraint | Detail |
|------------|--------|
| Never log `MISSION_CONTROL_AGENT_TOKEN` | Tokens must never be logged, echoed, or persisted to disk. |
| Never log `GITHUB_TOKEN` | Same constraint applies to GitHub tokens. |
| Audit trail required | Every state-changing move on Mission Control produces an `AuditLog` row. Operators trace agent activity through `/api/audit`. |

## Failure Modes

All Mission Control interactions are best-effort from the heartbeat's perspective:

1. **Sync failure** → Log warning, continue heartbeat.
2. **Agent-run POST failure** → Log warning, continue. The run record is a visibility aid, not a gating dependency.
3. **Issue read failure** → Fall back to GitHub Issues API directly.
4. **Health check failure** → If `/api/health` returns `{ ok: false }` with 503, the database may be unreachable but Mission Control itself is still responsive.

## Pre-Cutover Validation

Before the OpenClaw agent stops grooming GitHub Projects and fully adopts Mission Control, run the [smoke checklist](./smoke-checklist.md):

```bash
# Against local dev instance
node scripts/smoke-checklist.mjs http://localhost:3000

# Against staging/prod
node/scripts/smoke-checklist.mjs https://mc.example.com
```

All 11 checks in the smoke checklist must pass (or be explicitly skipped with justification) before proceeding with cutover.

## API Reference Summary

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/health` | GET | None | Health check — `{ ok: true, database: "ok" }` |
| `/api/sync` | POST | None | Trigger issue sync from GitHub |
| `/api/issues` | GET | None | List all issues in Mission Control cache |
| `/api/agent-runs` | GET | None | List recent agent runs |
| `/api/agent-runs` | POST | Bearer token | Submit a new agent run record |
| `/api/issues/move` | POST | Bearer token (for agents) | Move an issue on the board (writes audit log) |
| `/api/automation/repos` | GET | None | List tracked repositories |
| `/api/audit` | GET | None | Query audit log entries |

## Migration Timeline

```
Phase 1 (now)          → Document workflow, run smoke checklist, dual-track with GitHub Projects
Phase 2 (after cutover) → Stop grooming GitHub Projects, Mission Control is primary visibility
Phase 3 (future)       → Evaluate whether GitHub Projects board can be fully retired
```

## History

- **2026-05-15** — Created as part of OpenClaw agent Phase 1 pre-cutover validation (Issue #53). Consolidates workflow contract from AGENTS.md and smoke checklist into a single operational reference.