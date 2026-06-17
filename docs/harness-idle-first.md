# Idle-First Harness Checks

> **⚠️ SUPERSEDED** — This content has been consolidated into [docs/generic-harness-loop.md](./generic-harness-loop.md).
> See the Generic Worker Loop and Generic Groomer Loop sections for the current integration pattern.
>
> **Issue:** [misospace/dispatch#399](https://github.com/misospace/dispatch/issues/399)
> **Date:** 2026-06-16

This document describes the idle-first integration pattern for harnesses that call Dispatch's `next-task` endpoint. The pattern lets a harness skip expensive model startup when there is no work to do.

## Why Idle-First

Starting an AI model (loading weights, initializing context) is the most expensive part of an agent heartbeat. If there is no work to do, the harness should exit before starting the model. The `next-task` endpoint is designed for this: it is a **read-only**, **cheap** check that returns `shouldRun: false` when the queue is empty.

## Endpoints

| Role | Endpoint | Idle reason |
|------|----------|-------------|
| Normal worker | `GET /api/agents/{agentName}/next-task?lane=normal` | `"No work available"` |
| Groomer | `GET /api/agents/{agentName}/next-task?mode=groom` | `"No grooming work available"` |

Both endpoints return a single `AgentTask` object (not an array). When idle, the response is:

```json
{
  "type": "idle",
  "shouldRun": false,
  "reason": "No work available"
}
```

## Integration Pattern

### Normal Worker

```bash
# Fetch next task
curl -s "https://dispatch.example.com/api/agents/saffron/next-task?lane=normal"
```

Response when idle:
```json
{
  "type": "idle",
  "shouldRun": false,
  "reason": "No work available"
}
```

Response when work is available:
```json
{
  "type": "implement",
  "shouldRun": true,
  "agentName": "saffron",
  "lane": "normal",
  "issue": {
    "repoFullName": "org/repo",
    "number": 42,
    "title": "Fix login bug",
    "url": "https://github.com/org/repo/issues/42"
  },
  "instructions": "Claim or work the assigned issue...",
  "stopAfter": "One PR is open or updated for the issue...",
  "forbiddenActions": [...]
}
```

### Groomer

```bash
# Fetch next grooming task
curl -s "https://dispatch.example.com/api/agents/saffron/next-task?mode=groom"
```

Response when idle:
```json
{
  "type": "idle",
  "shouldRun": false,
  "reason": "No grooming work available"
}
```

### Pseudo-Code

```python
def heartbeat():
    # Step 1: best-effort sync (do not fail on error)
    try:
        post("https://dispatch.example.com/api/sync")
    except Exception as e:
        log_warning(f"sync failed: {e}")

    # Step 2: idle check — read-only, no model context needed
    task = get("https://dispatch.example.com/api/agents/saffron/next-task?lane=normal")

    if not task["shouldRun"]:
        log_info(f"idle: {task['reason']}")
        return  # Exit before starting the model

    # Step 3: start model and execute exactly one task
    result = run_model(task)

    # Step 4: report result later via task report endpoint
    post("https://dispatch.example.com/api/agents/saffron/tasks/report", result)
```

## Key Properties

1. **Read-only:** The idle check does not mutate issues, PR-fix queue items, or leases. It only reads the current state.
2. **Cheap:** No model calls, no classification, no network calls to GitHub. The endpoint queries Dispatch's local Postgres cache.
3. **No lease mutation:** Calling `next-task` does not claim or lock any issue. The agent must claim the issue as part of executing the task.
4. **Should run before model startup:** The entire point of this pattern is to avoid starting an expensive model when there is nothing to do.

## Groom Mode Idle

The groomer idle check works the same way but queries for issues that need enrichment (missing labels, priority, agent assignment, or lane classification). When all open issues are fully labeled and classified, the response is idle:

```json
{
  "type": "idle",
  "shouldRun": false,
  "reason": "No grooming work available"
}
```

Groom mode does not query the PR-fix queue or leases — it only reads issues.

## Non-Goals

- This is not a database migration.
- This is not a new scheduler.
- This is not OpenClaw-specific logic.
- There are no new auth changes.
- No model calls, issue mutations, lease mutations, or PR-fix mutations.

## Source Code

- Endpoint: `src/app/api/agents/[agentName]/next-task/route.ts`
- Task types: `src/lib/agent-task.ts`
- Tests: `src/app/api/agents/[agentName]/next-task/route.test.ts`

## History

- **2026-06-16** — Created to document the idle-first harness check pattern (Issue #399). Added tests verifying idle responses are read-only and include short reasons.
