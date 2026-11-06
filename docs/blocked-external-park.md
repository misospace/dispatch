# Repeated blocked-settlement park (#1562)

A worker that cannot start work because of an outside blocker settles a
`blocked` or `waiting-external` outcome on an `implement` task. One such
settlement is fine: the worker explains the blocker, and Dispatch offers the
issue again later. Before this feature, Dispatch offered the issue again at
once. The next run repeated the same checks, wrote the same handoff comment,
and settled the same way. Four runs on one issue cost four lanes and burned
tokens with no new information (misospace/pr-reviewer-action#1486).

Now Dispatch counts the repeats. When the same blocker settles enough times in
a row, the report parks the issue. `buildAgentQueue` and `next-task` stop
offering it, with no GitHub change and no close.

## What the park is

The park is one row in the `BlockedExternalPark` table. The row is both the
counter and the park. It records the reporting agent, the outcome, the
descriptor (see below), a summary, the consecutive count, and a content
fingerprint: the sha256 of the canonical issue title and body at settlement
time.

The report route records it inside
`POST /api/agents/{agent}/tasks/report` when all of these hold:

- The task type is `implement`, and the report carries no `prFixItem` token.
  A token makes the report PR-fix work, and the PR-fix lane owns its own
  settlement state (WAITING_EXTERNAL with a bounded re-check cooldown).
- The outcome is `blocked` or `waiting-external`.
- The report is not an idempotent replay.
- The issue is tracked and open.
- For a worker-tier caller, the issue is live-assigned to the reporting
  agent. This is the same live-label check the no-PR conclusion park uses
  (#1510). An unreadable or unowned assignment skips the count, and the
  report still succeeds.

The response echoes the decision in `blockedExternalPark`, for example
`{ recorded: true, count: 3, threshold: 3, live: true, reason: "parked" }`.
The response does not echo the descriptor, because the descriptor can carry
report-derived text.

## The descriptor

The descriptor names the missing prerequisite. Exact string equality decides
whether a new settlement repeats the old blocker. Structured fields win over
free text:

| Report shape | Descriptor | Example |
|---|---|---|
| `waiting-external` with a valid `externalWait` contract | `wait:<kind>:<ref>` | `wait:upstream_issue:org/repo#1482` |
| `blocked` with `error` (or `summary`) text | `blocked:<16 hex digest of the normalized text>` | `blocked:9f2c...` |
| no structured contract and no text | `blocked:none` | |

The structured `blockReason` is deliberately not part of the descriptor. It
is a coarse outcome class (`human_decision`, `infra_failure`, and so on), not
a prerequisite identity. Two different prerequisites of the same class must
not accumulate into one park.

The same blocker described in the same words gives the same descriptor, so the
count grows. A different descriptor resets the count to 1: a different blocker
is new information, and the next settlement behaves like a first settlement.
Free text is fragile. If the worker words the blocker differently, the count
resets, no park forms, and the issue keeps today's behavior. The design fails
open on wording changes and never parks on a wrong match. A bare `blocked`
report with no text at all settles to the constant `blocked:none`, so three
descriptor-less blocked settlements still bound the loop; an operator clears
that park if it was not wanted.

## When the park is live

The park is live when both hold:

1. The consecutive count reached the threshold
   (`DISPATCH_BLOCKED_EXTERNAL_PARK_THRESHOLD`, default 3, clamped 2 to 10).
2. The stored content fingerprint equals the fingerprint of the issue's
   current cached title and body.

A row below the threshold is a counter. It withholds nothing, and queue reads
never delete it. A row whose fingerprint no longer matches has expired: the
issue was edited after the settlement, and that edit is fresh evidence. The
next queue read finds the mismatch, ends the park, and deletes the stale row.

- A human edits the title or body. The park ends. No operator call is needed.
  The count restarts at the next blocked settlement.
- A label changes. The park stays live on purpose. Status churn must not end a
  park, because that churn is part of the loop this feature stops.
- The issue closes and reopens without a content edit. The park stays live.
  Clear it with one of the operator paths below.

One row exists per issue. The threshold can never be 1, so the first
settlement always stays recoverable and re-offerable, as the issue requires.

## How an operator ends a park

Any one of these actions removes the row and its count:

1. `DELETE /api/issues/{issueId}/blocked-external`. Operator auth only (OIDC
   session, basic auth, or auth-disabled). Agent bearer tokens get 403. The
   call is idempotent: no row returns `cleared: false`.
2. `POST /api/issues/status`. A status set is the current human decision on
   the issue, so it ends the park in the same transaction.
3. `POST /api/issues/move`. A board move ends the park the same way.
4. A maintainer force-claim (`force: true` on `POST /api/issues/claim`). The
   claim ends the park after its own transaction commits.
5. Fresh work. A later `implement` report on the issue with an outcome that
   shows real progress or a terminal conclusion (`pr_opened`, `pr_updated`,
   `issue_updated`, `issue_closed`, `no_changes_needed`, `already_addressed`,
   `already_done`) ends the park. A `failed`, `handed-off`, or
   `capacity-exhausted` report says nothing about the prerequisite and
   changes nothing. The report ends the park on a closed issue too (a
   successful `already_done` close lands first, and a surviving row would
   revive on a reopen); while the issue is closed the clear needs no
   ownership check, because the row withholds nothing there. On an open
   issue the same ownership rule as the record applies: a worker-tier report
   may only end a park on an issue its agent owns. The report response echoes
   `blockedExternalPark: { cleared: true, reason: "fresh-outcome" }`.

`GET /api/issues/{issueId}/blocked-external` shows the stored row, the count,
the threshold, whether the park is live, and the current mode. Maintainer
tier only. Worker-tier credentials (bound or legacy unbound) are refused by
the route tier gate, because this path is not on the worker allowlist. A
worker does not need the read: the report response already echoes its own
`blockedExternalPark`.

While a live park exists and the mode is `enforce`, `POST /api/issues/claim`
refuses a non-force claim with 409 and names the clearing paths.

## Rollout mode

| `DISPATCH_BLOCKED_EXTERNAL_PARK_MODE` | Queue behavior |
|---|---|
| unset or `enforce` (default) | A live park withholds the issue from `next-task` and `/queue` pickup. |
| `audit` | Nothing is withheld. Queue items carry the `blockedExternalPark` mark. |
| `off` | Nothing is withheld and the queue reads no park table. The report hook still records settlements, so a later switch to `enforce` reflects the history the operator already saw. |

An unrecognized value runs `audit` and logs one warning. The withhold is one
of three independent holds on a queue item, beside grooming admission (#1065)
and the no-PR conclusion park (#1506). An item withheld by more than one hold
appears once in the withheld set. Withheld items carry `claimable: false`
(`/queue?includeWithheld=true` lists them).

## Boundaries

- GitHub Issues stay the source of truth. The park is Dispatch-side queue
  policy, like the capacity cooldown and the admission override.
- The withhold applies to issue pickup. Linked-PR follow-up routing and PR-fix
  queue items are never gated, the same exception grooming admission uses.
- PR-fix work never counts toward the park. A `followup-pr` settlement of
  `waiting-external` goes through the PR-fix queue, which already has a
  structured wait contract, a bounded re-check cooldown (`retryAt`), and a
  recovery policy (#1250, #1253).
- A park write that fails is logged, and the report still succeeds. A 5xx
  retry lands in the idempotency duplicate branch, which never replays side
  effects, so a lost write cannot strand the issue or double-count.
- The lifecycle stream records `blocked_external_parked` once per threshold
  crossing and `blocked_external_cleared` per clear. A settlement that lands
  on an already-live park counts silently and records no new event.

## Related work

- The #1506 no-PR conclusion park: the same ledger-plus-withhold pattern for
  terminal no-PR conclusions. See [docs/no-pr-conclusion-park.md](no-pr-conclusion-park.md).
- The #1250 external-wait contract: the structured dependency identity the
  descriptor prefers. See [docs/pr-fix-outcome-policy.md](pr-fix-outcome-policy.md).
- The #1253 recovery policy: how PR-fix holds react to fresh evidence. See
  [docs/pr-fix-recovery-policy.md](pr-fix-recovery-policy.md).
