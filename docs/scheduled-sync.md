# Scheduled Sync Runner

## Overview

Dispatch owns general cache freshness through a protected scheduled sync endpoint. This replaces heartbeat-driven issue sync as the primary freshness mechanism for tracked repositories.

Agent/worker heartbeats may still trigger best-effort sync, but they are no longer the primary freshness strategy.

## Endpoint

```
POST /api/sync/scheduled
```

### Authentication

Requires a `Bearer` token matching the `DISPATCH_AGENT_TOKEN` environment variable:

```
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
```

### Request Body (optional)

```json
{
  "issues": true,
  "automation": false
}
```

- `issues` — Sync tracked GitHub issues. **Default: `true`**. Set to `false` to skip.
- `automation` — Sync automation data (workflows, runs, releases, PRs). **Default: `false`** (opt-in).

### Response — Success

```json
{
  "success": true,
  "startedAt": "2026-05-19T05:00:00.000Z",
  "finishedAt": "2026-05-19T05:00:12.345Z",
  "issues": {
    "repos": 6,
    "syncedCount": 86,
    "results": [
      { "repo": "misospace/dispatch", "synced": 24, "error": null },
      { "repo": "misospace/miso-chat", "synced": 18, "error": null }
    ]
  },
  "automation": {
    "synced": 6,
    "failed": 0
  }
}
```

### Response — Already Running (409)

```json
{
  "error": "A scheduled sync is already running. Try again later.",
  "locked": true
}
```

### Response — Unauthorized (401)

```json
{
  "error": "Unauthorized"
}
```

## Recommended Cadence

- Every **10–30 minutes** for general issue freshness.
- Automation sync is heavier (fetches workflows, runs, releases, PRs); run it less frequently (e.g., every 30–60 minutes) or only when needed.

## Example: curl

```bash
# Basic issue sync
curl -X POST "https://dispatch.example.com/api/sync/scheduled" \
  -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"issues": true}'

# Issue + automation sync
curl -X POST "https://dispatch.example.com/api/sync/scheduled" \
  -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"issues": true, "automation": true}'
```

## Troubleshooting Failed Syncs

### 409 — Already Running

A previous sync is still in progress. The lock expires after **30 minutes** of inactivity (stale lock detection). Wait and retry, or check the `IssueSyncRun` table for the running run's status.

### 500 — Sync Failed

Check the `IssueSyncRun` table:
- `status` = `"failed"`
- `errorMessage` contains the error details
- `notes` may contain partial results

Common causes:
- GitHub API rate limiting — wait and retry
- Network timeout to GitHub — retry
- Database connection issue — check database health

### Checking Sync Run History

Query the `IssueSyncRun` table directly for historical sync runs:

```sql
SELECT id, status, repos_fetched, synced_count, error_message, notes, sync_type, started_at, completed_at
FROM "IssueSyncRun"
ORDER BY started_at DESC
LIMIT 20;
```

## How It Works

1. **Lock acquisition** — The endpoint uses a DB-backed single-row lock (`sync_lock` table) to prevent overlapping runs. Only one scheduled sync can run at a time.
2. **Issue sync** — Fetches issues from all tracked repositories and upserts them into the `Issue` table.
3. **Automation sync** (opt-in) — Fetches workflows, runs, releases, PRs, and packages for tracked repos.
4. **Result recording** — Sync results are written to the `IssueSyncRun` table with timestamps and error details.
5. **Lock release** — The lock is released after completion (success or failure).

## Guardrails

- ✅ Protected by bearer auth (`DISPATCH_AGENT_TOKEN`)
- ✅ DB-backed lock prevents overlapping runs
- ✅ Records sync results and errors in `IssueSyncRun`
- ✅ Manual sync (`POST /api/sync`, `POST /api/automation/sync`) remains available
- ✅ Pre-claim refresh (`POST /api/issues/refresh`) is unaffected

## Documentation Changes

This endpoint replaces heartbeat-driven sync as the primary freshness mechanism. Agents should no longer rely on calling `POST /api/sync` at each heartbeat for general cache freshness. Instead, an external scheduler (CronJob, Taskflow wait, etc.) should call this endpoint on a regular cadence.
