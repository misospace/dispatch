# Tracked Repos API — Automation & Audit Consumer Guide

> **Issue:** [misospace/dispatch#69](https://github.com/misospace/dispatch/issues/69)
> **Date:** 2026-05-17

## Overview

Dispatch exposes tracked repositories through a stable API endpoint so that
automation jobs and audit consumers can discover repos without hardcoded names or
dependency on the legacy `project_groom.py` script.

## Endpoint

```
GET /api/automation/repos/tracked
```

**Auth:** None required (public endpoint).

**Response:** `200 OK` — JSON array of enabled tracked repositories.

### Response Shape

Each item contains:

| Field          | Type   | Description                                      |
|----------------|--------|--------------------------------------------------|
| `fullName`     | string | Full repo name (`owner/repo`)                    |
| `owner`        | string | Repository owner/organization                    |
| `name`         | string | Repository name (without owner)                  |
| `enabled`      | boolean | Always `true` — only enabled repos are returned  |
| `source`       | string | Origin of tracking: `"user"`, `"env"`, or `"unknown"` |
| `lastSyncedAt` | string/null | ISO-8601 timestamp of last automation sync, or `null` if none |

### Example Response

```json
[
  {
    "fullName": "misospace/dispatch",
    "owner": "misospace",
    "name": "dispatch",
    "enabled": true,
    "source": "user",
    "lastSyncedAt": "2026-05-17T09:00:00.000Z"
  },
  {
    "fullName": "misospace/miso-chat",
    "owner": "misospace",
    "name": "miso-chat",
    "enabled": true,
    "source": "env",
    "lastSyncedAt": null
  }
]
```

## Usage

### Discovery by Automation Jobs

Automation consumers (weekly audit cron, heartbeat workers, etc.) should:

1. `GET /api/automation/repos/tracked` to fetch the current list of tracked repos.
2. Iterate over the returned array — no hardcoded repo names are needed.
3. Use `fullName` for downstream API calls or GitHub API operations.
4. Check `lastSyncedAt` to determine if a repo needs re-syncing.

### Example (curl)

```bash
curl -s http://localhost:3000/api/automation/repos/tracked | jq .
```

### Example (Node.js / TypeScript)

```ts
const res = await fetch("/api/automation/repos/tracked");
if (!res.ok) throw new Error(`Tracked repos API error: ${res.status}`);
const repos = await res.json() as Array<{
  fullName: string;
  owner: string;
  name: string;
  enabled: boolean;
  source: string;
  lastSyncedAt: string | null;
}>;

for (const repo of repos) {
  console.log(`Tracked: ${repo.fullName} (source: ${repo.source})`);
}
```

## Migration Notes

- The legacy `project_groom.py` script read `TRACKED_REPOS` from environment variables.
- Replace hardcoded repo references with calls to this endpoint.
- The existing `/api/repos` and `/api/automation/repos` endpoints remain unchanged.
