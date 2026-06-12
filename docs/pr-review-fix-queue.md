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
| `PR_FOLLOWUP_BOT_IDENTITIES` | Comma-separated GitHub logins whose PRs are eligible | `github-actions[bot]`, `itsmiso-ai` |
| `PR_FOLLOWUP_BRANCH_OWNERS` | Comma-separated repo owners allowed for queueing | All (opt-in safety) |

### Real-time webhooks

`POST /api/pr-followup/webhook` receives GitHub events in real-time:

- `pull_request_review` — CHANGES_REQUESTED reviews
- `pull_request_review_comment` — review comments on PRs
- `issue_comment` — comments on PRs (when linked to an issue)
- `check_run` — failing CI checks
- `pull_request` — merge state changes

Signature verification uses HMAC-SHA256 with `WEBHOOK_SECRET`. If not set, verification is skipped (e.g., behind an API gateway).

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
  "note": "Pushed fix and validation passed"
}
```

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

## Status lifecycle

```
QUEUED → FIXED (completed)
QUEUED → BLOCKED (needs human review)
QUEUED → STALE (no longer relevant)
QUEUED → IGNORED (deliberately skipped)
```

`NEEDS_HUMAN` lane items start with `BLOCKED` status and require explicit marking to change state.
