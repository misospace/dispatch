# Needs Attention View (#1541)

Dispatch tracks a lot of workflow state. The Needs Attention view groups the
part of that state where a person can unblock the work. It is a projection:
Dispatch derives it from records it already stores, and it writes nothing.
There are no new labels and no new statuses.

## Where to find it

- UI: the **Attention** page in the header navigation (`/attention`).
- API: `GET /api/needs-attention`. Maintainer tier only. Responses carry
  `Cache-Control: no-store`.

## What appears

Each item carries a bounded category, a repo and issue or PR identity, a
reason, an age, and a link when one exists. Groups sort by urgency, then by
age, oldest first.

| Category | Source record | Meaning |
|---|---|---|
| Human decision | `PrFixQueueItem` `BLOCKED` with outcome `human_decision` | A worker escalated a decision. The item shows the question, the options, and the evidence. |
| Semantic conflict | `PrFixQueueItem` `BLOCKED` or `PARKED` with type `MERGE_CONFLICT` or `REBASE` | Automation refused a semantic rebase or conflict and waits for a call. |
| Security failure | `PrFixQueueItem` `PARKED` with outcome `security_failure` | A durable security failure. Only a person can act. |
| Ownership parked | `OwnershipReleaseIntent` `pending` with `parkedAt` set | An ownership release exhausted its bounded forge retries (#1254 §8.7) and parked. |
| Review ready | `AgentExecution` `AWAITING_REVIEW`, not ended | An agent finished work and the PR awaits review. |
| No-PR conclusion | `NoPrConclusion` rows | An agent concluded that no changes are needed. Clear the park or edit the issue to resume. |

## What does not appear

Healthy autonomous work, ordinary queued work, and transient retry states
stay out of the view. That includes `QUEUED` items, `WAITING_EXTERNAL` rows,
and `PARKED` items with outcome `infra_failure` or `no_progress`. These
states have bounded automated recovery, so they must not take operator
attention.

## How items leave the view

The projection holds no state of its own. When the underlying record moves,
the item disappears or reclassifies on the next read:

- Fresh evidence requeues a blocked item. The mark also clears the outcome
  and the decision payload, so the item stops being derived.
- An execution leaves `AWAITING_REVIEW` or ends.
- An operator clears a no-PR-conclusion park, or an issue content edit ends
  it.
- A parked ownership intent resolves through the reconciler.

## Files

- `src/lib/needs-attention.ts`: pure derivation. Unit tested in
  `src/lib/needs-attention.test.ts`.
- `src/lib/needs-attention-snapshot.ts`: read-only collector. It issues
  `findMany` selects only and never calls the forge.
- `src/app/api/needs-attention/route.ts`: the authenticated read route.
- `src/app/attention/`: the UI page and client.
