# Saffron Phase 1 — Mission Control Runtime Smoke Checklist

Before Saffron stops grooming GitHub Projects and begins using **Mission Control** as her task visibility layer, this checklist validates every runtime contract.

## Quick Start

```bash
# Against local dev instance
node scripts/smoke-checklist.mjs http://localhost:3000

# Against staging/prod
node scripts/smoke-checklist.mjs https://mc.example.com

# CI-friendly (exits 1 on failure, prints JSON to stderr)
CI=1 node scripts/smoke-checklist.mjs https://mc-staging.example.com
```

Add to `package.json` for convenience:

```json
{
  "scripts": {
    "smoke": "node scripts/smoke-checklist.mjs"
  }
}
```

Then run: `npm run smoke`

---

## Acceptance Criteria

| # | Check | Endpoint / Method | Expected Result |
|---|-------|-------------------|-----------------|
| 1 | Health endpoint | `GET /api/health` | `{ ok: true, database: "ok" }` |
| 2 | Automation sync | `POST /api/automation/sync` | `{ success: true }` |
| 3 | Repo listing | `GET /api/automation/repos` | Array of repo objects |
| 4 | Issue sync | `POST /api/sync` | `{ syncedCount > 0 }` (or 0 if no repos configured) |
| 5 | Issue listing | `GET /api/issues` | Array of issue objects |
| 6 | Board page | `GET /board` | HTTP 200 |
| 7 | Projects page | `GET /projects` | HTTP 200 |
| 8 | Agent heartbeat | `GET /api/agent-runs?limit=50` | Contains at least one heartbeat entry |
| 9 | Issue move + audit | `POST /api/issues/move` | Audit log entry created; test label cleaned up |
| 10 | No critical errors | `GET /api/audit?limit=50` | Zero entries matching Prisma/BigInt/FK patterns |
| 11 | Failure isolation | `GET /api/health` while other endpoints fail | Health endpoint remains responsive (ok:true or ok:false with 503) |

---

## Manual Verification Steps

Some checks are best verified visually alongside the automated script:

### Board Shows Issues
- Navigate to `/board` in a browser
- Confirm Kanban columns display issue cards
- Verify drag-and-drop reordering works

### Projects Shows Repo Groups
- Navigate to `/projects` in a browser
- Confirm repo groups are listed and clickable
- Verify each group expands to show associated issues

### Saffron Heartbeat in Agents
- Navigate to `/agents` in a browser
- Confirm recent agent runs appear
- Look for entries with `runType: "heartbeat"` or `agentName` containing "saffron"

### Moving an Issue Updates GitHub Labels + AuditLog
1. Pick any low-risk issue (e.g., a test or staging issue)
2. Use the board UI to move it between columns
3. Verify the corresponding GitHub label changes on the source repo
4. Check `GET /api/audit` for a `move_issue` entry with `success: true`

### Logs Show No Critical Errors
- Inspect application logs for:
  - **Prisma** errors (migration failures, constraint violations)
  - **BigInt** serialization issues
  - **Foreign key** constraint violations
- None of these should appear in production logs

### Mission Control Failures Don't Break Heartbeat
- The `/api/health` endpoint uses its own try/catch around the database query
- If the DB is down, it returns `{ ok: false, database: "error" }` with status 503 — it does **not** throw
- This isolation ensures Saffron's heartbeat check can distinguish between "MC is up" and "MC is up but DB is down"

---

## Pre-Cutover Decision Gate

| Condition | Action |
|-----------|--------|
| All 11 checks pass (or skip with justification) | ✅ Proceed with cutover |
| Any check fails | ❌ Block cutover; investigate and fix |
| Skipped checks > 0 | ⚠️ Review manually before proceeding |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Health returns `ok:false` | Database not reachable | Check DB connection string, PG status |
| Automation sync fails | No tracked repos or GitHub API error | Run `POST /api/automation/repos` to add repos |
| Issue sync returns 0 | No sync repos configured | Configure `SYNC_REPOS` env var |
| Agent-runs empty | Saffron not running yet | Trigger a heartbeat manually |
| Audit log missing move entry | Move endpoint error or DB issue | Check server logs for the move attempt |

---

## History

- **2026-05-15** — Created as part of Saffron Phase 1 pre-cutover validation (Issue #52)
