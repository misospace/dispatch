# Worker Execution Contract

## Consumed PR-fix exclusions (#1225)

`GET /api/agents/{agentName}/next-task` accepts up to 32 repeated `exclude_pr_fix` query parameters when accompanied by `exclude_pr_fix_version=1`. Each value is `<owner/repo>#<pull-request-number>@<generation>`, for example `org/repo#42@3`. Repo identity is case-insensitive/canonicalized; PR and generation are positive safe integers. The generation is the `prFixItem.generation` token returned with a `followup-pr` task. Exclusions only skip the exact canonical PR and generation; a later generation remains eligible. Malformed, oversized, repeated unsupported-version inputs fail with HTTP 400 before queue reads or mutations.

Every successful opt-in response includes `prFixExclusions: { version: 1, skipped: [...] }`. Each skipped entry contains `repoFullName`, `pullRequestNumber`, `generation`, `phase` (Dispatch queue status or `linked` before materialization), and `reason: "client-excluded"`. The list is deduplicated and bounded by the 32 request entries. Empty `skipped` means none of the supplied identities were encountered, not that those PRs are complete. An idle response mentioning client exclusions distinguishes skipped work from an empty queue; queue metrics and stored eligibility are not changed.

Clients must enable this contract only when deployment configuration confirms server support. Do not probe an unknown server by sending exclusions to `next-task`: an older server may ignore them and stamp excluded work before returning. For older/unknown servers, retain the old polling contract and stop on a consumed head rather than repeatedly polling or clearing/requeueing it. A missing acknowledgement is a protocol mismatch: stop discovery, do not retry blindly. Bound a discovery pass to one request with at most 32 consumed identities; if more identities are retained, stop and surface that limit rather than cycling requests.

Exclusions never clear/requeue parked work, change attempt limits, alter lane eligibility, or assert that an open PR is done. Courier phases (`Failed`, `NeedsHuman`, `AwaitingReview`, running or pending) are client-owned: clients explicitly exclude the exact Dispatch generation associated with a consumed head, regardless of its retained Courier phase. Keep the original opaque lifecycle/source ID and `immutableSourceAgent`; canonical repo/PR identity is only the exclusion key, not a replacement source ID. Dispatch does not create Courier CoderRuns. Unique repo/PR materialization remains transactional; conditional per-agent generation handout recording fences concurrent polls by the same agent. Different agents retain existing handout semantics; Courier must atomically deduplicate its own canonical run creation across them.

> **Issue:** [misospace/dispatch#65](https://github.com/misospace/dispatch/issues/65)
> **Date:** 2026-05-16

This document defines the generic execution contract for any agent worker consuming work from Dispatch queues. It supersedes ad-hoc behavior and ensures consistency across all workers regardless of identity or repository.

## Table of Contents

- [Token Tiers](#token-tiers)
- [One Item Per Run](#one-item-per-run)
- [PR Fix Queue Precedence](#pr-fix-queue-precedence)
- [Duplicate PR Avoidance](#duplicate-pr-avoidance)
- [Existing PR Update Behavior](#existing-pr-update-branch-work)
- [New Issue Work — Branch Naming](#new-issue-work-branch-naming)
- [Hard Completion Gate](#hard-completion-gate)
- [Failure Response Format](#failure-response-format)
- [Queue Consumption Rules](#queue-consumption-rules)

---

## Token Tiers

Dispatch bearer tokens have two tiers. A **worker** token may call exactly:

- `GET /api/agents/{agentName}/next-task`, `POST /api/agents/{agentName}/tasks/report`, `POST /api/agents/{agentName}/heartbeat`, `GET /api/agents/{agentName}/active-work`, `GET /api/agents/{agentName}/queue`, `GET /api/agents/{agentName}/work-summary`
- `GET /api/agent-work` (scoped to the caller's own agent), `POST /api/agent-work/start`, `POST /api/agent-work/checkpoint`, `POST /api/agent-work/finish`
- `POST /api/issues/claim` (without `force`) and `POST /api/issues/unclaim` (for the caller's own agent)
- `GET /api/issues/state`, `POST /api/issues/status` (status only for issues assigned to the caller's own agent)
- `GET /api/issues`, `GET /api/pr-fix-queue/queued`, `GET /api/pr-fix-queue/history`
- `POST /api/pr-fix-queue/mark` with `FIXED`, `BLOCKED`, `PARKED`, `STALE`, or `WAITING_EXTERNAL` (generation required; hand-out-bound #1428: a bound worker may only settle rows whose `agentHandouts` carry its own `<agentName>@<generation>` marker at the settled generation — a row it does not hold returns `403` with `reason: "not-handed"`, and the legacy unbound `DISPATCH_WORKER_TOKEN` is refused on this route)
- `POST /api/pr-fix-queue/ack` (the durable hand-out acknowledgement, see "Hand-out acknowledgement" below)

The **maintainer** token (`DISPATCH_AGENT_TOKEN`, or the `DISPATCH_MAINTAINER_TOKEN` alias) keeps full rights and acts on any agent's behalf. A worker token calling a maintainer-only route gets an HTTP 403 naming the required tier: force claims, `QUEUED`/`IGNORED` marks, `POST /api/pr-fix-queue/requeue`, and the `POST /api/pr-fix-queue/sweep` reclaim job are maintainer-only. Unclaim is not tier-gated — the target agent is bound to the caller and is only bounded by the assignment check; the legacy `DISPATCH_WORKER_TOKEN` falls back to the request body, but `DISPATCH_WORKER_TOKENS` overrides that with a token-derived identity. A `DISPATCH_WORKER_TOKEN` value that duplicates a maintainer token resolves to the lower worker tier (fail-closed) and logs a one-time boot warning — set it to a distinct value.

### Bound worker identity (#1129)

Worker credentials are **bound to an agent name** so the caller's identity is derived from the token, never from a self-reported `x-agent-name` header or a request-body `agentName`:

- Configure bound credentials with `DISPATCH_WORKER_TOKENS`, a comma- or newline-separated list of `agentName:token` pairs, e.g. `alpha:<token-a>,bravo:<token-b>`. Multiple tokens may map to the same agent for rotation.
- A bound worker may only act for its own agent. It cannot read another agent's task state (`next-task`, `active-work`, `queue`, `work-summary`), report another agent's task, start/checkpoint/finish another agent's work, claim/unclaim for another agent, list another agent's work (`GET /api/agent-work` is forced to the bound agent), or set status on an issue not assigned to it.
- A token bound to two different agents is ambiguous and is rejected everywhere (fail-closed). A bound token whose value duplicates a maintainer token resolves to the lower worker tier with its binding intact. Misconfigurations log a one-time warning naming the env vars but never the token value.

### Legacy migration window

The single `DISPATCH_WORKER_TOKEN` is a **legacy, unbound** credential. It carries no agent identity, so it cannot satisfy the identity-scoped routes above: `next-task`, `tasks/report`, `heartbeat`, `active-work`, `queue`, `work-summary`, `agent-work` start/checkpoint/finish, `issues/claim`, `issues/unclaim`, and `issues/status` return **403** for it. It remains accepted, as a migration-window fallback, only for the identity-free worker routes (`GET /api/issues`, the PR-fix queue reads, and PR-fix `mark`), and a deprecation warning is logged at boot. Migrate every worker deployment to `DISPATCH_WORKER_TOKENS` (or a maintainer token) before removing the legacy variable.

## Hand-out acknowledgement (#1211)

A worker that receives a `followup-pr` task acknowledges it **after durably creating the run that owns the work** (e.g. after creating the executor `CoderRun`), via `POST /api/pr-fix-queue/ack`:

```
POST /api/pr-fix-queue/ack
Authorization: Bearer <token>
Content-Type: application/json

{ "repo": "org/repo", "pr": 42, "generation": 2, "agentName": "courier" }
```

The route is bearer-only (basic / OIDC sessions are rejected with 403). The subject of the ack is the body's `agentName` (#1425): a worker-tier caller must be **bound** to that agent (`DISPATCH_WORKER_TOKENS`; the legacy unbound `DISPATCH_WORKER_TOKEN` is refused with 403), while a maintainer token may ack for any agent — the write itself is pinned to the hand-out table and refuses `403 not-handed` for any agent that was never handed the stamped generation. The body's `agentName` is **not** compared against the audit-only `x-agent-name`-derived actor, so clients that send their binding only in the body (no identity header) are honored. The underlying write is generation-pinned and idempotent. See `docs/pr-review-fix-queue.md` for the full contract.

A worker that cannot ack (because the hand-out stamp does not include its agent identity, e.g. a multi-agent dispatch raced) gets a `403 not-handed` response and should retry against a freshly-issued hand-out. The reclaimer sweep below is maintainer-only and **default-disabled** until every worker is confirmed to call ack.

---

## Retired external grooming

`GET /api/agents/{agentName}/next-task?mode=groom` returns `410 Gone` and no task. The external `groom` task and report contract are retired (#1200). Use hosted grooming through `POST /api/groomer/run` or the Hosted Groomer page. Decommission external pollers and unnecessary GitHub write credentials; normal implementation and PR-fix tasks are unaffected.

---

## One Item Per Run

A worker must handle **exactly one** queue item per execution:

- Either one PR fix from the PR review-fix queue, or
- One issue from the normal (or Escalated) assignment queue.

Workers must not batch multiple issues or PR fixes into a single run.

---

## PR Fix Queue Precedence

Before selecting any work from the assignment queue, the worker **must** check the PR review-fix queue via Dispatch APIs:

1. Query `GET /api/agents/{agentName}/queue?lane=normal` — PR-fix items are returned first in the response array (before ranked issue work).
   - Alternatively, query `GET /api/pr-fix-queue/queued?lane=normal` directly for PR-fix items only.
2. For each item with `type: "pr-review-fix"`:
   - Verify the PR is still open and authored by the expected bot account.
   - If the task was issued via next-task with a prFixItem token, acknowledge the hand-out after the run is durably created so the stale hand-out reclaimer does not reopen a live attempt: `POST /api/pr-fix-queue/ack` with `{ repo, pr, generation, agentName? }` (MCP `ack_pr_fix`). The ack is generation-pinned and idempotent; an unacknowledged hand-out older than `PR_FIX_HANDOUT_TIMEOUT_MS` (default 30m) is reclaimed by the scheduled pr-fix-sweep. An ACKNOWLEDGED hand-out stays protected only while its owner shows liveness: past `PR_FIX_ACK_LIVENESS_MS` (default 24h) a generation whose acking agent produced no recent `AgentRun` activity is reclaimable by the dead-owner recovery ladder (#1419) — keep heartbeating per task cycle and report through `tasks/report` so a live attempt is never treated as dead and re-run.
   - Verify the head owner matches the trusted owner (`misospace` or `joryirving`).
   - Fetch origin, checkout the queued branch, pull/rebase as appropriate.
   - Read the item's `feedback[]` array to determine the requested fix (from PR comments, reviews, and check failures).
   - Apply the smallest possible change that satisfies the feedback.
   - Validate locally (lint, typecheck, tests).
   - Commit, push to the **same** branch, comment on the PR with what changed and validation results.
   - Mark the queue item `fixed` via `POST /api/pr-fix-queue/mark`:
     ```bash
     curl -s -X POST "DISPATCH_URL/api/pr-fix-queue/mark" \
       -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"repo":"org/repo","pr":42,"status":"fixed","note":"Pushed fix + validation passed"}'
     ```
   - End the run — do not process additional items.
3. If no PR-fix items remain, proceed to normal issue selection from the agent queue.

Issue queue responses exclude claimed issues by default. Any issue with an `agent/*` label is treated as claimed and is omitted from `GET /api/agents/{agentName}/queue?lane=normal` unless the request includes `includeClaimed=true` for manual recovery or dashboard views.

> **Never open a new PR for a queued PR fix.** The worker only pushes to the existing branch.

---

## Duplicate PR Avoidance

Before starting work on any issue, the worker **must** check whether an open PR already exists:

1. Search for open PRs matching the issue number (e.g., `gh pr list --state open --search "{number}"`).
2. If an open PR exists:
   - Do **not** open a duplicate PR.
   - Checkout that PR's branch.
   - Evaluate whether additional work is needed (failed checks, review requests, merge blockers).
   - If work is needed: apply the smallest fix, validate, commit if needed, push to the same branch, verify with `gh pr view`, and end.
   - If no work is needed: move the issue card to In Progress and end.

---

## Existing PR Update Behavior

When updating an existing PR (from the duplicate-check step above):

1. Checkout the PR's branch directly (by PR number or head ref).
2. Apply changes on top of the existing branch — do not create a new branch.
3. Validate locally before pushing.
4. Push to the same branch (`git push origin <branch>`).
5. Verify with `gh pr view` that the PR reflects the changes.
6. End with the PR URL.

---

## New Issue Work — Branch Naming

When no open PR exists for an issue, create a new branch using this convention:

```
fix/issue-{number}-{short-description}
```

Examples:
- `fix/issue-65-worker-contract`
- `fix/issue-144-version-drift`

Rules:
- Use the GitHub issue number.
- Short description: kebab-case, ≤ 3 words, capturing the essence of the fix.
- Prefix with `fix/` to distinguish from feature or other branches.

---

## Hard Completion Gate

A local commit is **not** completion. After any commit, the worker **must** complete the following sequence in order:

| Step | Action | Failure Behavior |
|------|--------|------------------|
| 1 | `git push` to origin | If push fails → end with `Stuck: {reason}.` |
| 2 | `gh pr create` (new work) or verify existing PR (update work) | If create fails → end with `Stuck: {reason}.` |
| 3 | `gh pr view` to verify the PR URL and state | If view fails → end with `Stuck: {reason}.` |
| 4 | Final response containing the verified PR URL | — |

The worker must not end until step 4 is complete. If any step in the sequence cannot be performed (network failure, auth error, API rate limit), the worker ends immediately with:

```
Stuck: {reason}.
```

Where `{reason}` describes what failed and why (e.g., `push rejected due to protected branch`, `gh pr create failed: already exists`).

---

## Failure Response Format

When a worker cannot complete its task, it must end with exactly this format:

```
Stuck: {reason}.
```

Where `{reason}` is a brief, specific description of the failure (one sentence). Examples:

- `Stuck: git push rejected — branch protected and force-push not allowed.`
- `Stuck: gh pr create failed — API rate limit exceeded, retry after 120s.`
- `Stuck: unable to fetch origin — network unreachable.`

Do not include stack traces, tokens, or debug output in the final response.

---

## Queue Consumption Rules

### PR Fix Queue

PR review-fix items take precedence over all issue work. Workers must check for pending PR-fix items before consuming from the issue queue.

PR-fix items are returned via:
- `GET /api/agents/{agentName}/queue?lane=normal` — PR-fix items prepended to response array
- `GET /api/pr-fix-queue/queued?lane=normal` — PR-fix items only

Mark completion via `POST /api/pr-fix-queue/mark`:
```bash
curl -s -X POST "DISPATCH_URL/api/pr-fix-queue/mark" \
  -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"org/repo","pr":42,"status":"fixed"}'
```

Valid statuses: `FIXED`, `BLOCKED`, `PARKED`, `STALE`, `IGNORED`, `WAITING_EXTERNAL`. `WAITING_EXTERNAL` defers the consumed generation for the configured cooldown; it neither charges an attempt nor signals prerequisite readiness. A duplicate `WAITING_EXTERNAL` mark at the same generation is answered idempotently, but a bound worker credential receives `403` `not-handed` unless it is the agent recorded as having started that wait (#1430); retry the wait with the same credential that started it.

### Normal Lane

The normal lane contains concrete, scoped, testable work items:
- Bounded frontend/backend fixes
- Documentation updates
- Tests and CI/lint improvements
- Release/version drift fixes
- Dependency updates
- Concrete follow-up issues with clear acceptance criteria

Workers consume one item per run from the normal lane's queue endpoint.

### Escalated Lane

The Escalated lane contains work requiring higher-judgment model support:
- Architecture, security, or API boundary design
- Database/schema migration strategy
- Distributed/cross-service design decisions
- Ambiguous product behavior resolution
- Broad refactor planning
- RFC/design/alternatives evaluation
- Audit parent decomposition

Workers consume one item per run from the Escalated lane's queue endpoint.

### Lane Selection

Workers receive their lane via the queue endpoint's `lane` query parameter:
- `GET /api/agents/<name>/queue?lane=normal`
- `GET /api/agents/<name>/queue?lane=escalated` (also accepts `lane=gpt` as a **deprecated compatibility alias** — do not use in new docs)

BACKLOG issues are excluded from the normal agent queue by default.

### Renovate Issue Exclusion

Renovate-created issues (dependency dashboards, update PRs, etc.) are **filtered out of Dispatch issue surfaces**. This keeps the Board, Projects, lane summaries, grooming intake, and agent queues focused on normal issue work instead of dependency bookkeeping.

Detection heuristics (author detection is not available since the Issue model does not store author):
- Title contains `Dependency Dashboard`
- Title starts with `Update dependency`, `Update image`, or similar Renovate patterns
- Labels: `renovate`, `dependencies`, `automated`

Renovate exclusion applies to issue queue items only, not PR review-fix queue items.

---

## Linking

This contract is referenced from:
- [AGENTS.md](../AGENTS.md) — Agent Workflow Contract section
- [Generic Harness Loop](./generic-harness-loop.md) — harness-agnostic integration examples

## Relationship to next-task

Workers using the canonical `next-task` endpoint automatically receive PR-fix items before issue work. The `next-task` endpoint handles PR-fix queue precedence, linked PR follow-up detection, and idle checks internally. This contract documents the detailed execution rules that apply regardless of how a worker discovers its task.

Linked-PR follow-up is a discovery signal only: the PR-fix queue is the single owner of dispatchable follow-up attempts, and a discovered PR is materialized into a `PrFixQueueItem` before it is handed out. While the queue owns a PR, its issue is withheld from implement pickup for that poll, so `next-task` returns the next independent issue or an idle task whose reason distinguishes the deferral from a grooming-admission hold. See [PR review-fix queue](./pr-review-fix-queue.md#linked-pr-follow-up-ownership-1145).

---

## History

- **2026-09-28** — Added Token Tiers section: worker-tier endpoint allowlist and maintainer-only actions (Issue #1111).
- **2026-05-16** — Created to document generic worker execution contract and PR completion gates (Issue #65). Consolidates existing normal-worker behavior into a reusable, agent-agnostic specification.
- **2026-06-19** — Updated Renovate issue exclusion: Renovate issues are filtered from Dispatch issue surfaces, including Board, Projects, lane summaries, grooming intake, and agent queues.
- **2026-05-19** — Added Renovate issue exclusion section: Renovate issues are excluded from agent queues by default (Issue #129).
- **2026-05-19** — Added five-column workflow with Ready status (Issue #140): Backlog → Ready → In Progress → In Review → Done. Agents pick from Ready by default; Backlog excluded unless explicitly requested.
- **2026-05-20** — Marked `lane=gpt` as deprecated compatibility alias in canonical docs; linked openclaw-agent-mc-workflow.md as historical (Issue #117).

## `already_addressed` settlement (#1121)

A fix-pr run that concludes the review feedback was already handled reports
`tasks/report` with `outcome: "already_addressed"` and an optional `evidence`
string (commit SHAs / file paths), echoing the `prFixItem.{id, generation}`
token it was issued. Dispatch settles the PR-fix queue item to FIXED WITHOUT
the #940 "PR head must have moved" guard (the run pushed nothing on purpose)
and records the evidence in the item's settlement history.

Behavioral notes:
- The PR merge-state gate is deliberately KEPT: a non-mergeable PR defers the
  settlement for the bridge reconcile pass rather than tombstoning a red PR.
- New review evidence reopens the item as a fresh attempt, as usual.
- The SAME evidence re-observed with the head unchanged reopens through the
  #940 no-progress path and counts toward `fixAttempts`; a worker and reviewer
  that keep disagreeing end BLOCKED / NEEDS_HUMAN at `PR_FIX_MAX_ATTEMPTS`
  (#1107), which is a real human decision.
- `pr-fix-queue/mark` accepts the same settlement via
  `status: "FIXED"` + `alreadyAddressed: true` + optional `evidence` (bearer
  marks still require a generation; the QUEUED/IGNORED maintainer-only gate is
  unchanged).

## Fenced capacity-exhaustion handoff (#1256)

A worker whose execution capacity cannot run a handed attempt returns it with
an explicit, token-fenced handoff instead of failing or silently stalling:

- PR-fix attempt: `tasks/report` `outcome: "capacity-exhausted"` + issued
  `prFixItem` token (including its per-hand-out `handoutToken` receipt) +
  `capacity`. The release is fenced to the exact issued hand-out: only that
  hand-out is removed, other agents' live hand-outs at the generation survive,
  and the item stays QUEUED at the same generation and fixAttempts; the
  cooldown is scoped to the exhausted capacity only (trusted caller-declared
  scoping — never identity, never agent-filtered).
- Claimed issue: `POST /api/issues/capacity-handoff` with the `claimToken`
  issued by the claim. Release is fenced to the exact claim and refuses human
  holds and changed ownership. An optional `settlementKey` (≤200 chars) makes
  the settlement durable: a retry with the same key and original claim token
  after the lease is gone replays the recorded success (`replayed: true`)
  with zero mutation, so a lost HTTP response cannot make a completed
  settlement unprovable (#1262).

Full contract, lease/label effects, and the GitHub-vs-database consistency
boundary: [capacity-handoff.md](./capacity-handoff.md).

## History
- **2026-10-18** — Durable settlement replay for issue capacity handoffs (#1262): optional `settlementKey` records a first-write-wins `IssueHandoffSettlement` proof before the lease CAS; identical retries replay verbatim, expired proofs and cross-claim key reuse are refused fail-closed.
- **2026-10-14** — Review follow-up (#1256): per-hand-out `handoutToken` receipts bind capacity-exhausted settlement to the exact issued source attempt (unrelated agents and rotated same-agent tokens are refused); the release preserves other agents' live receipts/acks and the dispatch stamps while any hand-out is live; a failed post-CAS live-label re-read now takes the ownership-only path (never a status transition).
- **2026-10-14** — Added fenced capacity-exhaustion handoff (#1256): capacity-scoped cooldowns for PR-fix attempts and claim-token-fenced issue recovery.

## Fenced attempt-requeue (#1491)

Courier's explicit operator retry requeues exactly ONE terminated attempt
through two routes whose wire contract is pinned cross-repo by Courier's
connector fixtures (`internal/source/dispatch/retry_test.go`,
misospace/courier#608):

- `POST /api/pr-fix-queue/attempt-requeue` — reactivate one queue-backed
  attempt: `{repo, pr, generation, agentName, fenceToken, idempotencyKey,
  note?}` → `{success, replayed, prFixItem:{id, generation}}`. Fresh
  generation, **no** `fixAttempts` advance, **no** reclaim-budget or recovery
  reset (that stays the unfenced operator reset's authority), the CI repair
  opportunity resets with the attempt state — the retry never consumes one.
- `POST /api/issues/requeue` — release one issue claim: `{issueId,
  repoFullName, issueNumber, agentName, claimToken, idempotencyKey, note?}`
  → `{success, replayed, attemptId?}`. The issue returns to offerable
  through the shared claim release (`releaseIssueClaim`, the unclaim /
  capacity-handoff path) without consuming anything and without resolving.

Fence = the receipt the run was ISSUED, validated against the durable
`AttemptIssuance` ledger (written when the claim token or hand-out token is
minted) — the terminal report already released the live receipt, so live
state can never authorize a retry and an unverifiable fence is refused.
Refusals are the closed coded-409 vocabulary `stale-generation |
superseded | item-closed | human-hold` (`{"reason": …}`); **404 is reserved
for route absence** — a per-item 404 would latch Courier's process-wide
version-skew posture. A committed `idempotencyKey` replays its original
result with zero mutation (PR-fix: `PrFixRequeueSettlement`; issue: the
shared #1262 `IssueHandoffSettlement` with `operation: "attempt-requeue"`);
key reuse with a different payload is refused the way `AgentReportDedupe`
refuses it. Auth mirrors the CI-park family: maintainer-tier bearer.
`POST /api/pr-fix-queue/requeue` stays exactly as it was: unfenced operator
reset, budget-resetting.
