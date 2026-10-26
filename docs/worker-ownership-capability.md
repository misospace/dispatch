# Worker Ownership Capability (#1251)

The **optional** register/renew/disposition capability and the derived
ownership read model from
[Ownership Reconciliation Design](./ownership-reconciliation.md) §4–§6 and §9,
implemented on the existing `Lease`/`AgentWork` machinery. No claim release,
label cleanup, requeue, or credential rotation happens through this capability
— bounded reconciliation and fenced release are [#1254].

## Capability endpoints

`POST /api/agent-work/ownership` with `{ operation, agentName, issueId, claimToken, ... }`.

| `operation` | Body additions | Effect |
|---|---|---|
| `register` | `runRef?` (≤500 chars) | Records durable ownership on the lease (server `registeredAt` + worker-reported `registrationOccurredAt`), one deduplicated `ownership_registered` lifecycle event, one audit row. |
| `renew` | `runRef?`, `externalWait?` (`{reason, retryAfter}` or `null` to clear) | Extends the single ownership TTL (`expiredAt = now + DISPATCH_OWNERSHIP_RENEW_TTL_MS`), increments `renewCount`, records observed + occurred renewal times, heartbeats the **current claim's** active `AgentWork` row and refreshes that row's `leaseExpiresAt` to the renewed ownership expiry — so the stale-work sweep (which reclaims on `leaseExpiresAt` as well as on the heartbeat) cannot reclaim a renewed long-running worker. Progress is **not** required. An `externalWait` records a **park** on the lease (`retryAfter`/`waitReason`): while that deadline is in the future the claim is held — the stale-work sweep skips the row and the claim path's expired-lease cleanup leaves the lease alone — so a worker that is waiting on something external is not reclaimed before it returns. |
| `disposition` | `disposition` ∈ `completed`/`released`/`blocked`/`handed_off`, `note?`, `successorRef?`, `retryAfter?`/`waitReason?` | Durable terminal record on the lease (`disposition*` columns), settles the **current claim's** active `AgentWork` row (DONE/RELEASED/BLOCKED) — never an arbitrary active sibling (see *Current claim's work* below), records an `ownership_dispositioned` lifecycle event and audit row. A `blocked` disposition **with `retryAfter`** also moves the settled row's `leaseExpiresAt` to the park deadline — the same `retryAfter` written on the lease — so the stale-work sweep cannot reclaim the parked claim before the park expires (#1316). A `blocked` disposition **without `retryAfter`** has no deadline to park until: the deliberate choice is NO park — the settled row's `leaseExpiresAt` is **cleared**, so the park-gated sweep reclaims it through its `leaseExpiresAt IS NULL` arm immediately and the row can neither ride its inherited execution expiry as a park-shaped hold nor shield the claim (whose `live` arm is UNKNOWN on a NULL deadline); any wait marker an earlier renew's `externalWait` left on the lease is cleared with it, since the disposition is the latest statement of the owner's intent. Terminal dispositions (`completed`/`released`/`handed_off`) settle to non-active states and are unaffected. |

**Stale-work sweep and blocked parks (#1316).** The sweep gates the two
active families differently. `CLAIMED`/`IN_PROGRESS` rows are
**heartbeat-gated** (reclaimable when `lastHeartbeatAt` OR `leaseExpiresAt`
fell past the cutoff — silence of an executing worker is the failure the
sweep catches). `BLOCKED` rows are **park-gated**: a blocked worker is
silent by design, so a `BLOCKED` row is reclaimable only when
`leaseExpiresAt < cutoff` (the park deadline elapsed) or
`leaseExpiresAt IS NULL` (no deadline, no park — normal stale path). The
live-sibling lookup is the exact per-state complement, so a parked row
protects the lease its park was recorded on. After the deadline passes, the
parked row follows the normal reclaim path: marked `STALE`, its lease is
deleted through the epoch-fenced delete, and the claim is released for
re-dispatch.

**A park owns its lease's survival (#1334).** The claim path's
`releaseExpiredLeases` (the expired-lease cleanup every claim attempt runs)
no longer deletes leases past their `expiredAt`: since #1417 it **tombstones**
them (a system-stamped `disposition: "expired"`) so the dead claim's evidence
survives for the ownership reconciler instead of stranding the issue behind
the queue's agent-label filter. A park recorded in this PR's sense —
`retryAfter` — outlives that TTL, so without a guard the cleanup could stamp
over the park evidence (`retryAfter`/`waitReason`, the `EXTERNAL_WAIT`
read-model signal) while the park is still running, leaving the settled
`BLOCKED` row next to a consumed receipt. The decided option is (b): the
cleanup **skips** a lease whose `retryAfter` is still in the future and
otherwise tombstones it as soon as the elapsed `expiredAt` *or* the elapsed
`retryAfter` qualifies it — whichever comes first — and never re-stamps a row
that already carries any disposition. This deliberately does **not** touch the
claim-epoch fence fields (`expiredAt` is moved only by (re-)claims and
renewals, #1317): the skip is evaluated per cleanup call, never parked forward,
and the stale-work sweep remains the fenced reclaimer when the park deadline
itself elapses. The protection is uniform in the wait marker: both writers —
a `blocked` ownership disposition and a renewal's `externalWait` — get it.
The same posture governs the claim path's stale-`AgentWork` cleanup
(`findAndReleaseStaleAgentWorkForIssue`): a lease whose `retryAfter` is still
in the future counts as active for that cleanup too, so a renewal park —
whose heartbeated row stays `CLAIMED`/`IN_PROGRESS` — keeps its row through a
claim attempt even after the ownership TTL lapses; once the deadline passes
the marker is spent and the row follows the normal cleanup, as after the sweep.

**A running park also holds the stale-work sweep off.** The row-level park
deadline covers a `blocked` disposition (it parks the settled row), but a
renewal's `externalWait` parks the **lease** only — the row keeps its ordinary
execution expiry — so the sweep reads the wait marker off the lease:

- Parked claims are **excluded from the sweep's candidate query**: they are
  not reclaim work at all. The exclusion matters because the query orders by
  the oldest heartbeat first and a parked row's heartbeat is old by
  definition — without it, parked claims would fill the candidate batch on
  every sweep and starve the genuinely stale rows behind them.
- Inside the decision transaction a candidate whose claim carries a **running**
  marker (`retryAfter` in the future) is **skipped**: no `STALE` mark, no lease
  delete, no claim release. The silence of a parked worker is not evidence of
  abandonment, and the park deadline — not the heartbeat — decides when the
  work becomes reclaimable. Once the deadline passes the marker is spent and
  the row follows the normal reclaim path (marked `STALE`, lease deleted,
  claim released).
- The sweep's epoch-fenced lease delete excludes a running park
  (`retryAfter IS NULL OR retryAfter <= now`), so a park that starts inside
  the sweep's decision window cannot have its lease consumed either. Such a
  row is restored to the shape the sweep found it in: a retired row would
  never be reclaimed again, and the claim would leak.

**Stale-work sweep and claim incarnations.** The sweep releases the claim of a
stale `AgentWork` row only when no live sibling row for the same (agent, issue)
still owns it: an older `BLOCKED` row that falls past the sweep cutoff never
releases the lease or the `agent/*` label that a freshly renewed `IN_PROGRESS`
row still holds. The stale row itself is still reclaimed (marked `STALE`), but
the claim is retained — reported as `claimRetained` (audited as
`stale_agentwork_claim_retained`, labels unchanged) instead of `released`, and
no `claim_released` event is written for it.

The sibling lookup is a check, not a fence, so the sweep closes its
decide-and-release window on two levels (#1251 review):

1. **Per-issue mutation fence.** The whole pipeline for an issue-scoped claim —
   sibling lookup, stale mark, lease delete, external GitHub label release,
   finalization — runs under the same `IssueMutationGuard` fence
   (`operation: "stale-release"`) that claim, lease, ownership renewal and
   capacity release take. A concurrent renewal or fresh claim cannot commit
   inside the window; it gets a retryable `409 mutation_busy` and re-decides
   against post-sweep state. A busy fence skips the candidate for this sweep
    (nothing is owed outside a completed fenced window). A guard demoted to
    non-executing by a failed release is resumed by the next sweep of the same
    (issue, agent) — safe because every step is a conditional update keyed off
    persisted row state and the release is deduped per claim epoch. A guard
    left `executing` by a crashed sweep process is never taken over
    automatically: it stays fail-closed (same posture as a crashed claim
    guard) and requires operator intervention.
 2. **Claim-epoch CAS.** The lease delete is compare-and-delete against a
    snapshot of `{claimToken, expiredAt, lastRenewalObservedAt}` taken before
    the sibling lookup, rechecked after the window for any lease left on the
    pair (with no snapshot row, no delete is attempted at all — only the
    recheck can then see a fresh claim). Any renew, re-claim or fresh claim
    that commits between the snapshot and the delete changes at least one
    fence field (or adds a row), the sweep backs off, and the claim/lease/
    label survive untouched — belt-and-braces for any writer that skips the
    fence. A terminal `disposition` changes none of the fence fields, so a
    cleanly-disposed claim never makes the sweep back off forever.

**Current claim's work.** Several active `AgentWork` rows can coexist for one
(agent, issue) — `startAgentWork` releases the `CLAIMED`/`IN_PROGRESS` ones, so
an older `BLOCKED` row survives. The row that *is* the current claim's work is
selected by one deterministic rule shared by renewal heartbeat, terminal
disposition and the operator inspect view: freshest `lastHeartbeatAt`, then
`createdAt` desc, then `id` desc. A terminal disposition therefore can never
settle an older sibling while the current attempt stays active, and the row a
renewal protects is the same row a disposition settles.

Semantics that never change:

- **Attempt fencing.** Every call presents the `claimToken` issued by
  `POST /api/issues/claim` (also surfaced by `active-work` resume context).
  A token that does not match the live lease row is rejected
  (`409`, `code: "stale_claim_token"`), so a superseded incarnation can never
  renew or dispose a newer claim. A lease re-created by a re-claim carries a
  fresh token, and reactivating a **disposed** lease row (the claim path reuses
  the row instead of creating one) rotates `claimToken` atomically with the
  terminal-field clear and resets the retired attempt's registration/renewal
  provenance — so the retired receipt is fenced out of the new attempt. An
  ordinary renewal of a live, undisposed row keeps its token and evidence: a
  heartbeating worker never loses its receipt. Pre-#1256 token-less leases are
  rejected until re-claimed.
- **Late renewals are accepted; dead claims are not.** A renewal whose lease
  has lapsed but whose row still exists is accepted (transient outage /
  restart). A renewal for a lease whose row was released/pruned gets
  `409 no_active_claim`; after a terminal disposition, `409 disposed`.
- **Occurrence vs observation.** `occurredAt` (extended ISO 8601) records when
  the worker says the event happened; Dispatch always records the server clock
  alongside. Invalid, future, or >24h-old occurrences silently fall back to the
  server time (same posture as `tasks/report`'s `startedAt`).
- **Replay.** `register` and a same-kind `disposition` are idempotent per
  (issue, agent, token); a *different* disposition after a terminal one is
  `409 disposition_conflict`. A replayed `register` returns the persisted
  registration with `replayed: true` and writes nothing — no timestamp refresh,
  no run-reference overwrite, no second audit row.
- **Atomicity.** The operations that write lease state commit their local
  effects together in one transaction: `register` (registration + lifecycle
  event + audit row), `renew` (lease CAS + the matching `AgentWork` liveness
  write + history) and `disposition` (terminal CAS + AgentWork settlement +
  history + lifecycle event + audit row). A write that fails mid-way rolls
  the whole fact back and never reports success — but for different reasons.
  For `register`/`disposition` the reason is the replay: the issue mutation
  guard has no resume branch and is deleted on throw, so the retry must
  re-enter the full path instead of hitting a replay that reports success
  for evidence which never landed. For `renew` there is no replay branch to
  corrupt (a retry simply re-extends the TTL); the reason is the sweeper —
  since #1300 the liveness write is load-bearing, so what must never happen
  is a committed lease CAS whose AgentWork write was lost, leaving a renewed
  lease whose row still carries the old lapsed expiry (#1315).
- **No releases.** Nothing here writes GitHub labels, deletes a lease, or
  moves issue status. A missing heartbeat or an unrenewed claim never revokes
  anything. A disposed-but-unexpired lease likewise stays in place (still
  surfaced as resumable by `active-work`, still excluding the issue from other
  agents' queues) until it expires naturally or the same agent re-claims —
  and reactivating it in the claim path rotates the claim token and clears the
  retired attempt's terminal marker and provenance, so the fresh attempt never
  inherits the retired one's evidence or leaves its owner unfenced.

### Identity boundaries

- A **bound** worker credential (`DISPATCH_WORKER_TOKENS`) may operate only
  for its own agent — exact token-derived match, no `agent/courier*`-style
  wildcard aliasing, no silent reassignment.
- The **legacy unbound** `DISPATCH_WORKER_TOKEN` has no derived identity and
  is refused (403): the capability keys on bound identity (design §3.8/§6).
- Maintainer/operator credentials (bearer maintainer, basic, OIDC, or auth
  disabled) may record for a named agent; the operator is the audit actor.
- Workers that never adopt the capability keep working unchanged and stay
  conservatively unverified (design §6.2).

## Windows (configuration, design §8.3)

| Variable | Default | Meaning |
|---|---|---|
| `DISPATCH_OWNERSHIP_ACTIVE_WINDOW_MS` | 900000 (15m, clamped 1m–6h) | Renewals inside this window keep the claim `CLAIMED_ACTIVE`. |
| `DISPATCH_OWNERSHIP_LONG_RUN_GRACE_MS` | 2700000 (45m, clamped ≥ active window, ≤24h) | Sustained silence inside this grace is `CLAIMED_LONG_RUNNING` — escalated observation, never release. |
| `DISPATCH_OWNERSHIP_RENEW_TTL_MS` | 1800000 (30m = standard lease TTL, clamped 1m–24h) | Expiry a renewed lease receives. |

## Derived ownership read model

Ownership is **derived, never stored** (design §4).
`src/lib/ownership-state.ts` is the pure derivation over evidence
(labels + lease + AgentWork + blocked reason + linked PR + open PR-fix row),
with machine-readable reason codes. States: `UNOWNED`, `CLAIMED_ACTIVE`,
`CLAIMED_LONG_RUNNING`, `REVIEW_OWNED`, `EXTERNAL_WAIT`, `HELD`,
`ABANDONED_CANDIDATE`, `CONFLICTED`, `UNKNOWN`. Absent or conflicting
evidence yields `UNKNOWN`/`CONFLICTED` — never abandonment. The lease owner
and the active `AgentWork` owner are each compared against the sole `agent/*`
label owner **independently**: a lease that agrees with the label does not
excuse an active `AgentWork` row owned by somebody else (`agent_work_owner_mismatch`).

Operator read surfaces (maintainer-only; worker tokens are refused 403 by the
central tiering):

- `GET /api/issues/{issueId}/ownership` — derived state + redacted evidence
  (the raw claim token is never surfaced, only `claimTokenPresent`) + the
  active windows. Live label read by default; `?live=false` uses the cache; a
  failed live read yields `labelSource: "unavailable"` (verified: false),
  never a 5xx.
- `GET /api/issues/ownership` — cached-list inspection over every issue with a
  claim signal (agent label / active lease / active AgentWork).
  `?state=<OWNERSHIP_STATES>` filter, `limit` (default 50, max 200).
  Bounded scan: each of the three candidate sources is read
  most-recently-touched-first, capped at 1000 rows, and at most 500
  candidates are derived with chunked concurrency. "Most recent" is the row's
  last ACTIVITY: an issue or AgentWork row's last update, and a lease's last
  renewal — falling back to its claim time when it was never renewed. The
  lease source is read as two runs (renewed leases by `renewedAt`,
  never-renewed leases by `createdAt`) and merged on that activity timestamp,
  with `id` ascending as the tie-break; so a long-lived claim that its owner
  is still renewing outranks a newer claim that was never renewed, and the
  bounded scan cannot drop a live owner while keeping a stale one. The response reports
  `{ items, counts, examined, truncated, sourcesTruncated, limit, windows }`:
  `truncated` means candidates were dropped before derivation (so
  `counts`/`examined` describe only the inspected set), while
  `sourcesTruncated: { labeled, leased, working }` says **which** source had
  rows beyond its cap, so an operator can tell an overflowed signal from a
  genuinely small population.

Both are pure reads: no writes, no audits, no releases.

## Consistency boundary

Renew/register/disposition mutate the `Lease` under the per-issue
`IssueMutationGuard` anchor (#1259), so they serialize with claim and fenced
capacity-release mutations on the same issue — and with the stale-work sweep,
whose whole decide-and-release pipeline runs under the same fence as
`operation: "stale-release"`. A concurrent operator release or
re-claim therefore cannot interleave with a renewal; contention returns a
retryable `409 mutation_busy`. GitHub is never consulted by these operations
— their fencing is entirely against the claim receipt and the lease row — so
they succeed even while the forge is unreachable, and still change nothing
outside Postgres.
