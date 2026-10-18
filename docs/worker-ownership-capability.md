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
| `renew` | `runRef?`, `externalWait?` (`{reason, retryAfter}` or `null` to clear) | Extends the single ownership TTL (`expiredAt = now + DISPATCH_OWNERSHIP_RENEW_TTL_MS`), increments `renewCount`, records observed + occurred renewal times, heartbeats a matching active `AgentWork` row. Progress is **not** required. |
| `disposition` | `disposition` ∈ `completed`/`released`/`blocked`/`handed_off`, `note?`, `successorRef?`, `retryAfter?`/`waitReason?` | Durable terminal record on the lease (`disposition*` columns), settles a matching active `AgentWork` (DONE/RELEASED/BLOCKED), records an `ownership_dispositioned` lifecycle event and audit row. |

Semantics that never change:

- **Attempt fencing.** Every call presents the `claimToken` issued by
  `POST /api/issues/claim` (also surfaced by `active-work` resume context).
  A token that does not match the live lease row is rejected
  (`409`, `code: "stale_claim_token"`), so a superseded incarnation can never
  renew or dispose a newer claim. A lease re-created by a re-claim carries a
  fresh token; pre-#1256 token-less leases are rejected until re-claimed.
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
  `409 disposition_conflict`.
- **No releases.** Nothing here writes GitHub labels, deletes a lease, or
  moves issue status. A missing heartbeat or an unrenewed claim never revokes
  anything.

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
evidence yields `UNKNOWN`/`CONFLICTED` — never abandonment.

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

Both are pure reads: no writes, no audits, no releases.

## Consistency boundary

Renew/register/disposition mutate the `Lease` under the per-issue
`IssueMutationGuard` anchor (#1259), so they serialize with claim and fenced
capacity-release mutations on the same issue. A concurrent operator release or
re-claim therefore cannot interleave with a renewal; contention returns a
retryable `409 mutation_busy`. GitHub is never consulted by these operations
— their fencing is entirely against the claim receipt and the lease row — so
they succeed even while the forge is unreachable, and still change nothing
outside Postgres.
