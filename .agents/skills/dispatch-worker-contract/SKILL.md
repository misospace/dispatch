---
name: dispatch-worker-contract
description: Review Dispatch changes to agent task APIs, queue ordering, authentication, worker execution, task reporting, idempotency, and lifecycle/state transitions.
---

## Agent Workflow Contract

This section is the source of truth for how any worker or harness interacts with Dispatch. It supersedes all prior workflow guidance.

### Canonical One-Task Worker Loop

Every agent heartbeat follows this loop:

> `normal` is not a built-in lane ID. It works because this deployment maps it
> through `laneAliases` (`normal` → `local`) in `DISPATCH_LANE_CONFIG_JSON`. The
> shipped defaults are `default` and `backlog`, so an unaliased deployment must
> use a configured lane ID or `next-task` returns HTTP 400.

1. **`GET /api/agents/{agentName}/next-task?lane=normal`** (bearer-auth required). Returns exactly one `AgentTask`. If idle (`shouldRun: false`), stop immediately — do not start the model.
2. **Execute exactly one task.** The task type determines what to do (see Task Types below).
3. **`POST /api/agents/{agentName}/tasks/report`** (bearer-auth required). Report the outcome, then stop.

```python
def heartbeat(agent_name, dispatch_url):
    # WORKER_BEARER_TOKEN is a client-side secret containing this agent's
    # bound token provisioned through the server's DISPATCH_WORKER_TOKENS map.
    auth = {"Authorization": f"Bearer {WORKER_BEARER_TOKEN}"}

    # Step 1: fetch next task (auth required)
    task = get(
        f"{dispatch_url}/api/agents/{agent_name}/next-task?lane=normal",
        headers=auth,
    )

    # Step 2: idle check — stop before model work
    if not task["shouldRun"]:
        return

    # Step 3: execute exactly one task
    result = execute(task)

    # Step 4: report outcome (auth required)
    post(
        f"{dispatch_url}/api/agents/{agent_name}/tasks/report",
        headers=auth,
        json={"taskType": task["type"], "outcome": result["outcome"], **result["metadata"]},
    )

    # Stop
```

**Optional preflight sync:** Agents may call `POST /api/sync` before fetching their next task to refresh Dispatch's issue cache. This is a best-effort, out-of-band operation — not required for the worker loop and not something agents depend on before every task. Sync failures should be logged as freshness warnings and must not block task execution.

### Auth Requirements

Both `next-task` and `tasks/report` require bearer authentication. Worker processes must use a token bound to their own agent through the server's `DISPATCH_WORKER_TOKENS` setting (`agentName:token` pairs). In the examples below, `WORKER_BEARER_TOKEN` is a client-side secret containing that agent's bound token; it is an example variable name, not a Dispatch server setting. `DISPATCH_AGENT_TOKEN` and its `DISPATCH_MAINTAINER_TOKEN` alias are maintainer-tier credentials with full rights, not the normal worker credential.

```bash
# Fetch next task
curl -s -H "Authorization: Bearer $WORKER_BEARER_TOKEN" \
  "$DISPATCH_URL/api/agents/$AGENT_NAME/next-task?lane=normal"

# Report outcome
curl -s -X POST -H "Authorization: Bearer $WORKER_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskType":"implement","outcome":"pr_opened","repoFullName":"org/repo","issueNumber":42,"pullRequestUrl":"https://github.com/org/repo/pull/50"}' \
  "$DISPATCH_URL/api/agents/$AGENT_NAME/tasks/report"
```

### Task Types

The `next-task` endpoint returns one of three task types:

| Type | `shouldRun` | Description |
|------|-------------|-------------|
| `idle` | `false` | No work available. Stop immediately — do not start the model. |
| `implement` | `true` | Work exactly one GitHub issue. Open or update one PR, then stop. |
| `followup-pr` | `true` | Update exactly one existing PR with requested changes, then stop. |

### PR-fix lanes (`prFixItem.fixType`)

A `followup-pr` task names the queued item's lane in `prFixItem.fixType`. The task's `reasons` carry the full contract for the item; `fixType` is the branch key that lets a worker pick the lane without parsing prose. `fixType` is the DISPATCHED lane (the stamped `attemptType`, falling back to the row's current type for pre-stamp rows) — the same value settlement keys on — not the row's mutable type, so a mid-attempt re-observation cannot change the lane a live attempt runs and settles as. The stamp is written only by the hand-out issuance itself (atomically with the hand-out record), so it never names a lane that no issued hand-out backed.

For `REBASE` the one-attempt bound is enforced server-side, not only in prose (#1327): `next-task` hands out at most one live rebase at a time across all PRs (concurrency 1, no fan-out; a live hand-out gates the lane until it settles or the reclaim sweep clears it — a hand-out whose acking agents show no liveness evidence past `PR_FIX_ACK_LIVENESS_MS` (default 24h) is reclaimable by the dead-owner recovery ladder (#1419), so a worker that acks must keep heartbeating or report to stay protected; deferred candidates are retried next poll, including when the lane's admission lock cannot be taken — a rebase is never handed out unlocked), and a `failed` or give-up `blocked` report on a `REBASE` item settles as a terminal `PARKED` — it is never re-dispatched as a fresh attempt the way other fix types are under `PR_FIX_MAX_ATTEMPTS`. A new dirty episode (a new head) re-opens the item. The lane's worker pool is also enforced server-side when the deployment declares it: `DISPATCH_REBASE_AGENTS` (comma or whitespace separated agent names) restricts `REBASE` hand-outs to that local-only pool; an agent outside the pool never receives a REBASE hand-out (unset or empty is fail-closed — no agent is eligible and the lane stops dispatching until the operator declares the pool; a bare `*` value is the explicit unrestricted opt-in).

| `fixType` | Contract |
|-----------|----------|
| `REBASE` | Mechanical rebase lane (#1327). Rebase the PR branch onto its base and reconcile conflicts **mechanically only**: lockfiles, version strings, import order, doc indexes, adjacent non-overlapping hunks, and comment-only overlaps where one side is a strict subset. Never edit the same logic on both sides, never merge, never open a PR. Push with `--force-with-lease`, then run the repo's bounded typecheck — an unfixable error in a file this PR touches means the rebase was not mechanical. On **any** semantic conflict, report `outcome: "blocked"` with `blockReason: "human_decision"`, the conflicting files, and why the conflict is not mechanical; do not resolve it yourself. One attempt per dirty episode: do not retry. |
| `MERGE_CONFLICT` | Pre-#1327 merge-conflict items. Same mechanical walls as `REBASE` — rebase onto the base, reconcile mechanically only, push with `--force-with-lease`, bail to a human on a semantic conflict — but a legacy item's stored reason can be a one-liner, so follow the walls above rather than the item's wording. |
| `CI_FAILURE`, `REVIEW_FEEDBACK`, `OTHER` | Ordinary requested changes on the PR. |

### Report Outcomes

The `tasks/report` endpoint accepts these outcomes:

| Outcome | Meaning |
|---------|---------|
| `pr_opened` | A new PR was opened for the issue |
| `pr_updated` | An existing PR was updated with changes |
| `issue_updated` | The issue was updated (labels, body, etc.) |
| `issue_closed` | The issue was closed |
| `blocked` | Work cannot proceed without external input |
| `failed` | The task failed unexpectedly |
| `no_changes_needed` | No action was required. On an **implement** task this is a terminal no-PR conclusion: Dispatch parks the issue out of queue pickup (#1506, see [docs/no-pr-conclusion-park.md](../../../docs/no-pr-conclusion-park.md)); the response echoes `conclusionPark`. |
| `already_addressed` | A PR-fix attempt whose feedback was already handled — settles the queue item with an optional evidence string (commit SHAs/paths) and no new push (#1121). Still gated on PR merge state; a repeated same-evidence disagreement with an unchanged head reopens via #940 and bounds to BLOCKED at `PR_FIX_MAX_ATTEMPTS`. On an **implement** task (no `prFixItem`) it is a terminal no-PR conclusion and parks the issue out of queue pickup (#1506). |
| `already_done` | Implement-only assertion that the work already shipped. Runs the evidence-pinned close policy (#1143); a refused close still records the terminal no-PR park so the issue stops being re-offered (#1506). A successful close supersedes the park. |

The three terminal no-PR outcomes (`no_changes_needed`, `already_addressed` on implement, `already_done`) park the issue in Dispatch only: no GitHub label and no close. The park ends when the issue title or body is edited, or when an operator clears it (`DELETE /api/issues/[issueId]/no-pr-conclusion`, a status change, a board move, or a maintainer force-claim). A parked issue is refused by `POST /api/issues/claim` with 409 for every non-force claim.
| `handed-off` | The worker accepted the task but handed it to another process; records a neutral terminal run status and preserves supplied issue/PR identity without settling the PR-fix queue. Independent pr-followup sync owns ingestion. |
| `capacity-exhausted` | Explicit recognition that the worker's execution capacity cannot run the handed PR-fix attempt (#1256). Requires the issued `prFixItem` token (including its per-hand-out `handoutToken` receipt) and a `capacity` identifier; releases exactly the issued hand-out without spending repair budget and records a capacity-scoped cooldown. For claimed issue work use `POST /api/issues/capacity-handoff` instead. |

Queue-backed `followup-pr` reports must echo the `prFixItem.{id, generation}` token issued by `next-task` on the task. Reports without it still record the AgentRun, but never settle PR-fix queue state — the item stays queued and the report is a no-op against the queue (#1074).

Workers may report `outcome: "capacity-exhausted"` only when a recognized execution capacity is genuinely unavailable, with a non-empty `capacity` identifier (an opaque worker-chosen name, for example a provider/model or runner pool) and the issued `prFixItem: { id, generation, handoutToken }` token. Dispatch fences the settlement to the **exact issued hand-out**: the `handoutToken` is a per-hand-out receipt next-task mints (rotated on every issuance), and the release removes only the reporting agent's receipt/hand-out/ack — other agents' live hand-outs at that generation are preserved, and the hand-out stamps clear only when the last live hand-out is consumed. While the item is still `QUEUED` the attempt token is consumed but the item **stays `QUEUED` at the same generation with the same `fixAttempts` count, branch, and PR identity** — no repair budget is spent and there is no global wait. The suppression is **capacity-scoped**: Dispatch records a bounded cooldown (`DISPATCH_CAPACITY_COOLDOWN_MS`, default 15m, clamped to 1m–6h) for that capacity on that item only. `next-task` requests may declare `?capacity=`; a request whose capacity matches the exhausted one skips the item until the cooldown expires, an unrelated capacity is never suppressed, and a request that declares no capacity conservatively skips cooled items. The capacity is caller-declared trusted *scoping*, never identity: settlement authority comes only from the issued receipt token, the cooldown deliberately does not filter by agent (the same worker with a different, unrelated capacity is legitimately allowed), and lying about a capacity grants nothing beyond re-acquiring work for the capacity one claims to have exhausted. A `capacity_handoff` history row and a `CapacityHandoff` row record the transition. A changed generation, an already-settled status, or a human hold (BLOCKED/PARKED/NEEDS_HUMAN) is never overwritten — the report settles as a no-op. Do not use this outcome for worker-local failures, ordinary errors, or an unrecognized capacity.

For **claimed issue work** the fenced counterpart is `POST /api/issues/capacity-handoff` (bearer-auth; bound workers only for their own agent). The worker presents the `claimToken` that `POST /api/issues/claim` issued on the claim (also surfaced by `active-work` resume context and the MCP `claim_issue` result). A persistent per-issue `IssueMutationGuard` serializes cooperating claim, `upsertLease`, and release mutations under a PostgreSQL advisory lock. Dispatch fences release to that exact claim (agent + lease row + token, verified against live GitHub labels); if ownership changed during verification, cleanup removes only this worker's agent label and never changes status. Human holds (closed/done, any live `status/blocked`, a cached block carrying a `blockedReason`) and changed/missing ownership are refused. The lease remains until remote label cleanup succeeds; then it is consumed, active AgentWork rows are retired with history, an audit row is written, and the same capacity-scoped cooldown applies to issue pickup. Failed cleanup retains the lease and guard so an exact-token retry can resume. An optional `settlementKey` (≤200 chars, #1262) makes the settlement durable and idempotent: the successful release is recorded bound to the exact claim token, and a retry with the same key and original `claimToken` replays the recorded success (`replayed: true`) with zero mutation — even across a held mutation guard after a post-release crash; expired proofs (7-day retention) and keys reused across claim incarnations are refused fail-closed. Guards are persistent and have no automatic timeout: after a process crash, an operator must confirm the process stopped and reconcile live GitHub state before removing one. Branch/PR identity on the lease and work history is retained; nothing is re-pushed and no repair budget exists for issue work. See [docs/capacity-handoff.md](../../../docs/capacity-handoff.md) for the lease/label effects and the GitHub-vs-database consistency boundary.

The report body also accepts an optional `startedAt` — an extended ISO 8601 timestamp with timezone (`Z` or `±HH:MM`), for example `2026-10-03T04:20:58Z` or `2026-10-03T04:20:58.123456+00:00`, marking when the worker began the task. When it parses, is not in the future, and is no more than 24 hours before the report, it is stored as the run's start time so the run records a real duration; missing, malformed, future, or too-old values silently fall back to the report time (never a 400). The raw body value participates in the idempotency payload identity, so an identical-body retry always replays as a duplicate. An accepted `startedAt` is normalized to UTC (`Z`) form when stored and echoed back in the response. The echo reflects re-validation of the current request, so on an idempotent duplicate replay the echoed `startedAt` may be absent even though the original accepted run stored it — for example when an identical-body retry lands more than 24 hours after the reported start (the stored AgentRun is unaffected).

#### Idempotent reporting (optional)

`tasks/report` accepts an optional `idempotencyKey` (opaque string, trimmed, at most 200 characters). When present, `(agentName, idempotencyKey)` uniquely identifies the logical report: a retried request with the same key and the same payload returns the original `agentRunId` (with `duplicate: true`) without creating another `AgentRun` or re-running PR-fix resolution — the stored resolution is replayed when it has been persisted, and while the original report is still completing (or if its persistence failed) the retry receives an explicit `action: "skipped"` resolution instead; side effects are never repeated either way. Reusing the same key with a different payload is rejected with `409`, as is a claim that exists without a recorded result (only possible if the referenced run was deleted). An unexpected persistence failure returns a structured `500` — a worker that retries after it lands in the duplicate branch above. If a referenced `AgentRun` is later deleted, its claim stays behind and further retries with that key return `409`; the recovery is for the worker to proceed under a fresh key, or for an operator to delete the stale `AgentReportDedupe` row. Reports that omit the key keep the current at-least-once behavior. Workers that may crash between reporting and recording the result locally should derive the key from a durable per-run identity (for example `"<work-item-id>:<lifecycle-event>"`); Dispatch treats the value as fully opaque. Keys are persisted in Dispatch's database — do not embed secrets or personal data in them.

### Worker Boundaries

Workers must respect these constraints:

* **Do not merge PRs.** Workers never merge pull requests.
* **Do not groom through external harnesses.** The `groom` task type and `?mode=groom` were retired (#1200). Use the hosted groomer.
* **Do not claim another issue after finishing one task.** Report outcome and stop. The next heartbeat fetches the next task.
* **Report outcome and stop.** Every heartbeat executes at most one task.

### Source of Truth

* **GitHub Issues and PRs remain the source of truth.** Dispatch's Postgres is a cache; do not write back to it as if it were authoritative.
* **Do not rely on GitHub Projects.** The Projects board is deprecated for this workflow — group by repository instead.
* **Do not auto-close issues without explicit evidence of completion.** A green pipeline, merged PR, or human approval is required.

### Failure Modes

* **`next-task` failure:** If the endpoint returns an error, log a warning and stop — do not start the model.
* **`tasks/report` failure:** If reporting fails after execution, log a warning and stop. The work was completed; the report is best-effort visibility.
* **Optional sync failure:** Log as a freshness warning. Never block task execution.
* **`POST /api/issues/claim` returns `409 "Ownership release is pending on this issue"` (#1254):** the ownership reconciler is releasing a previously abandoned claim on that issue and its two-sided release barrier holds every claim until the release settles (typically one sweep tick). Treat this 409 as transient: retry the claim after a short backoff, or pick different work. A maintainer `force=true` claim supersedes the pending intent instead of waiting.
* **Tokens are secrets.** Never log, echo, or persist `DISPATCH_WORKER_TOKENS`, a worker's `WORKER_BEARER_TOKEN`, `DISPATCH_AGENT_TOKEN`, `DISPATCH_MAINTAINER_TOKEN`, or `GITHUB_TOKEN`. Keep maintainer-tier credentials out of ordinary worker processes.

### Auditability

* Label, lane, and issue state changes that go through Dispatch mutation APIs produce AuditLog entries. Operators trace these through `/api/audit`.
* Task execution reports create AgentRun rows via `tasks/report`.

### Legacy APIs

The following endpoints remain available for internal use and backward compatibility but are **not** the primary agent workflow:

* `POST /api/sync` — optional best-effort cache refresh
* `POST /api/agent-runs` — legacy run ingestion (superseded by `tasks/report`)
* `GET /api/issues` — raw issue listing (superseded by `next-task`)
* `GET /api/agents/{name}/queue` — legacy queue endpoint (superseded by `next-task`)
* `POST /api/agents/{name}/heartbeat` — internal sync/reconcile pass; returns
  `touchedIssueUrls: []` because the sync phase is repo-scoped and carries no
  per-issue URL data. `AgentRun.touchedIssueUrls` is URL-only across all
  producers (groomer, task reports, heartbeat); non-`http(s)` entries are
  rejected by `POST /api/agent-runs`. External agent clients should treat the
  heartbeat response's `touchedIssueUrls` as always empty — do not rely on
  the field to surface per-issue URLs from sync passes.

### Detailed Worker Contract

For the detailed worker execution contract (PR fix queue precedence, duplicate PR avoidance, hard completion gates, branch naming conventions, failure response format), see [docs/worker-execution-contract.md](../../../docs/worker-execution-contract.md). This supersedes ad-hoc behavior and applies to all agent workers.

### Generic Harness Loop

For harness-agnostic integration examples (curl, OpenClaw, Codex, Claude Code), see [docs/generic-harness-loop.md](../../../docs/generic-harness-loop.md).

### Worker Cron Prompt Migration

Worker cron prompts have been migrated from GitHub Project board readers to Dispatch queue APIs. For migration details, affected cron jobs, and the deprecation of board-reading scripts, see [docs/worker-cron-prompt-migration.md](../../../docs/worker-cron-prompt-migration.md).

### Release cut process

Dispatch follows semver. Releases are started from **Actions → Manual Release → Run workflow** after notable fixes or features merge.

1. Enter the package version without a `v` prefix (for example `0.5.4`) and operator-focused Markdown release notes.
2. Follow the linked version-bump PR. It auto-merges after the protected branch checks pass.
3. `Publish Release` verifies the two package version files, creates `v<version>` at the merge commit, and publishes the supplied notes.

The tag triggers `Build Dispatch Image`, which publishes `ghcr.io/misospace/dispatch:<version>`. Do not use generated notes; keep the workflow input focused on user-visible fixes, features, and material maintenance.

## Focused review procedure

- Treat this contract as normative for the worker API. Check changed endpoints and state transitions against the exact request/response and failure behavior documented here.
- For auth or queue changes, verify bearer-token tiering and authorization happen before data access or mutation; do not leak agent/GitHub tokens into logs, storage, or responses.
- For task reporting changes, test retries, duplicate/idempotency keys, missing or stale run references, and the distinction between GitHub's authoritative issue/PR state and Dispatch's cached state.
- For worker-loop changes, verify a heartbeat still executes at most one task, does not claim a second issue after finishing, does not merge PRs, and reports the outcome before stopping.
- Prefer contract tests for HTTP status, response schema, auth boundaries, and failure behavior. A green build alone does not establish compatibility with existing workers.
