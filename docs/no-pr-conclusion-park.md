# Terminal no-PR conclusion park (#1506)

A worker that ends an `implement` task without a PR can say the issue needs no
PR: `no_changes_needed`, `already_addressed`, or `already_done`. Before this
feature, that statement changed no queue state. The reconciler saw an
`status/in-review` issue with no open and no merged fixing PR, restored it to
`status/ready`, and the queue offered the same concluded work again. The offer
repeated forever until a human closed the issue (misospace/courier#665).

Now the terminal report parks the issue. `buildAgentQueue` and `next-task`
stop offering it, with no GitHub change and no close.

## What the park is

The park is one row in the `NoPrConclusion` table. It records the reporting
agent, the outcome, the summary, the evidence, and a content fingerprint: the
sha256 of the canonical issue title and body at park time. The report route
writes it inside `POST /api/agents/{agent}/tasks/report` when the task type is
`implement`, the outcome is one of the three terminal values, and the report
settles no PR-fix work (see Boundaries). The response echoes the decision in
`conclusionPark`.

The park never writes GitHub labels, never closes an issue, and never touches
`status/blocked`. The blocked label keeps its own meaning and its
blocked-reconsideration pass (docs/hosted-groomer.md) unchanged.

One live park exists per issue. A later terminal conclusion replaces it. The
lifecycle stream records `conclusion_parked` and `conclusion_cleared` events.

## When the park is live

The park is live while the stored content fingerprint equals the fingerprint
of the issue's current cached title and body.

- A human edits the title or body. The next queue read finds a mismatch, and
  the park ends. No operator call is needed. The stale row is deleted as
  housekeeping.
- A label changes. The park stays live on purpose. Status churn, including the
  reconciler's restore-to-ready, must not end a park, because that churn is
  the loop this feature stops.
- The issue closes and reopens without a content edit. The park stays live.
  Clear it with one of the operator paths below.

## How an operator ends a park

Any one of these actions retires the park:

1. `DELETE /api/issues/{issueId}/no-pr-conclusion`. Operator auth only (OIDC
   session, basic auth, or auth-disabled). Agent bearer tokens get 403. The
   call is idempotent: no park row returns `cleared: false`.
2. `POST /api/issues/status`. Any successful status set is the current
   decision on the issue, so it retires the park in the same transaction.
3. `POST /api/issues/move`. A board move retires the park the same way.
4. A maintainer force-claim (`force: true` on `POST /api/issues/claim`). The
   claim discharges the park after its own transaction commits.

`GET /api/issues/{issueId}/no-pr-conclusion` shows the stored park, whether it
is live, and the current mode. Maintainer tier only: the agent/maintainer
token, an OIDC session, basic auth, or auth-disabled mode. Worker-tier
credentials (bound or legacy unbound) are refused by the route tier gate,
because this path is not on the worker allowlist and a new route defaults to
maintainer by construction. A worker does not need the read: the report
response already echoes its own `conclusionPark`.

While a live park exists and the mode is `enforce`, `POST /api/issues/claim`
refuses a non-force claim with 409 and names the clearing paths.

## Rollout mode

| `DISPATCH_NO_PR_CONCLUSION_MODE` | Queue behavior |
|---|---|
| unset or `enforce` (default) | A live park withholds the issue from `next-task` and `/queue` pickup. |
| `audit` | Nothing is withheld. Queue items carry the `noPrConclusion` mark. |
| `off` | The queue reads no park table at all. Legacy behavior. |

An unrecognized value runs `audit` and logs one warning. A park row is always
recorded, in every mode; the mode controls only the withhold. A worker can
therefore always conclude work, and `off` removes only the effect.

Withheld items appear in the queue's withheld set with `claimable: false`
(`/queue?includeWithheld=true` lists them). The `next-task` idle note names
them as parked by a terminal no-PR conclusion, apart from grooming-admission
holds.

## Boundaries

- GitHub Issues remain the source of truth. The park is Dispatch-side queue
  policy, like the capacity cooldown and the admission override.
- The withhold applies to issue pickup. Linked-PR follow-up routing and PR-fix
  queue items are never gated, the same exception grooming admission uses.
- A report that settles PR-fix work is PR-fix work, whatever its task type
  says: it settles the queue item and never parks the issue, so a live PR-fix
  lane cannot withhold the issue it is working on. The response echoes
  `conclusionPark: { applied: false, reason: "pr-fix-settled" }`. "Settles
  PR-fix work" is the settlement's own verdict, not the presence of an attempt
  token: a report whose token settled nothing (no PR coordinates, unknown item,
  stale generation, already-terminal item) is the issue conclusion it claims to
  be and still parks, so a malformed token cannot defeat the stop that ends the
  re-offer loop.
- A park write that fails is logged, and the report still succeeds. The park
  expires on the next content edit, so a lost write cannot strand the issue,
  and a 5xx retry could not re-park anyway (the idempotency duplicate branch
  never replays side effects).
- A successful `already_done` close supersedes the park. The close is the
  harder stop, and a park that survived a human reopen would withhold work the
  human just brought back.
- A bound worker's assertion can park an issue it never held. The blast radius
  is bounded: the row names the agent, the lifecycle event names it, and every
  operator path above reverses it.
