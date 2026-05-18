# Assignment-Layer Runtime Smoke Checklist

> **Issue:** [misospace/mission-control#60](https://github.com/misospace/mission-control/issues/60)
> **Date:** 2026-05-16
> **Purpose:** Verify Dispatch is healthy before agents rely on it for assignment.

This checklist documents the runtime smoke checks an operator or agent should run against a Dispatch instance to confirm the assignment layer is fully operational. Each check maps to a specific API endpoint, UI page, or log signal.

Run all checks against the target instance (local dev, staging, or production) before cutover or after any deployment. Mark each as **PASS**, **FAIL**, or **SKIP** (with justification). All 14 checks must pass — or be explicitly skipped with documented reason — before trusting Dispatch for assignment decisions.

---

## Prerequisites

- Dispatch instance is running and reachable at `<base-url>`.
- At least one repository is tracked (`GET /api/automation/repos` returns items, or `GITHUB_REPOSITORIES` env var was set).
- At least one issue has been synced (`POST /api/sync` was run successfully at least once).
- A test agent identity is available (e.g. `"smoke-test"`).

---

## Checklist

### 1. Health endpoint returns healthy

**Endpoint:** `GET <base-url>/api/health`

**Expected response:**
```json
{
  "ok": true,
  "database": "ok",
  "version": "0.1.13"
}
```

**Status code:** `200 OK`

**Failure signal:** Any response with `ok: false`, `database: "error"`, or status `503`. This means the PostgreSQL database is unreachable but Dispatch itself is still running.

---

### 2. Automation sync succeeds

**Endpoint:** `POST <base-url>/api/automation/sync`

**Request body:** `{}` (syncs all tracked repos) or `{ "repo": "owner/repo" }` (single repo).

**Expected response:**
```json
{
  "synced": 1,
  "failed": 0,
  "results": [{ "repo": "owner/repo", "result": { "success": true, "syncRunId": "<id>" } }]
}
```

**Failure signal:** `synced: 0` with non-zero `failed`, or any HTTP error.

---

### 3. Automation repos endpoint returns tracked repos

**Endpoint:** `GET <base-url>/api/automation/repos`

**Expected response:** Array of repo objects, each containing `fullName`, `name`, `owner`, `defaultBranch`, `openPRCount`, `lastSyncedAt`.

**Failure signal:** Empty array when at least one repo is expected, or HTTP error.

---

### 4. Issue sync returns syncedCount > 0

**Endpoint:** `POST <base-url>/api/sync`

**Expected response:**
```json
{ "syncedCount": <N> }
```

where `N > 0`.

**Failure signal:** `syncedCount: 0` (no repos configured or sync failed), or HTTP error.

---

### 5. Issues endpoint returns issues

**Endpoint:** `GET <base-url>/api/issues`

**Expected response:** Non-empty array of issue objects, each with `number`, `title`, `url`, `labels`, `repository`.

**Failure signal:** Empty array when issues are expected, or HTTP error.

---

### 6. Board page shows issues

**URL:** `<base-url>/board`

**Expected:** The Kanban board renders with issue cards grouped by status columns (`backlog`, `in-progress`, `in-review`, `done`). Filter bar is present and functional. Sync status indicator shows tracked repo count and cached issue count.

**Failure signal:** Empty board, error overlay, or missing sync status indicator.

---

### 7. Projects page shows repo groups

**URL:** `<base-url>/projects`

**Expected:** The Projects view renders with cards grouped by repository (e.g., `misospace/dispatch`, `misospace/miso-gallery`). Each card shows issue count and status breakdown columns.

**Failure signal:** Empty state message ("No issues have been synced yet") when issues are expected, or error overlay.

---

### 8. Agent heartbeat/run events appear in Agents

**URL:** `<base-url>/agents`
**Endpoint (alternative):** `GET <base-url>/api/agent-runs?limit=10`

**Expected:** Recent agent run entries with `agentName`, `runType`, `status`, `createdAt`. At minimum, the page or API shows that agent runs are being recorded.

**Failure signal:** Empty list when runs have been submitted, or HTTP error.

---

### 9. Queue endpoint returns candidate issues

**Endpoint:** `GET <base-url>/api/agents/<agent-name>/queue`

**Expected response:** Non-empty array of issue objects with `number`, `title`, `url`, and `labels`. Issues should be ranked by priority and status according to the agent queue algorithm.

**Failure signal:** Empty array when issues are expected, or HTTP error.

---

### 10. Claiming a low-risk test issue updates GitHub labels

**Endpoint:** `POST <base-url>/api/issues/claim`

**Request body:**
```json
{
  "issueId": "<mc-issue-id>",
  "repoFullName": "owner/repo",
  "issueNumber": 123,
  "agentName": "smoke-test",
  "force": false
}
```

**Expected response:** `{ "success": true, "labels": ["...", "agent/smoke-test", ...] }`

**GitHub verification:** The issue on GitHub should have the `agent/smoke-test` label added. Optionally `status/in-progress` if no status label was present.

**Failure signal:** HTTP error, or labels not reflected on GitHub after a few seconds.

---

### 11. Claiming writes an AuditLog entry

**Endpoint:** `GET <base-url>/api/audit?limit=50`

**Expected response:** The most recent audit log entries include the claim action:
```json
{
  "action": "claim_issue",
  "actor": "smoke-test",
  "repoFullName": "owner/repo",
  "issueNumber": 123,
  "success": true,
  "beforeLabels": ["..."],
  "afterLabels": ["...", "agent/smoke-test"]
}
```

**Failure signal:** No `claim_issue` entry for the test claim in audit logs, or `success: false`.

---

### 12. Unclaiming or reverting the test issue works

**Endpoint:** `POST <base-url>/api/issues/unclaim`

**Request body:**
```json
{
  "issueId": "<mc-issue-id>",
  "repoFullName": "owner/repo",
  "issueNumber": 123,
  "agentName": "smoke-test"
}
```

**Expected response:** `{ "success": true, "labels": ["..."] }` (without `agent/smoke-test`).

**GitHub verification:** The `agent/smoke-test` label is removed from the issue on GitHub.

**Audit log verification:** A new `unclaim_issue` entry appears with `success: true`.

**Failure signal:** HTTP error, label persists on GitHub, or no audit log entry.

---

### 13. Logs show no Prisma, BigInt, or FK errors

**Method:** Inspect Dispatch logs after running all checks above.

**Expected:** No lines containing `PrismaClientKnownRequestError`, `PrismaClientUnknownRequestError`, `BigInt`, `ForeignKey`, `FK constraint`, `relation "X" does not exist`, or `column "Y" does not exist`.

**Failure signal:** Any of the above error patterns in logs. These indicate schema drift, migration issues, or ORM misconfiguration that could silently corrupt data.

---

### 14. Dispatch failures do not break agent runs

**Method:** Simulate failure by stopping Dispatch or making an endpoint return errors, then verify an agent can continue operating using GitHub as fallback.

**Steps:**
1. Stop Dispatch (or block network to it).
2. Attempt the heartbeat workflow: `POST /api/sync` fails, `GET /api/issues` fails.
3. Verify the agent falls back to GitHub Issues API directly and continues processing.
4. Restart Dispatch. Verify the next heartbeat succeeds with `/api/sync`.

**Expected:** Agent continues working through fallback path; no crash or hang when Dispatch is unavailable.

**Failure signal:** Agent crashes, hangs, or fails its heartbeat entirely when Dispatch is down.

---

## Runbook: Interpreting Results

| Result | Action |
|--------|--------|
| All PASS | Dispatch is ready for assignment. Proceed with cutover. |
| 1–2 FAIL | Investigate failures. Re-run after fixes. Do not proceed to cutover. |
| 3+ FAIL | Do not proceed. Block on critical failures (health, sync, issues, audit). |
| Any SKIP | Document justification. Verify skipped checks were handled by alternative means. |

### Common failure patterns

- **Health check fails (503):** Database connection issue. Check `DATABASE_URL`, PostgreSQL status, and Prisma binary compatibility.
- **Sync returns 0:** No repos configured. Set `GITHUB_REPOSITORIES` or add repos via `/api/automation/repos`.
- **Issues empty after sync:** GitHub token may lack permissions for the target repos. Verify `GITHUB_TOKEN` scopes.
- **Audit log missing entries:** Check Prisma schema for `AuditLog` model and confirm migrations are deployed (`prisma migrate deploy`).
- **BigInt errors in logs:** Prisma version mismatch or schema using `BigInt` without proper type handling. Check `prisma/schema.prisma` for `@db.BigInt` fields.

---

## History

- **2026-05-16** — Created as assignment-layer runtime smoke checklist (Issue #60). Documents all 14 checks covering health, sync, repos, issues, board UI, projects UI, agent runs, queue, claim/unclaim lifecycle, audit trail, log errors, and failure resilience.
