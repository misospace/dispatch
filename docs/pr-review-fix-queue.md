# PR review-fix queue

> **Issue:** [misospace/dispatch#113](https://github.com/misospace/dispatch/issues/113)

Dispatch represents PR review-fix work as first-class assignment-layer queue items in the `PrFixQueueItem` model, with `PrFixHistory` preserving audit events. This is the native, authoritative flow — no workspace-local JSON queue is required.

## Queue item fields

Each item is deduped by `(repo, pr)` and stores:

- `repo`, `pr`, `branch`, `url`, `title`
- optional source `issue` (extracted from PR title/body)
- `lane`: `NORMAL`, `ESCALATED`, or `NEEDS_HUMAN`
- `status`: `QUEUED`, `FIXED`, `BLOCKED`, `STALE`, or `IGNORED`
- `reason`, `feedback[]`, `evidenceKeys[]`
- `headSha` and `author` metadata
- `generation` — Dispatch-owned work generation (see below)
- `queuedAt`, `updatedAt`, and history entries

## Ingestion paths

Dispatch accepts PR follow-up events through two paths that converge on the same ingestion logic:

### Pull-based sync

`POST /api/pr-followup/sync` periodically scans tracked repos for bot-authored PRs and collects:

- New comments on bot-authored PRs (excluding self-comments)
- `CHANGES_REQUESTED` reviews
- Failing check runs (`failure`, `cancelled`, `timed_out`, `action_required`)
- Problematic merge state changes (`behind`, `dirty`, `unstable`, `has_hooks`)

Configuration:

| Env Var | Description | Default |
|---------|-------------|---------|
| `PR_FOLLOWUP_BOT_IDENTITIES` | Comma-separated GitHub logins whose PRs are eligible | `github-actions[bot]` |
| `PR_FOLLOWUP_BRANCH_OWNERS` | Comma-separated repo owners allowed for queueing | All (opt-in safety) |

### Real-time webhooks

`POST /api/pr-followup/webhook` receives GitHub events in real-time:

- `pull_request_review` — CHANGES_REQUESTED reviews
- `pull_request_review_comment` — review comments on PRs
- `issue_comment` — comments on PRs (when linked to an issue)
- `check_run` — failing CI checks
- `pull_request` — merge state changes

Signature verification uses HMAC-SHA256 with `WEBHOOK_SECRET`.

**Fail-closed default:** If `WEBHOOK_SECRET` is not configured, requests are
rejected with a 503 response unless `WEBHOOK_GATEWAY_MODE` is explicitly set to
`"true"` (indicating the endpoint is behind an API gateway that handles its own
authentication and signature verification).

A related endpoint, `POST /api/issues/webhook`, ingests GitHub `issues`
`labeled`/`unlabeled` events directly into the issue label cache using the same
signature-verification model (see the `WEBHOOK_SECRET` row in the README).

## Feedback classification

Incoming feedback is classified as **actionable** or **needs_human**:

- **Actionable** → `NORMAL` lane: specific error messages, test failures, code-level fixes, lint complaints
- **Needs human** → `NEEDS_HUMAN` lane: vague requests, missing context, security-sensitive changes without specifics

Items in the `NEEDS_HUMAN` lane receive `BLOCKED` status and are excluded from the normal agent queue unless `include_blocked=true`.

## Endpoints

### Enqueue

`POST /api/pr-fix-queue/enqueue` — Creates or updates a queue item. Requires `DISPATCH_AGENT_TOKEN` bearer auth. Duplicate evidence keys are not added twice; new feedback and metadata append to the existing `(repo, pr)` item.

**Request body:**
```json
{
  "repo": "org/repo",
  "pr": 42,
  "lane": "normal",
  "reason": "PR review: CHANGES_REQUESTED",
  "feedback": "Change X to Y",
  "evidenceKey": "review:org/repo#42:123"
}
```

### List queued items

`GET /api/pr-fix-queue/queued?lane=normal&include_blocked=false` — Returns queued items for a lane, ordered by `queuedAt`, `repo`, then `pr`. Requires auth.

### Mark item status

`POST /api/pr-fix-queue/mark` — Marks an item `FIXED`, `BLOCKED`, `STALE`, or `IGNORED` and records a history event. Requires auth.

**Request body:**
```json
{
  "repo": "org/repo",
  "pr": 42,
  "status": "fixed",
  "note": "Pushed fix and validation passed",
  "generation": 2
}
```

`generation` is **required for bearer (agent/bridge) marks** — a bearer request without it is rejected with `400` (`generation is required for agent/bridge marks (#1074)`) — and optional for operator paths (OIDC session, basic auth, disabled mode), which keep the unconditional behavior for compatibility. When supplied, the write is generation-conditional: if the item's current generation no longer matches, the request is rejected with `409` and nothing is mutated (the caller's read predates a re-issued attempt). A `FIXED` mark additionally re-reads the item's per-attempt `attemptHeadSha` baseline before writing; if the PR head has not moved since the attempt was recorded, the item is refused `FIXED` (back to `QUEUED`, or `BLOCKED` once the attempt cap is spent) — and the refusal never transiently stores `FIXED`. Every fresh attempt (enqueue reopen, requeue, mark back to `QUEUED`, refusal) records its baseline from the newest head Dispatch has observed, so a sync that sees the worker's push before its report cannot turn a real fix into a refusal. A mark for an unknown item returns `404`.

## Assignment queue behavior

`GET /api/agents/:agentName/queue` prepends queued PR review-fix items before ranked issue work. This preserves the worker contract: review-fix work is consumed before selecting new board work.

Lane filtering applies to both PR-fix items and issue work:

| `lane` param | PR-fix filter | Issue filter |
|--------------|---------------|--------------|
| `normal` | `NORMAL` lane, `QUEUED` status only | `normal` lane, excludes `backlog` |
| `escalated` (or `gpt` as a deprecated compatibility alias) | `ESCALATED` lane, `QUEUED` status only | `escalated` lane |
| *(none)* | All lanes, `QUEUED` status only | Excludes `backlog` and `done` |

The implementation is generic: there are no hardcoded agent names or repository names.

## Deduplication

Items are deduplicated by `(repo, pr)`. When the same PR receives additional feedback:

- New feedback strings are appended (up to 12, unique)
- New evidence keys are appended (up to 40, unique)
- Metadata (branch, title, headSha, author) is refreshed
- A new `PrFixHistory` entry records the enqueue action

## Agent workflow for PR fixes

Workers consuming from the agent queue should:

1. Check `GET /api/agents/{agentName}/queue?lane=normal` — PR-fix items appear first in the response array
2. For each `type: "pr-review-fix"` item:
   - Verify the PR is still open and authored by the expected bot account
   - Checkout the queued branch, fetch latest changes
   - Read `feedback[]` to determine requested fixes
   - Apply minimal changes, validate locally
   - Push to the same branch, comment on the PR
   - Mark fixed via `POST /api/pr-fix-queue/mark` with `status: "fixed"`
3. If no PR-fix items remain, consume from ranked issue work

## Work generation identity

Each queue item carries a Dispatch-owned `generation` (integer, starts at `1`). `GET /api/agents/{agentName}/next-task` surfaces it on `followup-pr` tasks that are backed by a queue item:

```json
{
  "type": "followup-pr",
  "pullRequest": { "repoFullName": "org/repo", "number": 42 },
  "prFixItem": { "id": "cktz...", "generation": 2 }
}
```

- `prFixItem.id` — stable for the persistent `PrFixQueueItem` row.
- `prFixItem.generation` — changes only when Dispatch creates a fresh dispatchable attempt: an explicit requeue from `BLOCKED` or `FIXED`, genuinely new evidence reopening a resolved item, recovery from a no-progress `FIXED` tombstone (#940), or the refused-`FIXED` head-SHA rollback. Repeated reads, repeated sync of known evidence, and updates that stay within the same active attempt never change it.

Together the pair answers "which distinct unit of PR-fix work is this". Consumers should treat `(id, generation)` as opaque work identity — for example, to key their own per-attempt records — and must not derive queue policy from the number. `generation` is an integer; the SHA-256 hex derivation from this change's first revision was superseded before ever shipping, so no released contract exposed a string form. Follow-up tasks discovered by linked-PR health are materialized into a `PrFixQueueItem` before hand-out and therefore always carry `prFixItem` (see "Linked-PR follow-up ownership" below); a hand-out never ships without one.

For downstream consumers that also report results through `POST /api/agents/{agentName}/tasks/report`: reports accept an optional opaque `idempotencyKey` that makes retries safe — a retry with the same key and payload returns the original `agentRunId` (with `duplicate: true`) and never re-runs PR-fix resolution; the stored resolution is replayed when it has been persisted, and otherwise the response carries an explicit `action: "skipped"` resolution. The same key with a different payload is rejected with `409`, as is a claim whose referenced run was deleted; an unexpected persistence failure returns a structured `500` whose retry lands in the duplicate branch. Full contract: "Idempotent reporting" in AGENTS.md.

**Attempt-token settlement.** `tasks/report` accepts the attempt token as `prFixItem: { id, generation }` — the same pair `next-task` issued on the `followup-pr` task the worker was dispatched. The token is the settlement authority for the PR-fix queue:

- **Token present** → the report settles exactly that item + generation. A missing item, a report repo/PR that doesn't match the token's item, a stale generation (the attempt was re-issued after dispatch: new evidence, requeue, refused-`FIXED` rollback), or an already-settled status all produce an `action: "skipped"` resolution with no mutation. Every status write in settlement is generation-conditional, so a concurrent re-issue between the check and the write still lands as a no-op (commit-time revalidation).
- **Token absent** (legacy report) → the queue is **never** mutated: the report matches the item (so the response stays informative) but takes no action and makes no GitHub calls. A worker that was never issued an attempt can no longer settle an item.

The token is part of the report's canonical payload, so it participates in `idempotencyKey` replay semantics: a retry with the same key and a different `prFixItem` is a `409`, exactly like any other payload change.

## Linked-PR follow-up ownership (#1145)

The queue is the single owner of dispatchable follow-up attempts. Linked-PR
health (failing checks, requested changes, merge conflicts) is only a
*discovery* signal: it never produces a task of its own.

- **Any existing row wins.** If a `PrFixQueueItem` exists for the PR — in any
  status, any lane — the linked-PR scan defers to it. A `BLOCKED` /
  `NEEDS_HUMAN` verdict is never bypassed.
- **First discovery materializes.** A PR with follow-up health and no queue row
  is created as a real row (lane derived from the issue's lane: default →
  `NORMAL`, escalation → `ESCALATED`, otherwise `NORMAL`) with an `enqueue`
  history entry, then handed out through the normal generation flow. Creation
  is create-only against the `(repo, pr)` unique key: a concurrent
  `enqueuePrFixItem` wins and its row is never mutated or reopened.
- **`needs-human` PRs are skipped.** The label is read from the PR, which is
  where `surfacePrFixBlocked` applies it. If the label read fails, the
  candidate is skipped for that poll rather than materialized — a transient
  GitHub failure must not be what bypasses a human-intervention verdict.
- **No identity-less hand-outs.** A worker is never issued a `followup-pr`
  task without a `prFixItem: { id, generation }` token, so dropping a task no
  longer causes it to be re-served on every poll.

### The owning issue is deferred from implement pickup

While the queue owns a PR for this poll, the linked *issue* is withheld from
ordinary implement work for that poll. Without this, a worker handed the issue
as an `implement` task would push to the very PR the queue is holding back —
bypassing a `BLOCKED` verdict and re-creating the starvation loop. The same
applies to an issue whose PR-fix item was already handed to this agent.

`next-task` then returns the next independent issue, or idles with a
distinguishing reason:

```json
{ "type": "idle", "shouldRun": false,
  "reason": "No work available (2 ready issues deferred: linked PR follow-up is owned by the PR-fix queue)" }
```

A grooming-admission hold and a queue-owned deferral are reported together when
both apply. Note the deferral is **not** time-bounded: an issue whose PR sits in
`BLOCKED` stays deferred until an operator requeues or resolves the item, or
until a health reconcile observes the PR closed.

## Status lifecycle

```
QUEUED → FIXED (completed)
QUEUED → BLOCKED (needs human review)
QUEUED → STALE (no longer relevant)
QUEUED → IGNORED (deliberately skipped)
```

`NEEDS_HUMAN` lane items start with `BLOCKED` status and require explicit marking to change state.

### Attempt cap

`PR_FIX_MAX_ATTEMPTS` (default 5) bounds dispatched fix attempts per item, tracked as `fixAttempts`. An item starts at attempt 1; each return to `QUEUED` (new evidence after a fix, the #940 no-progress reopen, a mark back to `QUEUED`, a refused no-push `FIXED`) is another attempt. Once the count reaches the cap, the next return goes to `BLOCKED` in the `NEEDS_HUMAN` lane instead. Evidence that lands while the item is already `QUEUED`, such as the other inline comments of the same review, is the same attempt and never counts. `POST /api/pr-fix-queue/requeue` resets the count to 1.
