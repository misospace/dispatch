# Generic Agent Workflow — Dispatch Assignment Layer

> **⚠️ SUPERSEDED** — This document describes the legacy claim/unclaim workflow.
> The canonical agent workflow now uses `GET /api/agents/{name}/next-task` and `POST /api/agents/{name}/tasks/report`.
> See [AGENTS.md](../AGENTS.md) (Agent Workflow Contract) and [docs/generic-harness-loop.md](./generic-harness-loop.md) for current guidance.
>
> **Issue:** [misospace/dispatch#59](https://github.com/misospace/dispatch/issues/59)
> **Date:** 2026-05-16

This document defines the operational workflow for any agent using Dispatch's assignment layer.
It is intentionally generic — no specific agent names or implementations are referenced.

## Overview

Dispatch provides a Postgres-backed cache of GitHub Issues that agents use to discover, claim, and track work.
The cache is refreshed primarily through a **scheduled sync runner** (`POST /api/sync/scheduled`); general cache freshness is owned by Dispatch, not by individual agent heartbeats.

Agent/worker heartbeats may still trigger best-effort sync, but they are no longer the primary freshness mechanism.


### Resumable Work and Next-Action Contract

Dispatch supports resumable agent work through a `nextAction` contract. When an agent resumes from a checkpoint (e.g., after a gateway restart or timeout), Dispatch returns a `nextAction` field that tells the agent exactly what bounded step to perform next — no inference required.

- **Contract doc:** [docs/next-action-contract.md](./next-action-contract.md)
- **Source:** `src/lib/next-action.ts`
- **Tests:** `src/lib/next-action.test.ts` (23 tests)

The contract defines 6 checkpoint values and 9 next-action values, mapped deterministically. Agents should perform exactly one bounded step per run and report back to Dispatch before stopping.

### Five-Column Board Workflow

Dispatch uses a five-column board to manage issue lifecycle:

| Column | Label | Meaning |
|--------|-------|---------|
| Backlog | `status/backlog` | Needs triage/grooming; not yet ready for agents |
| Ready | `status/ready` | Groomed and actionable; available for agents to claim |
| In Progress | `status/in-progress` | Claimed or implementation started |
| In Review | `status/in-review` | PR opened, checks/review pending, issue still open |
| Done | `status/done` | Issue is closed (terminal completion) |

**Agent queue behavior:**
- Agent queues pick from **Ready** by default, not Backlog.
- Backlog issues are excluded from normal agent queues unless explicitly requested.
- Claiming work moves an issue to **In Progress**.
- Opening a PR moves the issue to **In Review**, not Done.
- Agents should never mark an open issue as Done — only closed issues can be Done.

> **GitHub Issues and PRs remain the source of truth.** Dispatch's database is a cache, not authoritative storage.

## Prerequisites

- An agent identity string (e.g. `"agent-name"`). This maps to `agent/agent-name` labels on issues.
- A `DISPATCH_AGENT_TOKEN` environment variable with a valid bearer token for authenticated endpoints.
- The base URL of the Dispatch instance (e.g. `https://dispatch.example.com` or `http://localhost:3000`).

## Complete Workflow

### 1. Start a Run

Before doing any work, start an agent run record. This creates an audit trail entry and enables visibility into agent activity.

```
POST /api/agent-runs
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
Content-Type: application/json
```

**Request body:**

```json
{
  "agentName": "<agent-name>",
  "runType": "heartbeat",
  "status": "in-progress",
  "startedAt": "2026-05-16T05:00:00.000Z"
}
```

**Required fields:** `agentName`, `runType`, `status`, `startedAt`
**Optional fields:** `finishedAt`, `summary`, `errorMessage`, `touchedIssueUrls`, `issueId`

**Response:** `201 Created` with the created run object.

### 2. Sync Issue State (Best-Effort)

Refresh Dispatch's cache of GitHub Issues before selecting work. This fetches the latest issue state from GitHub.

```
POST /api/sync
Content-Type: application/json
```

**Auth:** None required (public endpoint).

**Expected response:** `{ syncedCount: N }` where N is the number of issues synced.

**Failure handling:** Treat any non-2xx, timeout, or network error as a freshness warning — log it and continue. **Do not fail the workflow on a sync failure.**

> **Note:** General cache freshness is now owned by the scheduled sync runner (`POST /api/sync/scheduled`), which runs on a regular cadence (recommended: every 10–30 minutes). Agent heartbeats may still call `POST /api/sync` for best-effort freshness, but they should not rely on it as the primary freshness mechanism.

### 3. Request Agent Queue

Fetch the list of issues actionable for this agent, ranked by priority and status.

```
GET /api/agents/<agent-name>/queue
```

**Auth:** None required (public endpoint).

**Response:** Array of issue objects containing `number`, `title`, `url`, and `labels`.

**Selection priority:**
1. Prefer issues labeled `agent/<agent-name>` if present.
2. Fall back to Ready (groomed, actionable work) for agents to claim.
3. Backlog issues (`status/backlog` or no status label) are excluded from the default agent queue.

Issues with an existing `agent/<other>` label remain visible in the queue so agents can see what others are working on.

### 4. Claim Work

Claim an issue by requesting an agent assignment through Dispatch. This adds an `agent/<name>` label to the issue on GitHub and optionally moves it to `status/in-progress`.

```
POST /api/issues/claim
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
Content-Type: application/json
```

**Request body:**

```json
{
  "issueId": "<mc-issue-id>",
  "repoFullName": "org/repo",
  "issueNumber": 123,
  "agentName": "<agent-name>",
  "force": false
}
```

**Required fields:** `issueId`, `repoFullName`, `issueNumber`, `agentName`
**Optional fields:** `force` (boolean, default `false`)

**Behavior:**
- **Normal claim (`force: false`):** Succeeds if the issue is open and not already assigned to another agent. Adds `agent/<name>` label and sets `status/in-progress`.
- **Force claim (`force: true`):** Removes any existing `agent/<other>` label before adding the new one. Useful for reassignment.
- **Rejected (409):** Issue is already assigned to a different agent and `force` is not set.
- **Rejected (400):** Issue is closed or has `status/done`.

**Response:** `{ success: true, labels: [...] }` on success.

### 5. Report Run Status

When the agent finishes its work cycle, report run status to close out the run record.

```
POST /api/agent-runs
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
Content-Type: application/json
```

**Request body:**

```json
{
  "agentName": "<agent-name>",
  "runType": "heartbeat",
  "status": "completed",
  "startedAt": "2026-05-16T05:00:00.000Z",
  "finishedAt": "2026-05-16T05:30:00.000Z",
  "summary": "Processed 3 issues, opened 1 PR",
  "touchedIssueUrls": [
    "https://github.com/org/repo/issues/123",
    "https://github.com/org/repo/pull/456"
  ]
}
```

**Response:** `201 Created` with the created run object.

### 6. Unclaim Work (Optional)

Release an issue back to the pool when the agent can no longer work on it.

```
POST /api/issues/unclaim
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
Content-Type: application/json
```

**Request body:**

```json
{
  "issueId": "<mc-issue-id>",
  "repoFullName": "org/repo",
  "issueNumber": 123,
  "agentName": "<agent-name>"
}
```

**Required fields:** `issueId`, `repoFullName`, `issueNumber`, `agentName`

**Behavior:**
- Removes the `agent/<name>` label from the issue on GitHub.
- Returns 400 if the agent is not assigned to this issue, or if it's closed/done.

**Response:** `{ success: true, labels: [...] }` on success.

### 7. Move Issue Status (Optional)

Move an issue between board columns by updating its status label.

```
POST /api/issues/move
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
Content-Type: application/json
```

**Auth:** Bearer token required for agents.

This endpoint writes to the audit log and updates both GitHub labels and the local cache.

## Source of Truth Rules

| Rule | Detail |
|------|--------|
| GitHub is authoritative | Issues and PRs on GitHub are the single source of truth. Dispatch's Postgres is a cache. |
| No direct DB writes | Never query or write to the Postgres cache directly — use the API. |
| No auto-close | Do not auto-close issues without explicit evidence of completion (green pipeline, merged PR, or human approval). |

## Security Constraints

| Constraint | Detail |
|------------|--------|
| Never log agent tokens | `DISPATCH_AGENT_TOKEN` must never be logged, echoed, or persisted to disk. |
| Never log GitHub tokens | Same constraint applies to all GitHub authentication tokens. |
| Audit trail required | Every state-changing move on Dispatch produces an `AuditLog` row. Operators trace agent activity through `/api/audit`. |

## Failure Modes

All Dispatch interactions are best-effort from the agent's perspective:

1. **Sync failure** → Log warning, continue workflow.
2. **Run POST failure** → Log warning, continue. The run record is a visibility aid, not a gating dependency.
3. **Queue fetch failure** → Fall back to GitHub Issues API directly.
4. **Claim failure** → Retry with `force: true` if appropriate, or skip the issue and try the next one.
5. **Health check failure** → If `/api/health` returns `{ ok: false }` with 503, the database may be unreachable but Dispatch itself is still responsive.

**Critical principle:** Dispatch failures must never crash agent heartbeat or workflow runs. The agent should always fall back to GitHub as the source of truth.

## API Reference Summary

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/health` | GET | None | Health check — `{ ok: true, database: "ok" }` |
| `/api/sync` | POST | None | Trigger issue sync from GitHub (best-effort) |
| `/api/sync/scheduled` | POST | Bearer token | Scheduled sync runner — primary freshness mechanism |
| `/api/issues` | GET | None | List all issues in Dispatch cache |
| `/api/agents/<name>/queue` | GET | None | Agent-specific issue queue |
| `/api/issues/claim` | POST | Bearer token | Claim an issue (adds agent label) |
| `/api/issues/unclaim` | POST | Bearer token | Release an issue (removes agent label) |
| `/api/issues/actions` | POST | None | Assign/unassign agent or owner labels |
| `/api/issues/unassign` | POST | None | Remove all agent/owner labels of a type |
| `/api/issues/move` | POST | Bearer token | Move an issue on the board |
| `/api/agent-runs` | GET | None | List recent agent runs |
| `/api/agent-runs` | POST | Bearer token | Submit a new agent run record |
| `/api/automation/repos` | GET | None | List tracked repositories |
| `/api/audit` | GET | None | Query audit log entries |

## Five-Column Workflow Details

The five-column workflow defines clear status transitions:

```
Backlog → Ready → In Progress → In Review → Done
```

**Transitions:**
- **Backlog → Ready:** Triage/grooming complete, issue is actionable
- **Ready → In Progress:** Agent claims the issue
- **In Progress → In Review:** PR opened, awaiting merge/review
- **In Review → Done:** Issue closed (typically after PR merge)

**Invariants:**
- Agents pick from Ready by default, not Backlog
- Open issues with unmerged PRs must be In Review, never Done
- Done is reserved exclusively for closed/terminal issues

## History
- **2026-05-21** — Added resumable work section with next-action contract reference (Issue #167).


- **2026-05-19** — Added five-column workflow documentation with Ready status and In Review semantics (Issue #140).
- **2026-05-19** — Updated to reflect that scheduled sync (`POST /api/sync/scheduled`) is now the primary freshness mechanism. Agent heartbeats may still call `POST /api/sync` for best-effort freshness, but are no longer responsible for general cache freshness.
- **2026-05-16** — Created as part of generic agent workflow documentation (Issue #59). Covers the complete lifecycle: start run, sync state, request queue, claim work, report status. Includes failure handling and security constraints. Replaces section-specific notes scattered across other docs with a single authoritative reference.
