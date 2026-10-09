# Generic Harness Loop

> **Issue:** [misospace/dispatch#400](https://github.com/misospace/dispatch/issues/400)
> **Date:** 2026-06-17

This document describes how any harness integrates with Dispatch. No custom runtime scripts, no second runtime repo, and no OpenClaw-specific logic are required.

## Non-Goals

Dispatch is not the harness. Dispatch does not run the model. A second runtime repo is not required. Harnesses should not keep looping forever inside one task — they stop after one task. There is no OpenClaw-specific requirement. Any scheduler, CLI wrapper, or manual workflow that can make HTTP requests can use Dispatch.

## Endpoints

| Role | Endpoint |
|------|----------|
| Worker | `GET /api/agents/{agentName}/next-task?lane=normal` |
| Report | `POST /api/agents/{agentName}/tasks/report` |

## Task Types

The `next-task` endpoint returns one of three task types:

| Type | `shouldRun` | Description |
|------|-------------|-------------|
| `idle` | `false` | No work available. The harness should exit immediately. |
| `implement` | `true` | Work exactly one GitHub issue. Open or update one PR, then stop. |
| `followup-pr` | `true` | Update exactly one existing PR with requested changes, then stop. |

## Report Outcomes

The report endpoint accepts these outcomes:

| Outcome | Meaning |
|---------|---------|
| `pr_opened` | A new PR was opened for the issue |
| `pr_updated` | An existing PR was updated with changes |
| `issue_updated` | The issue was updated (labels, body, etc.) |
| `issue_closed` | The issue was closed |
| `blocked` | Work cannot proceed without external input |
| `failed` | The task failed unexpectedly |
| `no_changes_needed` | No action was required |
| `already_addressed` | PR-fix feedback was already handled; settles with optional evidence and no push (#1121) |

## Generic Worker Loop

```python
def worker_heartbeat(agent_name, dispatch_url):
    auth = {"Authorization": f"Bearer {DISPATCH_AGENT_TOKEN}"}

    # Fetch next task (auth required)
    task = get(
        f"{dispatch_url}/api/agents/{agent_name}/next-task?lane=normal",
        headers=auth,
    )

    # Exit immediately on idle
    if not task["shouldRun"]:
        return

    # Execute exactly one task
    if task["type"] == "implement":
        result = work_issue(task["issue"])
    elif task["type"] == "followup-pr":
        result = update_pr(task["pullRequest"], task["reasons"])

    # Report outcome (auth required)
    post(
        f"{dispatch_url}/api/agents/{agent_name}/tasks/report",
        headers=auth,
        json={"taskType": task["type"], "outcome": result["outcome"], **result["metadata"]},
    )

    # Stop
```

Autonomous workers may authenticate the loop above with `DISPATCH_WORKER_TOKEN` (worker tier); operator and MCP-bridge agents keep the maintainer token (`DISPATCH_AGENT_TOKEN`).

**Optional preflight sync:** Agents may call `POST /api/sync` before fetching their next task to refresh Dispatch's issue cache. This is a best-effort, out-of-band operation — not required for the worker loop and not something agents depend on before every task. Sync failures should be logged as freshness warnings and must not block task execution.

## Hosted grooming

External `next-task?mode=groom` has been retired (#1200) and returns HTTP 410.
Use Dispatch-hosted `POST /api/groomer/run` instead. Stop legacy external
groomer pollers and revoke unnecessary GitHub write credentials.

## Small Harness Examples

Each example uses the same Dispatch contract. None implies OpenClaw is required.

### curl / Shell

```bash
DISPATCH="https://dispatch.example.com"
AGENT="saffron"

# Idle check (auth required)
TASK=$(curl -s -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  "$DISPATCH/api/agents/$AGENT/next-task?lane=normal")
echo "$TASK" | python3 -c "import sys,json; t=json.load(sys.stdin); sys.exit(0 if t['shouldRun'] else 1)" || exit 0

# Execute task (replace with your model invocation)
# ...

# Report result (auth required)
curl -s -X POST "$DISPATCH/api/agents/$AGENT/tasks/report" \
  -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskType":"implement","outcome":"pr_opened"}'
```

### OpenClaw Scheduler

Configure the scheduler to run a one-shot job per heartbeat:

```yaml
schedule: "*/15 * * * *"
command: |
  TASK=$(curl -s -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
    "$DISPATCH/api/agents/$AGENT/next-task?lane=normal")
  SHOULD_RUN=$(echo "$TASK" | jq -r '.shouldRun')
  [ "$SHOULD_RUN" = "false" ] && exit 0
  # Start model, execute task, report result
```

### OpenCode / Manual

Manually invoke the endpoint, read the task, and execute:

1. Fetch `GET /api/agents/{name}/next-task?lane=normal` (bearer auth required)
2. If idle, stop
3. Execute the task with your preferred tooling
4. Report via `POST /api/agents/{name}/tasks/report` (bearer auth required)

### Codex or Claude Code One-Shot

```bash
# One-shot: fetch task, feed to model, report (auth required)
TASK=$(curl -s -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  "$DISPATCH/api/agents/$AGENT/next-task?lane=normal")
echo "$TASK" | codex --one-shot
# Report outcome after execution
```

## Key Properties

1. **One task per run:** The harness fetches one task, executes it, reports, and stops. It does not loop inside a single heartbeat.
2. **Idle before model startup:** The `next-task` endpoint is read-only and cheap. Call it before starting the model to avoid wasted compute.
3. **No lease mutation:** Calling `next-task` does not claim or lock any issue. The agent claims the issue as part of executing the task.
4. **Optional preflight sync:** `POST /api/sync` is optional and out-of-band. Sync failures should be logged as freshness warnings and must not block task execution.
5. **Grooming admission (opt-in):** With `DISPATCH_QUEUE_ADMISSION_MODE=enforce`, `next-task` only returns `implement` tasks for ready issues with a current, applied, evidence-backed grooming decision or an explicit operator override; `audit` exposes the decision without filtering. PR-fix and linked-PR follow-up tasks are unaffected. See [Worker Admission](./hosted-groomer.md#worker-admission).

## Source Code

- Task types: `src/lib/agent-task.ts`
- Next-task endpoint: `src/app/api/agents/[agentName]/next-task/route.ts`
- Report endpoint: `src/app/api/agents/[agentName]/tasks/report/route.ts`

## History

- **2026-06-17** — Created to document the generic harness loop (Issue #400).
