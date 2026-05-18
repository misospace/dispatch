# PR review-fix queue integration

Dispatch represents PR review-fix work as first-class assignment-layer queue items in the `PrFixQueueItem` model, with `PrFixHistory` preserving audit events.

## Queue item fields

Each item is deduped by `(repo, pr)` and stores:

- `repo`, `pr`, `branch`, `url`, `title`
- optional source `issue`
- `lane`: `NORMAL`, `ESCALATED`, or `NEEDS_HUMAN`
- `status`: `QUEUED`, `FIXED`, `BLOCKED`, `STALE`, or `IGNORED`
- `reason`, `feedback`, `evidenceKeys`
- `headSha` and `author` metadata
- `queuedAt`, `updatedAt`, and history entries

## Endpoints

- `POST /api/pr-fix-queue/enqueue` creates or updates a queue item. Duplicate evidence keys are not added twice; new feedback and metadata refresh the existing `(repo, pr)` item.
- `GET /api/pr-fix-queue/queued?lane=normal` returns queued items for a lane, ordered by `queuedAt`, `repo`, then `pr`.
- `POST /api/pr-fix-queue/mark` marks an item `FIXED`, `BLOCKED`, `STALE`, or `IGNORED` and records a history event.

## Assignment queue behavior

`GET /api/agents/:agentName/queue` prepends queued PR review-fix items before ranked issue work. This preserves the worker contract: review-fix work is consumed before selecting new board work.

The implementation is generic: there are no hardcoded agent names or repository names.

## Compatibility path

The legacy workspace-local JSON queue is not replaced yet. It remains a compatibility preflight for existing cron workers while Dispatch exposes the database-backed queue contract. Producers can migrate to `/api/pr-fix-queue/enqueue`, and workers can migrate to the Dispatch agent queue endpoint without changing prioritization semantics.
