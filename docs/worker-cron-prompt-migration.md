# Worker Cron Prompt Migration to Dispatch Queues

> **Issue:** [misospace/dispatch#70](https://github.com/misospace/dispatch/issues/70)  
> **Date:** 2026-05-17  
> **Status:** Migrated

This document describes the migration of worker cron prompts from GitHub Project board readers to Dispatch queue APIs.

## Problem

Worker cron prompts previously consumed work from GitHub Project boards using Python helper scripts:
- `wishlist_read_board.py` — Read Ready/In Progress items for normal-lane workers
- `wishlist_read_gpt_audit_board.py` — Read Ready/In Progress items for escalated-lane workers

These scripts queried the GitHub Projects GraphQL API directly, coupling worker logic to a deprecated board format.

## Solution

Worker cron prompts now consume work from Dispatch's assignment queue APIs:

| Lane | Endpoint |
|------|----------|
| Normal | `GET /api/agents/{agentName}/queue?lane=normal` |
| Escalated | `GET /api/agents/{agentName}/queue?lane=escalated` (also accepts `lane=gpt`) |

Workers use Dispatch action APIs for work management:
- Claim work: `POST /api/issues/claim`
- Set status: `POST /api/issues/status` (preferred for status transitions)
- Move labels: `POST /api/issues/move` (legacy, requires oldLabels/newLabels)

All worker-facing mutation endpoints require bearer authentication via `DISPATCH_AGENT_TOKEN`.

## Queue Response Format

Issue items returned from the queue include:

```json
{
  "type": "issue",
  "issueId": "abc123",
  "repoFullName": "org/repo",
  "number": 42,
  "title": "Fix the thing",
  "url": "https://github.com/org/repo/issues/42",
  "labels": ["priority/p0", "status/backlog"],
  "lane": "normal",
  "status": "backlog",
  "priority": "p0",
  "rankingReason": "priority/p0, backlog",
  "decomposed": false
}
```

PR-fix queue items retain `type: "pr-review-fix"` and are always returned first.

## Migration Checklist

### 1. Replace board reading with queue consumption

**Before:**
```bash
python3 /home/node/.openclaw/workspace-saffron/scripts/wishlist_read_board.py
```

**After:**
```bash
curl -s "DISPATCH_URL/api/agents/{agentName}/queue?lane=normal" | python3 -c "import json,sys; items=json.load(sys.stdin); [print(json.dumps(i)) for i in items[:10]]"
```

### 2. Add work claiming step before processing

Workers must claim work through Dispatch before starting. **Claim only assigns** the agent label — it does not change the status label. Workers must explicitly set status via `POST /api/issues/status` after claiming or when transitioning states.

```bash
curl -s -X POST "DISPATCH_URL/api/issues/claim" \
  -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"issueId":"{mc_issue_id}","repoFullName":"{repo}","issueNumber":{number},"agentName":"{agentName}"}'
```

### 3. Set status explicitly after claiming

After claiming, workers should transition to in-progress:

```bash
curl -s -X POST "DISPATCH_URL/api/issues/status" \
  -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"issueId":"{mc_issue_id}","repoFullName":"{repo}","issueNumber":{number},"status":"in-progress"}'
```

Valid status values: `backlog`, `in-progress`, `in-review`, `done`.

When the issue is complete, set status to `done` **only** after verifying completion (green pipeline, merged PR, or human approval).

### 4. Legacy move endpoint (deprecated for workers)

The `/api/issues/move` endpoint requires `oldLabels` and `newLabels` arrays:

```bash
curl -s -X POST "DISPATCH_URL/api/issues/move" \
  -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"issueId":"{mc_issue_id}","repoFullName":"{repo}","issueNumber":{number},"oldLabels":["status/backlog"],"newLabels":["status/in-progress"]}'
```

Workers should prefer `POST /api/issues/status` for status transitions — it is simpler and handles label replacement automatically.

### 5. Remove GitHub Projects API references from worker prompts

All worker prompts must no longer reference:
- GitHub Project board IDs (`PVT_kwHOAsG-YM4BTyY3`)
- Project field IDs (`PVTSSF_lAHOAsG-YM4BTyY3zhA-4y0`)
- GraphQL mutations for status updates
- The `wishlist_read_board.py` and `wishlist_read_gpt_audit_board.py` scripts

### 6. Preserve existing behaviors

The following must remain unchanged in worker prompts:
- PR review-fix queue check (via `GET /api/agents/{agentName}/queue?lane=normal`) — PR-fix items are returned first, still the first step
- Duplicate PR avoidance (`gh pr list --state open --search "{number}"`)
- Hard completion gates (git push → gh pr create → gh pr view → final response with PR URL)
- Branch naming convention (`fix/issue-{number}-{short-description}`)
- Fixes vs Refs determination logic
- Failure response format (`Stuck: {reason}.`)

## Claim Behavior

**Claim assigns, does not transition status.** When a worker calls `POST /api/issues/claim`:
- The `agent/{name}` label is added to the issue (on GitHub and in the Prisma cache)
- No status label is changed automatically
- If another agent already has an `agent/*` label, the request returns 409 unless `force=true`

To transition status, workers must call `POST /api/issues/status` explicitly. This separates assignment from state management and gives workers full control over their workflow transitions.

## Affected Cron Jobs

| Cron ID | Name | Lane | MC Queue Endpoint |
|---------|------|------|-------------------|
| `6b09bed4-cfbe-4c35-bbee-2b66c5ef17aa` | (Saffron): 35B Wishlist Chip | normal | `/api/agents/saffron/queue?lane=normal` |
| `1723278d-2eaa-435b-9fda-0efe8febb30b` | (Saffron): GPT-5.5 Wishlist Chip | escalated | `/api/agents/saffron/queue?lane=escalated` |

## PR Fix Queue Status

The Dispatch application has a dedicated, fully-implemented PR fix queue (`/api/pr-fix-queue/*`) with native ingestion via both pull-based sync (`POST /api/pr-followup/sync`) and real-time webhooks (`POST /api/pr-followup/webhook`). PR-fix items are automatically prepended to the agent queue response from `GET /api/agents/{agentName}/queue`.

Workers should consume PR-fix items from the Dispatch agent queue endpoint or the dedicated `/api/pr-fix-queue/queued` endpoint. The local `pr_fix_queue.py` helper is no longer required.

## Deprecated Scripts

The following scripts are deprecated and kept only for reference:
- `wishlist_read_board.py` — replaced by MC normal queue API
- `wishlist_read_gpt_audit_board.py` — replaced by MC escalated lane API

These should be removed once all cron jobs have been verified to work with the new queue-based approach.

## Acceptance Criteria (from Issue #70)

- [x] Normal worker prompt reads Dispatch normal queue instead of `wishlist_read_board.py`
- [x] Escalated lane worker prompt reads Dispatch escalated queue instead of `wishlist_read_gpt_audit_board.py`
- [x] Workers claim work through Dispatch before starting
- [x] Workers update status through `POST /api/issues/status` (preferred) or `POST /api/issues/move` (legacy)
- [x] Workers still avoid duplicate PRs
- [x] Workers preserve hard completion gates
- [x] Prompts do not mention user-specific agent names in generic docs
- [x] Migration instructions identify the exact cron jobs to update
- [x] No GitHub Projects API references remain in worker prompts after migration
