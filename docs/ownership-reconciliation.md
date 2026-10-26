# Ownership Reconciliation Design

> **Status:** Landed. #1251 landed the §6 optional worker capability
> (register/renew/disposition on `Lease`), the §4 derived ownership read model,
> and the §9 inspect surfaces — see
> [Worker Ownership Capability](./worker-ownership-capability.md). #1254 landed
> the §8 bounded reconciliation pass and the §8.7 two-sided release boundary:
> `src/lib/ownership-reconciliation.ts` implements the confirmation ladder
> (§8.2), the Phase A/B/C intent protocol (§8.7), the crash/replay matrix, and
> the §8.5 release selection, mode-gated by
> `DISPATCH_OWNERSHIP_RECONCILE_MODE` (`off` by default — no automatic release;
> `audit` annotates only; `enforce` releases confirmed-abandoned claims). The
> pass runs in the stale-work scheduler slot (`/api/agent-work/sweep`) under
> the existing sync lock. Pending release intents and ladder candidates are
> surfaced on the §9 read surface (`GET /api/issues/ownership` →
> `reconciliation`). Still design-only: no worker-credential migration and no
> deployment change.
>
> **Issue:** [misospace/dispatch#1245](https://github.com/misospace/dispatch/issues/1245)
> **Date:** 2026-10-13

## 1. Problem

Persisted assignment labels and local claims can exclude otherwise eligible
work after the original worker disappears or its identity changes. The observed
case (2026-10-13): `windowstead#398`, `pinchflat#109`, and Courier `#243` carried
legacy `agent/courier` assignments while the configured frontier consumer was
`courier-frontier`. The default queue filter treats any `agent/*` label as a
claim and excludes it for other identities
(`src/lib/agent-queue.ts:296-309`), so the work was stranded until an operator
released the three claims by hand.

The hard part is that **a claim is not proof of active execution, and the
absence of a Courier `CoderRun` is not proof of abandonment either**. A worker
that is mid-model-call, a review-owned PR, an external dependency wait, a
deliberate human assignment, and a dead process can all present the same
surface: a label and no recent telemetry. Any automatic recovery must therefore
be evidence-driven, bounded, fenced, and conservative.

This document inventories the mechanisms that already exist, defines an
ownership state model and evidence hierarchy, and specifies a bounded
reconciliation transition table, an optional worker capability, a
compatibility/migration policy, an operator escape hatch, and the race/failure
cases that constrain all of it. It deliberately **improves the existing lease /
AgentWork / PR-fix-ack machinery** rather than inventing a parallel lease
system.

## 2. Non-goals

- Releasing claims, blanket label cleanup, or requeue as part of this issue.
- Worker credential migration or deployment/scheduler changes.
- Replacing GitHub Issues/PRs as the source of truth. Dispatch's Postgres is a
  cache (see [AGENTS.md](../AGENTS.md#source-of-truth)).
- Aliasing every `agent/courier*` identity, stealing another consumer's
  assignment, or assuming one app owns a whole label family.
- Treating Courier's local run retention
  ([courier#287](https://github.com/misospace/courier/issues/287)) or model
  exhaustion/quota reset ([courier#320](https://github.com/misospace/courier/issues/320))
  as Dispatch's recovery algorithm.
- Auto-resolving genuine human decisions (explicit holds, deliberate blocks).

## 3. Current mechanisms (inventory)

Dispatch already carries three overlapping ownership structures plus one
per-hand-out acknowledgement. The design builds on these.

### 3.1 Ownership signals

| Signal | Where | Meaning today | Failure mode |
|---|---|---|---|
| `agent/<name>` label | GitHub, cached on `Issue.labels` | The only queue-level claim filter; "one agent label at a time" (`docs/assignment-conflict-policy.md`) | Shared, mutable, no expiry; label present ≠ process alive; label absent ≠ not working |
| `owner/<name>` label | GitHub, cached | Human/board ownership, independent of agent (`src/lib/assignment-conflicts.ts`) | Never blocks a claim; not a liveness signal |
| `status/*` label | GitHub, cached | Lifecycle column (`ready`/`in-progress`/`in-review`/`blocked`/`done`); `blocked` parks the issue (`src/lib/agent-queue.ts:186-198`) | `blocked` without `blockedReason` is ambiguous |
| `Issue.blockedReason` | Postgres (`prisma/schema.prisma:67`) | Distinguishes a deliberate block from an unexplained one; consumed by the release policy (`src/lib/issue-claim.ts:216-229`) | Only set by grooming/ops paths |
| `Issue.linkedPr*` snapshot | Postgres (`prisma/schema.prisma:108-114`) | Linked PR identity + health, split across `linkedPrNumber/Url/NeedsFollowup/FollowupReasons/ReviewDecision/MergeState/HealthCheckedAt` | Refreshed on reconcile cadence; can lag |
| `PrFixQueueItem` | Postgres | Owns PR-fix/PR-followup work per `(repo, pr)`, incl. hand-out + ack state | Separate ownership domain; not issue assignment |

### 3.2 `Lease` (durable ownership checkpoint)

`prisma/schema.prisma:889-910`; helpers in `src/lib/lease.ts`.

- Unique `(agentName, issueId)`; absolute `expiredAt`; `renewedAt`; `checkpoint`,
  `branch`, `prUrl`.
- Default TTL **30 min** (`DEFAULT_LEASE_TTL_MS`, `src/lib/lease.ts:20`).
- Created/renewed **only** on claim (`src/app/api/issues/claim/route.ts:268-273`) and
  by the hosted groomer (`src/lib/groomer/run.ts:275-280`, 10-min TTL). The 5-minute
  `AgentWork` checkpoint loop does **not** renew it.
- Active (non-expired) leases from other agents exclude the issue from the queue
  (`findLeasedIssueIds`, `src/lib/lease.ts:255-265`; filtered at
  `src/lib/agent-queue-fetch.ts:144,152`).
- `resolveActiveWork` releases orphaned/corrupt leases lazily on read
  (`src/lib/lease.ts:181-250`).

**Gap:** the 30-minute lease and the 5-minute AgentWork heartbeat are separate
clocks. A legitimately long-running worker that checkpoints every few minutes
still lets its `Lease` lapse, while the queue keeps excluding the issue because
the `agent/*` label is what actually filters the queue. The lease and the label
disagree.

### 3.3 `AgentWork` (execution state machine)

`prisma/schema.prisma:842-864`; helpers in `src/lib/agent-work.ts`.

- States `CLAIMED | IN_PROGRESS | BLOCKED | DONE | RELEASED | STALE`
  (`schema.prisma:822-829`) plus a finer `checkpoint` enum
  (`schema.prisma:831-840`).
- `leaseExpiresAt` set to **now + 5 min** on start and every checkpoint
  (`src/lib/agent-work.ts:168-169,221-226`); `lastHeartbeatAt` updated on
  checkpoint; `blockerReason` set on `BLOCKED`.
- An ownership-capability `renew` also refreshes the matching active row's
  `lastHeartbeatAt` and `leaseExpiresAt`, the latter to the renewed ownership
  expiry (default 30m, `src/lib/worker-ownership.ts`) — the sweeper reclaims
  on `leaseExpiresAt` as well as on the heartbeat, so a renewal that moved
  only the heartbeat would still be reclaimable.
- One active `AgentWork` per agent (a new `start` releases the prior one,
  `src/lib/agent-work.ts:173-184`).
- `AgentWorkHistory` records each transition.

**Gap:** `AgentWork` is per-agent, not per-issue-claim, and a worker that never
calls `checkpoint` (crash, gateway restart, pre-run failure) leaves a `CLAIMED`
row with a stale `lastHeartbeatAt`. Its presence is weak liveness evidence.

### 3.4 Claim / unclaim

- `POST /api/issues/claim` (`src/app/api/issues/claim/route.ts`) makes the
  decision against **live GitHub labels** (#1037, `src/lib/claim-gate.ts`),
  refuses closed/done issues, refuses a live lease held by another agent unless
  `force=true` (maintainer-only), upserts the lease, and moves the issue to
  `status/in-progress`.
- `POST /api/issues/unclaim` (`src/app/api/issues/unclaim/route.ts`) removes the
  label via the shared `releaseIssueClaim` core, releases the lease, and (for
  operators) releases `AgentWork`. `releaseIssueClaim`
  (`src/lib/issue-claim.ts:78`) **already refuses to remove a newer agent's
  label** (`currentAgent !== agentLabel` → skip) and keeps an in-review issue
  in-review while its linked PR is open.

### 3.5 Stale-work sweep

`src/lib/stale-work.ts` + `src/app/api/agent-work/sweep/route.ts`, scheduled
every 5 min when the in-process scheduler is enabled
(`src/lib/scheduler.ts:129-133`).

- Candidates: `AgentWork` in `CLAIMED/IN_PROGRESS/BLOCKED`. The
  `CLAIMED`/`IN_PROGRESS` arm is silence-without-a-live-lease (#1418): a row
  is a candidate only when its `lastHeartbeatAt` is older than **5 min**
  (`DEFAULT_STALE_WORK_MAX_AGE_MS`, `src/lib/stale-work.ts:6`) AND its
  execution lease is not live (`leaseExpiresAt` NULL or past `now`).
  Heartbeat silence alone no longer reclaims while the lease stands: an
  ownership renewal (#1251) propagates the renewed TTL (30 min default) onto
  the active row in the same transaction as the heartbeat, so a worker
  renewing on a cadence longer than the heartbeat window — one long model call
  or test run — is no longer reclaimed, its lease deleted, and its
  `agent/*` label stripped mid-flight. The shield is bounded by the renewed
  TTL, which is exactly the window the lease still blocks duplicate pickup
  for; once renewals stop, the lease lapses and the normal reclaim path
  applies, so a dead worker is never stranded. This matches the §4 derived
  state model, where a live lease is liveness
  (`lease_still_live` → `CLAIMED_LONG_RUNNING`, never release). The `BLOCKED`
  arm is unchanged: reclaimable once the park deadline elapsed or when it
  never had one. Plus `STALE` rows still owing a release
  (`staleClaimReleasePending`).
- Two-phase, crash-safe: mark `STALE` (+ `staleClaimReleasePending` when a
  release is owed), then release the GitHub claim via `releaseIssueClaim` with
  `allowMissingAgent` + `preserveStatus`, then clear the pending flag. For
  issue-scoped claims the whole decide-and-release pipeline runs inside the
  per-issue `IssueMutationGuard` fence (#1259) that claim, lease, ownership
  renewal and capacity release also take, so no claim-path writer can commit
  between the sweep's lookups and its lease delete.
- The lease release is fenced against the claim epoch (#1317). Because
  `upsertLease` renews the singleton `(agentName, issueId)` row on every claim
  while `startAgentWork` only releases `CLAIMED`/`IN_PROGRESS` siblings, a
  swept stale row (typically a surviving `BLOCKED` row) could previously
  delete the lease of a NEWER live claim epoch of the same agent on the same
  issue. Two guards close it:
  1. **Live-sibling deferral** — if another `CLAIMED`/`IN_PROGRESS`/`BLOCKED`
      row for the same pair is still live (fresh heartbeat OR a live
      execution lease — the exact complement of the reclaim arms, #1418),
      the sweep defers entirely: no lease delete, no label
      removal, no release. The row is still reclaimed and reported
      `claimRetained`.
  2. **Claim-epoch CAS** — the lease delete compares against a snapshot of
     `{claimToken, expiredAt, lastRenewalObservedAt}` taken before the sibling
     lookup, and a post-delete existence recheck catches a fresh claim that
     raced in. Any renew / re-claim / fresh claim committing inside the
     decision window makes the delete match nothing and the sweep back off
     (`retention: "claim_epoch_moved"`).
- The report distinguishes the outcomes: `released`, `claimRetained`,
  `skipped`, and `leasesReleased` — the number of lease rows the CAS-fenced
  delete actually consumed, so operators can see when a reclaim ran without a
  lease and when a retention deleted nothing (#1317 accounting).
- `findAndReleaseStaleAgentWorkForIssue` (`src/lib/agent-work.ts:437`) deletes
  `AgentWork` rows with no matching active lease during a claim, skipping any row
  still owed a claim release (`staleClaimReleasePending`) and fencing each delete
  on the scanned row's state, owner and issue (#1350).

**Gap:** the sweep's liveness inputs are heartbeat and lease-expiry only.
Since #1418 a renewed lease counts as liveness for the reclaim decision, so a
renewing worker is shielded for as long as its renewals keep the lease live;
a worker that adopted the ownership capability and renews is therefore
covered. A worker that does NOT renew (legacy or capability-abandoned) and
whose model call or test run exceeds the heartbeat window is still reclaimed
on a later tick — its execution lease crosses at the same silence moment, so
its reclaim timing is unchanged. The fencing is
deliberately conservative in the other direction too: when the epoch cannot be
proved stable, the sweep retains the claim — so a lease whose epoch is actually
dead (e.g. a worker that starts work before claiming) can keep the issue
lease-blocked for other agents until the lease TTL (30 min default) reaps it.
Heartbeat routing also still matters upstream: `checkpointAgentWork`'s row
selection previously could route a heartbeat to a stale sibling row, which
counted as liveness for the pair and made the sweep defer (#1328 tightened the
selection to the current claim's row).

### 3.6 Operator controls (escape hatch today)

- `POST /api/agent-work` with `action: "release"` — by `workId`, `leaseId`, or
  `agentName` (+ `issueId` or `releaseAll`) (`src/app/api/agent-work/route.ts:173`).
- `POST /api/agent-work` with `action: "reassign"` — move a `workId` to a new
  agent (`src/app/api/agent-work/route.ts:364`).
- `POST /api/issues/unclaim` by an operator (releases label + lease + AgentWork).
- All are maintainer-only and audit-logged.

### 3.7 PR-fix hand-out acknowledgement (closest existing pattern)

`src/lib/pr-fix-queue.ts`, #1211. This is the pattern the issue model should
mirror:

- Hand-out stamps `dispatchedGeneration` + `agentHandouts` (`<agent>@<gen>`).
- A worker that durably materialised its run calls `POST /api/pr-fix-queue/ack`;
  the ack is generation-pinned, idempotent, and recorded in `handoutAcks`.
- An unacknowledged hand-out older than `PR_FIX_HANDOUT_TIMEOUT_MS` (30 min) is
  reclaimed, bounded by `PR_FIX_MAX_RECLAIMS` (3) → `PARKED` + `no_progress`.
- Reclaim is **default-disabled** in the scheduler
  (`DEFAULT_PR_FIX_SWEEP_INTERVAL_MS = 0`, `src/lib/scheduler.ts:62`) precisely
  because a worker that cannot ack would be swept.

### 3.8 Worker identity

`src/lib/worker-identity.ts`, `DISPATCH_WORKER_TOKENS` (#1129): a bound token
derives the agent identity from the token, never from a header/body. This is the
trust anchor any ownership record must key on.

### 3.9 Gap summary

1. **Evidence conflation.** A label (persisted assignment), a lease (TTL
   ownership), and `AgentWork` (execution heartbeat) are treated as one
   "ownership" signal. None individually proves liveness or abandonment.
2. **Two clocks disagree.** 30-min lease vs 5-min AgentWork; neither renews the
   other; the queue filters on the label, not either.
3. **No confirmation before release.** The sweep releases on a single stale
   timestamp with no second look and no fencing.
4. **No "unknown"/conflict state.** Cache/GitHub divergence or multiple agent
   labels have no first-class representation; the queue silently excludes.
5. **Legacy identity is undefined.** `agent/courier` vs `courier-frontier` has
   no migration policy; the safe default today is "stranded until an operator
   looks."
6. **Release target is hard-coded-ish.** `releaseIssueClaim` has a good
   status-preserving policy but no notion of selecting the *next eligible
   state* from an explicit hold/external-wait/review taxonomy.

### 3.10 Expired-claim evidence retention (#1417)

Gap 1's sharpest form (audit F1): a canonical worker claims — a `Lease` row
plus the `agent/<name>` label, and **no `AgentWork` row until agent-work/start**
— and crashes. The lease expires, and expired-lease cleanup used to **delete**
the row, destroying the only Dispatch-side evidence. The stale-work sweep sees
only AgentWork rows and the candidate scan has no lease row left to select, so
the stranded claim became permanently invisible: derivation falls to UNKNOWN
(`owner_unverified_no_dispatch_evidence`), the queue keeps filtering on the
label, and nothing can ever recover it.

Expired-lease cleanup (`releaseExpiredLeases`) therefore **tombstones** instead
of deleting: the row survives with a system-stamped
`disposition: "expired"` (never worker-supplied — `OWNERSHIP_DISPOSITIONS` is
unchanged). The stamp is CAS-fenced on `expiredAt <= now`, `disposition: null`
and a spent `retryAfter`, so a renewal that wins the window is never stamped
and a running park (#1316/#1334) is never consumed. `claimToken`, `expiredAt`
and renewal provenance are untouched, so the §8.7 Phase A epoch CAS still
matches the tombstone, and a legitimate re-claim reactivates the row through
`upsertLease`'s disposed-row path (token rotated, #1256).

The tombstone is deliberately **not** a terminal disposition: derivation adds
the non-terminal `disposition_expired` reason code and the claim continues down
the ordinary liveness ladder, so release still requires the §8.2 confirmation
ladder (liveness evidence older than the long-run grace, two spaced
observations, commit-time re-checks) plus §8.7 fencing. The lease TTL alone
never releases anything — a healthy long-running execution that renews (or a
claim-once worker inside the grace window) cannot be stolen at 30 minutes;
the tombstone only makes the evidence *survive* for the reconciler to judge.

Retention needs a candidate-safe exit or it starves the scan it feeds: a
single oldest-`take` lease batch is taken *before* the open/label filters, so
tombstones whose issue closed or whose `agent/*` label moved on would
permanently occupy the bounded window — in `audit` too, where nothing prunes
(#1417 review round 3). `selectCandidates` therefore PAGES the lease source and
counts only rows that can still matter toward the window: rows on open
agent-labeled issues, rows whose issue holds an `OwnershipReleaseIntent` (the
§8.7 Phase C settle re-check reads exactly that row), still-live receipts
(`expiredAt` elapsed is required, so a terminal disposition on a non-expired
lease stays the worker's resume proof), and still-running parks (`retryAfter`
elapsed — the stale-work sweep keeps that fenced delete). Dead tombstones are
paged past in every mode, so `audit` reaches valid candidates with zero
mutations; under `enforce` they are additionally deleted with the same CAS
fence as the stamp, converging the table. Paging reads at most a fixed budget
per pass (`LEASE_SCAN_MAX_ROWS`), bounding read cost; a settled release deletes
the lease row directly, so under `enforce` tombstones stay bounded. Under the
default `off` mode the reconciler scans nothing at all — tombstones keep
accumulating from the claim path as inert storage growth, with no bounded
window to starve until an operator enables a mode.

## 4. Ownership state model

Ownership is **derived**, never stored as a single truth. Two layers:

- **Authoritative facts** (source of truth): GitHub issue/PR state, labels,
  linked-PR merge/review state, and the worker's bound identity.
- **Dispatch observations** (evidence): `Lease`, `AgentWork` +
  `AgentWorkHistory`, PR-fix hand-out/ack rows, `AuditLog`, reconcile snapshots.

Derived ownership state per `(repo, issue)`:

| State | Definition | Queue effect |
|---|---|---|
| `UNOWNED` | No `agent/*` label, no active lease, no active `AgentWork`. | Eligible (subject to status). |
| `CLAIMED_ACTIVE` | Live claim + recent renewal/checkpoint evidence within the active window. | Excluded for other identities. |
| `CLAIMED_LONG_RUNNING` | Live claim, renewal older than the active window but within the long-run grace, with at least one durable run/checkpoint anchor. | Excluded; eligible for *escalation*, not release. |
| `REVIEW_OWNED` | Claim present **or** `status/in-review` with an open linked PR (or an open PR-fix queue row for the issue). | Excluded; PR-fix queue is the owner. |
| `EXTERNAL_WAIT` | Claim present with a recorded external-wait / retry-after marker. | Excluded until the wait elapses. |
| `HELD` | Explicit operator hold, or `status/blocked` **with** `blockedReason`, or a `needs-human` verdict. | Excluded; **never** auto-released. |
| `ABANDONED_CANDIDATE` | Claim present but evidence says the owner is gone **and** no hold/review/external-wait applies. | Excluded until confirmed; then released. |
| `CONFLICTED` | More than one `agent/*` label, or cache disagrees with GitHub, or lease/`AgentWork` owner ≠ label owner. | Excluded; surfaced as unknown; operator-only. |
| `RELEASED` | Ownership removed by unclaim/reconcile; `AgentWork` terminal. | Eligible per the selected next status. |

`HELD` and `REVIEW_OWNED` are **terminal for reconciliation**: the reconciler
must never move them. `CONFLICTED` is never auto-resolved.

Storage note: the `EXTERNAL_WAIT` marker has **no issue-level home today**
(`WAITING_EXTERNAL` is a `PrFixQueueItem.status` only, a different domain). Until
the §6 capability records one, `EXTERNAL_WAIT` is unreachable for issue
ownership and the reconciler treats a claim with no wait marker by the ordinary
evidence ladder. `HELD` similarly needs an explicit marker (§9) before it can be
distinguished from an unexplained `status/blocked`.

## 5. Evidence hierarchy

Ordered strongest → weakest. Higher tiers override lower ones.

1. **Explicit human/operator action** — an unclaim, a hold, an assignment made
   on GitHub by a maintainer, a `needs-human`/`blocked` verdict with reason.
   Authoritative; the reconciler defers.
2. **GitHub live state** — current labels, issue open/closed, linked PR
   open/merged/review state (read through the configured forge adapter, §7).
3. **Durable worker capability evidence** (§6) — a client-registered owner
   record with an unexpired renewal and, when present, a terminal disposition.
   This is the *only* signal that can positively prove liveness.
4. **Dispatch local execution evidence** — `AgentWork` recent
   `lastHeartbeatAt`, a live `Lease` within TTL, an acknowledged PR-fix
   hand-out. Proves *some* activity but is per-agent, not per-issue.
5. **Reconcile/health snapshots** — `Issue.linkedPr*`, `lastSyncedAt`.
   Advisory and lagging.
6. **Absence of evidence** — no lease, no heartbeat, no run. **Never sufficient
   on its own** to declare abandonment; it can only raise an
   `ABANDONED_CANDIDATE` for confirmation.

Rule: **abandonment requires positive evidence the owner is gone (terminal
disposition, or an expired durable registration, or a confirmed-dead identity),
or the exhaustion of a bounded confirmation ladder — never merely missing
telemetry.**

## 6. Optional worker client capability

Workers are heterogeneous (Courier, OpenClaw, Codex, Claude Code, shell cron).
Ownership durability must be **optional and additive**, keyed to the bound
identity from §3.8.

### 6.1 Capability: durable ownership registration

An optional `ownership` capability with three operations, all generation/attempt
pinned and idempotent:

| Operation | Semantics |
|---|---|
| `register` | On claim/start, the worker records a durable owner identity: `(agent, issue, attemptToken, runRef)`. Establishes that a real process intends to own the work. |
| `renew` | Periodic heartbeat extending a **single** ownership TTL. Distinct from `checkpoint` because it must not require progress. |
| `disposition` | Terminal record: `completed | released | blocked | handed_off`, with an optional successor/PR link. Lets a worker say "I'm done" or "I died cleanly" even after a restart. |

Design notes:

- The record is keyed by the **token-derived identity**, so a rotated token for
  the same agent keeps ownership; a different agent cannot renew it.
- `attemptToken` (monotonic, Dispatch-issued at hand-out, mirroring
  `PrFixQueueItem.generation`) is the **fencing token**: a renew/disposition
  carrying a stale token is rejected, so a restarted owner cannot revive a claim
  a reconciler already released, and a reconciler cannot release a claim a
  newer attempt renewed.
- This capability can reuse the existing `Lease`/`AgentWork` storage rather than
  a new table (see §11): `renew` maps to extending `Lease.expiredAt` **and**
  writing an `AgentWorkHistory` heartbeat; `disposition` maps to
  `finishAgentWork` + lease release. The `attemptToken` itself is a **new column
  on `Lease`** (the row that already owns `(agentName, issueId)`); a token is
  issued on claim/hand-out and rotated on every fresh attempt, so the
  compare-and-set in §8.6/§8.7 has a column to pin against.

### 6.2 Clients without the capability

A client that never calls `register`/`renew`/`disposition` (legacy, or an
unknown harness) is supported but gets a **weaker** liveness ceiling:

- It is treated as `CLAIMED_ACTIVE` while any lower-tier evidence (a live lease,
  a recent `AgentWork` heartbeat, a fresh acknowledge) is present.
- Once all lower-tier evidence is stale, it becomes `ABANDONED_CANDIDATE` and
  must pass the **full confirmation ladder** (§8.2) before release. It is never
  released on a single stale timestamp.
- This preserves the legacy `DISPATCH_WORKER_TOKEN` migration-window path and
  arbitrary harnesses without forcing them to adopt a new contract.

## 7. Forge access

Every reconciler read and write goes through the **configured forge
capability** — `src/lib/github.ts` (labels, issues, PRs) and
`src/lib/github-prs.ts` — never a forge-specific CLI. This keeps the reconciler
forge-agnostic, honours the configured credentials/app auth, and preserves the
#1037 rule that decisions are made against **live** labels. The reconciler must
fail closed (no write, no local mutation) when the forge is unreachable, exactly
as the claim route does (`src/app/api/issues/claim/route.ts:118-148`).

## 8. Reconciliation

### 8.1 Bounded, scheduled, single-replica

- Runs as a scheduled job (the existing `stale-work` slot,
  `src/lib/scheduler.ts:129-133`), confined to one replica, guarded by the
  existing sync lock (`src/lib/sync-lock.ts`).
- Bounded batch per tick; per-item try/catch so one failure cannot stall the
  batch; structured report (`examined/released/claimRetained/skipped/leasesReleased/errors`)
  as the current sweep already emits.
- Idempotent and resumable: a crash between "mark" and "release" is retried via
  the existing `staleClaimReleasePending` marker.

### 8.2 Confirmation ladder (no single-signal release)

An `ABANDONED_CANDIDATE` must clear **all** of:

1. Active window elapsed (durable registration expired, or all lower-tier
   evidence older than the grace window).
2. **Two independent observations** separated by a re-check interval (the
   worker was already stale on the previous tick, i.e. sustained, not a blip).
3. No `REVIEW_OWNED` (open linked PR / open PR-fix row), no `EXTERNAL_WAIT`
   (retry-after in the future), and no `HELD`.
4. Bounded attempt count not exceeded (a per-claim reclaim counter,
   `DISPATCH_RECONCILE_MAX_RECLAIMS`, mirroring `PR_FIX_MAX_RECLAIMS`); on
   exhaustion, **park as `HELD`/needs-human**, do not release.
5. A fenced intent commit (§8.7 Phase A): the release CAS on the current
   owner/attempt token succeeds atomically with writing the pending
   delete-intent, which also opens the claim-admission barrier. The fence is
   the commit itself, not a check timed before the remote write.

### 8.3 Grace periods

| Window | Purpose | Suggested default |
|---|---|---|
| Active window | `renew` expected cadence; worker is healthy | 3× renew interval (e.g. 15 min) |
| Long-run grace | Tolerate a single long model call / test run before even candidacy | ≥ 30 min, configurable |
| Re-check interval | Separation between the two confirmation observations | one scheduler tick (5 min) |
| Reclaim cooldown | Minimum spacing between successive release attempts on the same claim, so a flapping owner cannot churn release/reclaim | ≥ one re-check interval |
| External-wait default | Minimum deferral for an `EXTERNAL_WAIT` marker | operator/lane configured |

All windows are configuration, not code constants, so deployments can widen them
without a release.

### 8.4 Transition table

Inputs are the derived state plus evidence. `→` is the resulting state; the
action column is what the reconciler does (or explicitly does not do).

| From | Condition | To | Action |
|---|---|---|---|
| `UNOWNED` | — | `UNOWNED` | None. |
| any | multiple `agent/*` labels, or cache ≠ GitHub, or lease owner ≠ label owner | `CONFLICTED` | Surface; audit; **no write**. |
| `CLAIMED_ACTIVE` | `renew` within active window | `CLAIMED_ACTIVE` | Extend ownership; no release. |
| `CLAIMED_ACTIVE` | renewal older than active window, lower-tier evidence present | `CLAIMED_LONG_RUNNING` | Escalate observation; no release yet. |
| `CLAIMED_LONG_RUNNING` | lower-tier evidence also stale, no hold/review/wait | `ABANDONED_CANDIDATE` | Start confirmation ladder. |
| `ABANDONED_CANDIDATE` | first stale observation | `ABANDONED_CANDIDATE` | Record observation; wait re-check. |
| `ABANDONED_CANDIDATE` | second stale observation, ladder 1–4 clear (item 5 *is* the release commit) | `RELEASED` | Release via the §8.7 intent protocol (fenced Phase A commit → targeted forge delete → settle); select next status. |
| `ABANDONED_CANDIDATE` | reclaim limit reached | `HELD` | Park; audit; needs-human. |
| `ABANDONED_CANDIDATE` | renew/disposition observed during ladder | `CLAIMED_ACTIVE` | Abort release; clear candidate. |
| `CLAIMED_*` | terminal `disposition` (completed/released/handed_off) | `RELEASED` / successor owner | Honour disposition; do not double-release. |
| `CLAIMED_*` | issue closed, or linked PR merged | `UNOWNED`/terminal | Do not release a live owner's claim just because the issue closed; let sync/close path handle it. |
| `REVIEW_OWNED` | linked PR open or PR-fix row open | `REVIEW_OWNED` | Never release. |
| `EXTERNAL_WAIT` | retry-after in the future | `EXTERNAL_WAIT` | Defer. |
| `EXTERNAL_WAIT` | retry-after elapsed | re-evaluate from evidence | Re-derive. |
| `HELD` | explicit hold / `blocked` + reason / needs-human | `HELD` | Never release. |
| `HELD` | operator clears the hold | re-evaluate | Operator-driven only. |

### 8.5 Release selection (never force `ready`)

Releasing obsolete ownership must **not** always force `status/ready`. Reuse and
extend `releaseIssueClaim`'s existing policy (`src/lib/issue-claim.ts:207-241`):

- `status/in-progress` → `status/ready` (unexplained in-progress).
- `status/blocked` **with** `blockedReason` → keep `blocked` (deliberate).
- `status/blocked` **without** reason → `status/ready`.
- `status/in-review` with an open linked PR → keep `in-review`.
- Closed issue / merged PR → terminal; do not resurrect.
- Otherwise → the lane's next eligible claimable state, resolved from lane
  config, not hard-coded to `ready`.

### 8.6 Fencing — and its hard limit

Every release **decision** is conditioned on the ownership snapshot it was
computed from (owner identity + attempt token + observed lease/heartbeat
versions), the same compare-and-set discipline the stale sweep and PR-fix
reclaim already use (`stale-work.ts:100-140`; `pr-fix-queue.ts` reclaim). A
concurrent `renew`, re-claim, or operator reassign that lands first makes the
release a no-op. Label removal is targeted (never a full label-set write) per
`issue-claim.ts:244-249`.

**What the CAS cannot do.** The fence lives in Postgres; the `agent/*` label
lives on GitHub. GitHub's label API supports no conditional mutation — no
ETag/precondition on the label set, no compare-and-delete. A Prisma
transaction therefore **cannot atomically commit a local CAS and a remote
label deletion**, and a fencing check placed "immediately before" the remote
write is still a check-then-act race: between the read and the DELETE, the
same agent can reclaim with a fresh attempt token, and the stale reconciler's
targeted delete would strip the *new* live claim's label. Claiming atomicity
from the local database alone would be false. This section deliberately makes
no such claim; §8.7 defines the actual cross-system boundary.

### 8.7 The two-sided release boundary (cross-system serialization)

> **Implementation note (#1254).** Landed in `src/lib/ownership-reconciliation.ts`.
> The anchor is the per-issue `IssueMutationGuard` fence with operation
> `reconcile-release` (resumable after a demoted guard, like `stale-release`); the
> release intent is the `OwnershipReleaseIntent` row (unique per
> `(issue, agentLabel)`, carrying `attemptToken`, `phase`, a bounded Phase-B
> `attempts` counter and a `parkedAt` fail-closed marker); the ladder state is
> the `OwnershipReconcileCandidate` row (stale observations, per-claim reclaim
> counter and cooldown — reset per owner, kept across release/reclaim churn).
> The claim side's intent is the `Lease` row itself: the claim route commits the
> lease (fresh attempt token) *before* the remote label add and holds any claim
> with a retryable 409 while an intent is pending — the maintainer force-claim (which may also take over a guard left
> `executing` by a crashed process via the guard `override` — the deliberate
> operator decision the fail-closed posture defers to; the override is
> silence-fenced on the guard's `updatedAt` (`GUARD_OVERRIDE_MIN_AGE_MS`): a
> live holder stamps its guard every `GUARD_HEARTBEAT_MS` while it runs, and
> every remote call it can make is hard-bounded (#1347: per-attempt
> `AbortSignal.timeout`, default 30s via `DISPATCH_GITHUB_TIMEOUT_MS`, plus a
> capped retry backoff in `fetchWithRetry`), so silence past the fence
> evidences a holder that cannot prove liveness — dead, event-loop-blocked,
> or DB-starved. The converse is the accepted cost: a holder that is alive
> and stamping is never override-eligible, however wedged its operation is,
> and the issue stays pinned until that process restarts (the inspect
> surface's `overrideEligible` says which situation the operator is looking
> at); a silent-but-live holder that resumes after an override loses on the
> ownerToken CAS. A young or freshly stamped executing guard keeps the
> override fail-closed instead of racing a live
> writer through the anchor), the owner/operator
> unclaim and the operator agent-work release, and the direct `assign_agent`
> path (which takes the same anchor as operation `assign`) instead supersede
> a pending intent (audited) via `supersedeOwnershipReleaseIntent`;
> `assign_owner` does not touch agent labels and never cancels a pending
> release. The unassign route (#1361) takes the same anchor as operation
> `unassign` and writes its full label set inside a fenced write, so an
> unassign can neither interleave a maintainer force-claim's `agent/*` add nor
> leave GitHub and the cache disagreeing about it (an unassign that runs
> AFTER a force-claim still removes the claim's label — that is what
> unassigning an agent means); it has no resume branch (it releases the
> anchor on every handled path), so a failed attempt deletes its guard row
> instead of leaving a demoted one behind. Guards left `executing` by a hard crash surface on the ownership
> inspect read view; only an operator clears them. The CAS-unpinnable facts
> are re-derived at commit time, under the anchor: a fresh live-label read
> fails closed on forge errors, and a maintainer hold (`status/blocked` +
> reason), review ownership (open linked PR or open PR-fix queue row), or a
> future lease `retryAfter` withholds the release (issue #1254 "re-check …
> at commit time"). Phase A runs it before the intent-commit transaction
> (nothing commits when withheld); `driveReleaseIntent` repeats it directly
> before every Phase B delete, so a hold that lands while an intent is
> pending withholds the replay too (the intent stays pending; exempt
> operator paths supersede it). Phase A CAS-fences on
> the full claim epoch — `{claimToken, expiredAt, lastRenewalObservedAt,
> disposition}` plus the observed `AgentWork` heartbeat (§8.6) — with the
> heartbeat CAS sequenced before the token-retiring lease CAS so a failed
> heartbeat check cannot partially commit. Phase C refuses to settle over a
> fresh claim (a lease still carrying its token, or any lease behind a
> token-less intent), and clears the intent without a second lifecycle event
> when another writer already released the claim. The stale-work sweep defers
> to pending intents (the reconciler owns that release). The §8.5 status
> selection is computed against a fresh live label read (#1037). The override's
> CAS is the load-bearing fence, and the guarded remote ownership write is now
> **atomic with the guard check** — it is not a read-then-act tripwire.
> Every guarded callback (claim, the direct assignment route — `assign_agent`
> AND `assign_owner`, whose label write is a full-set PUT — the unassign route
> (#1361, whose label write is a full-set PUT too — the direct assignment's
> twin in the other direction), the unclaim route (#1367, whose remote release
> removes the `agent/*` label and may chain a resting-status transition, and
> whose entire mutation now runs under the anchor) — the reconciler's
> Phase B delete, the stale-work sweep, and the capacity handoff's release)
> performs its remote ownership write inside a **fenced write**
> (`IssueMutationContext.runFencedRemoteWrite`,
> `src/lib/issue-mutation-guard.ts`): the fenced write opens a transaction,
> takes the guard row's **exclusive row lock** with a CAS-scoped `UPDATE`
> (which also re-stamps the liveness stamp) and holds that lock **across the
> forge call**. A steal therefore cannot commit between the check and the
> write: the two are one step.
> - the override wins first (it deleted the guard, or a different
>   `ownerToken` owns it) → the fenced `UPDATE` matches no row → the forge
>   function is **never called** → the callback backs off (fenced-deleting any
>   lease it minted) and answers the same busy/conflict shape it used for the
>   old tripwire;
> - the holder wins first → the override's `DELETE` **blocks** on the row lock
>   until the fenced write commits, then re-evaluates its silence predicate
>   (`updatedAt <= cutoff`) against the row the fenced `UPDATE` just re-stamped
>   → the predicate is false → the row is skipped → the override reports
>   `busy` and does **not** steal. The operator's force-claim therefore waits
>   for the in-flight fenced write — bounded by that region's own transaction
>   budget — and is then told the issue is busy; it never waits unboundedly,
>   because that budget is what bounds the lock hold.
>
> **The budget.** A region's transaction budget must dominate the worst case
> of the mutating forge call(s) it holds: a mid-flight abort would release
> the row lock with the remote effect still in flight, which reopens the hole
> the fence closes. `githubCallBudgetMs()` (`src/lib/github-auth.ts`) is the
> worst case of ONE mutating forge call — the attempt chain (3 attempts × the
> per-attempt timeout), the capped retry backoff between attempts
> (2 × `GITHUB_RETRY_MAX_DELAY_MS`), and one cold App installation-token
> fetch — every term bounded by `DISPATCH_GITHUB_TIMEOUT_MS` (default 30s).
> At the default configuration that is 180s, and the region's transaction
> budget is `fencedWriteTimeoutMs()` = `githubCallBudgetMs()` + 15s of slack
> = 195s. The budget is NOT bounded by the override's silence window
> (`GUARD_OVERRIDE_MIN_AGE_MS`, 5 min). That window used to be the only thing
> keeping a committed region from looking stealable: the fence stamped the
> guard row when the region STARTED, and a region that ran longer than the
> silence window would leave the row looking stale the moment it committed
> (the heartbeat's own stamp cannot land while the region holds the row
> lock), so an override could
> steal the guard right after the region's writes landed — while the callback
> was still running, and with the anchor it thought it held. A region now
> **re-stamps the guard row at commit**, inside its own transaction, right
> after its forge calls: the committed row is fresh however long the region
> ran, so a steal blocked on the row lock re-evaluates its silence predicate
> against that fresh row and reports `busy` instead of taking the anchor. The
> budget therefore only has to dominate the region's forge calls; it does not
> have to fit inside the silence window. Regions that carry more — or a
> data-dependent number — of mutating forge calls derive their budget from
> the calls they actually hold. The unclaim route's release is
> **data-dependent** (a label set with duplicated `status/*` labels chains one
> removal each), so its budget is **derived from the issue's observed label
> set** — `releaseIssueClaimWorstCaseCalls`
> (`src/lib/issue-claim.ts`) scaled by
> `fencedWriteTimeoutForCalls`
> (`src/lib/issue-mutation-guard.ts`, `githubCallBudgetMs()` per call +
> slack) — rather than a fixed
> multiplier, so no duplicate-label shape can outrun the region
> (#1367 review). The capacity handoff's shared-release region derives its
> budget the same way, from the release's own label set (its second live
> read); its other region — the targeted own-label removal after an
> ownership change — carries exactly one mutating forge call and uses the
> default single-call budget.
>
> **What the fence proves, precisely.** The steal cannot COMMIT between the
> fence and the write it covers: the steal's `DELETE` blocks on the guard
> row's lock and then fails its silence predicate against the re-stamped row
> (the commit-time stamp, or the fence's opening stamp for a region that
> commits inside the silence window).
> Two boundaries remain, by design:
> - the claim route's forced stale-label cleanup runs **one removal per
>   fenced region** (each of that route's regions carries one mutating forge
>   call), so the
>   removal SET is **not atomic**: a steal that lands between two removals
>   leaves the earlier ones applied. The next region's fence detects the
>   loss and the callback backs off; the override's own claim converges the
>   label state;
> - the claim's **status transition is deliberately outside the fence** —
>   status labels are disjoint from `agent/*`, and the fenced ownership
>   write in front of it already proved, under the row lock, that this
>   holder owns the claim at that moment.
>
> **The pool/lock tradeoff.** The fence deliberately holds ONE pooled
> connection AND the guard row's lock for the duration of the region's
> hard-bounded forge call(s). The hold is bounded by the region's own
> transaction budget — `fencedWriteTimeoutMs()` (195s at the default
> configuration) for a single-call region (e.g. the capacity handoff's
> targeted own-label removal), and the region's derived label-set budget for
> the shared-release regions (the unclaim route and the capacity handoff) —
> so a GitHub outage can hold connections for that budget:
> `maxWait: 5_000` keeps
> the other pool waiters failing fast instead of queueing behind it. The
> guard heartbeat's stamp on the same row would wait behind that lock, so it
> now SKIPS its ticks while a region is in flight: a blocked stamp would hold
> a second pooled connection for the region's whole duration, and a long
> region could otherwise tie up enough connections to starve every other
> query in the app. The row's liveness during a region is carried by the
> region's own opening stamp and its commit-time re-stamp instead.
>
> The residual window between the old read and the remote call — the
> ownerToken-CAS-losing cost the override itself accepts — is therefore
> **gone** for every write the fence covers: the only way the override can
> win is to delete the guard first, and then the fenced write finds no row
> to lock and issues no remote write.
> The re-read (`stillHoldsGuard`) survives for LOCAL decisions only (a
> Postgres-only decision that needs no forge fence).
> Mode semantics: `off` (default) starts no new release but still **replays**
> intents already committed before the mode change — otherwise a pending
> intent would hold the issue's claim path forever with no self-healing path;
> `audit` performs no mutations at all — it is read-only for persisted
> `OwnershipReconcileCandidate` state (each pass re-derives the ladder from
> stored state, or a simulated fresh row when none exists), writes only
> AuditLog annotations, and does not even replay intents; `enforce` runs the
> full protocol. A claim with zero Dispatch-side evidence still derives
> `UNKNOWN` (#1251) and is never released — the intent-only Phase A (null
> attempt token) is reachable only for claims whose ladder decision rested on
> an active `AgentWork` row with no `Lease` row (a worker that started work
> before claiming), and it aborts when a lease row appears under the lock.

**Annotation cadence (#1363).** The per-pass annotations
(`ownership_reconcile_candidate`, `ownership_reconcile_parked`,
`ownership_reconcile_release_withheld`, `ownership_reconcile_unverifiable`)
fire for every examined candidate on every sweep pass, so an unchanged
candidate would grow the audit log by one identical row per pass — hundreds
per day at the default cadence. They therefore dedupe per candidate: a write
whose content (state/reasons/ladder notes, label snapshots, success and error
fields) is byte-identical to the candidate's latest annotation of the same
action is suppressed until `DISPATCH_RECONCILE_ANNOTATION_REEMIT_MS` has
elapsed since that annotation (default 24h, clamped 1m–7d), after which it is
re-emitted once as a fresh confirmation that the candidate is still in that
state. A state change, a ladder advance, or a label change always differs in
content and is never suppressed, so the operator still sees a candidate's
current state and every ladder transition. The event-shaped actions
(`ownership_release_intent`, `ownership_release_intent_superseded`,
`ownership_reconcile_guard_lost`, `ownership_reconcile_intent_parked`) are
exempt: each marks one lifecycle milestone, and their volume is bounded by the
intent lifecycle, not by pass cadence. The dedupe lookup is served by the
`AuditLog(actor, action, issueId, createdAt DESC)` index.

Because the remote write cannot be fenced, the design fences **admission** in
Postgres and lets that barrier serialize the remote write against every other
automation writer of the same label. The anchor's row lock additionally makes
each guarded ownership write **atomic with its admission check** (see the
§8.7 implementation note above): the forge call happens while the anchor row's
lock is held, so no ownership steal can commit between "the guard is mine" and
"the label changed" (status writes are the documented exception — they are
disjoint from `agent/*` and deliberately sit outside the fence). The
invariant:

> **Every reconciler-initiated `agent/*` label delete, and every claim-path
> `agent/*` label add, is backed by a Postgres intent committed under one
> per-issue serialization anchor before the remote call is made. No protocol
> path (reconciler or claim) issues a remote `agent/*` label write outside a
> live intent.**
>
> **Deliberate exemptions:** three direct, intent-free writers stay outside the
> protocol — the owning agent's `POST /api/issues/unclaim` (removes only its
> *own* observed label through `releaseIssueClaim`, which already skips a newer
> owner's label — `issue-claim.ts:144-153`); the maintainer `force=true`
> stale-label cleanup (`src/app/api/issues/claim/route.ts:193-210`); and direct
> assignment via `POST /api/issues/actions` `assign_agent`
> (`docs/assignment-conflict-policy.md:18`), used by operators and external
> pipelines. These are explicit owner/operator/pipeline decisions naming a
> specific agent, and they are audited. They still run under the anchor rule
> *when they coincide with a pending intent*: under the lock, a pending
> reconciler intent is **superseded** (audited) rather than silently raced, and
> because label add/delete are idempotent, the post-settle label state
> converges on the explicit human/pipeline choice, not the abandoned
> reconciler's.

**The anchor.** One Postgres serialization point per `(repo, issue)` — the
issue's ownership row locked with `SELECT … FOR UPDATE`, or a per-issue
advisory lock; the implementation tickets pick exactly one and all writers use
it. Every protocol below (release intent, claim intent, settle, exempt-path
intent check) is a transaction on that anchor. Ordering between two concurrent
writers is decided **by the lock, not by timing**: one commits first, the
other loses or is held. #1259 landed this anchor shape while this design was in
review: `withIssueMutationGuard` (`src/lib/issue-mutation-guard.ts`) is a
persistent per-issue guard row (unique on `issueId`) that already serializes
claim, resume, and fenced capacity-release mutations, and `Lease.claimToken`
(`prisma/schema.prisma:903`) is a per-claim unique receipt. The protocol below
builds on that machinery — the reconciler takes the same guard, and the
attempt-token discipline of §6.1 generalizes `claimToken` — rather than
standing up a second lock.

State per `(repo, issue)`: two intent records under the same anchor — a
release-intent (`issue-claim-release` style, reusing the
`staleClaimReleasePending` two-phase pattern from
`stale-work.ts:100-140,173-179`) and a claim-intent written by step 2 of the
Claim side — each carrying
`(issueId, agentLabel, attemptToken, phase, createdAt)` and owned/replayed by
its own path (reconciler replays release intents; the claim route replays its
own unsettled claim intent on retry). The `Lease.attemptToken` column from
§6.1 is the fencing token the phases pin against.

**Phase A — fenced intent commit (Postgres only, atomic).** One transaction on
the anchor: CAS the ownership row on `(owner, attemptToken = g)`; if it
matches, retire token `g` (monotonic — `g` can never renew or checkpoint
again), write the pending intent `(agentLabel = "agent/<name>", token = g)`,
increment the reclaim counter, and write the audit row. This commit **is** the
fence: from this instant, (a) `renew`/`checkpoint` carrying token `g` is
rejected, and (b) the claim path is held (see Claim side below) — **any** claim
on this issue, not only a re-add of the intent-named label, so no new owner
can land (and no §8.5 status selection can stomp a fresh claim) until settle.
Legacy label-only claims with **no `Lease`/`AgentWork` row** — the stranded
`agent/courier` case from §1 — release through the same anchor with an
**intent-only Phase A** (null attempt token): under the lock, re-read the live
labels through the forge adapter (§7) and commit the intent only if the
observed `agent/*` label is still exactly the one named.

**Claim side (the other half of the boundary).** The barrier is not a
read-then-act check — that is the anti-pattern §8.6 rejects, just relocated.
The claim path is transactional and ordered the same way as the release:

1. Lock the anchor. If a pending delete-intent exists for the issue, fail with
   a retryable `409` (bounded by the reconciler's retry cadence).
2. Otherwise commit the **claim intent**: issue the fresh attempt token
   (`g+1`) and write the lease/ownership row, in the same transaction.
3. Only after that commit, make the remote `addIssueLabel` call; settle the
   claim intent in Postgres afterwards (crash-safe replay re-adds — the label
   add is idempotent — without creating a second owner).

This **supersedes the current claim-route ordering**, which calls
`addIssueLabel` (`src/app/api/issues/claim/route.ts:222`) *before* writing the
lease (`upsertLease` at `:268`): intent/lease commit first, remote add second.
With both sides serialized on the anchor, every interleaving resolves: a
claim that wins the lock commits `g+1` first and Phase A's CAS on `g` then
**fails** (release is a no-op); a Phase A that wins the lock first makes the
claim transaction take the `409` hold. There is no window in which an
in-flight claim's ADD and a settled release's DELETE overlap.

**Phase B — forge write (the only remote mutation of a release).** Issue the
targeted `removeIssueLabel(issue, agentLabel)` through the forge adapter (§7).
It runs **only while a matching intent exists** — never speculatively, never
for a label an intent does not name. Because the claim path cannot add any
`agent/*` label for the issue while the intent is pending (§8.7 Claim side),
no concurrent ADD can race this DELETE — serialization by the anchor, not by
timing.

**Phase C — settle (Postgres only).** One transaction on the anchor: re-check
the intent still matches `(issueId, agentLabel, token g)`, clear it, finalize
the release (`AgentWork` terminal, lease row retired), and apply the §8.5
next-status selection. The claim barrier lifts only as part of this commit, so
the status writes cannot land on a freshly claimed issue: any claim that
arrived during A–C was `409`-held and will re-evaluate against the settled
state. Status labels are also disjoint from the `agent/*` label, so these
writes cannot collide with the Phase-B target.

**When a new attempt may hold the label again.** Only after Phase C settles
(or an operator explicitly clears the barrier via §9). A same-agent reclaim
after settle is a **fresh** claim: new attempt token `g+1`, intent gone, the
claim path is again the sole *automation* writer of that `agent/*` label (the
§8.7 exemptions cover the owner/operator direct paths). A reconnect *during*
A–C is a rejected renewal, and its re-claim simply waits behind the barrier
it is already subject to.

**Crash/replay matrix (GitHub-success / DB-failure safe).**

| Crash point | Replay behaviour | Why it cannot delete a later attempt |
|---|---|---|
| Before A | Nothing exists; candidate re-derives from evidence. | No intent → no remote write is ever issued. |
| After A, before B | Intent pending; replay issues Phase B, then C. | Claim path is held by the barrier, so no newer claim exists to hit. |
| After B, before C | Intent pending; replay re-issues `removeIssueLabel` (idempotent; 404 = already gone, per `issue-claim.ts:159-161`), then settles. | Same barrier argument: no label re-add could have happened while pending. |
| After C, on a stale retry | No matching intent (cleared at C) → the retry is a local no-op and issues **no** forge call. | A live `g+1` claim's label is never a target: retries act only on intents, and a cleared intent names nothing. |
| Claim side: intent committed, crash before remote ADD | The claim route's retry replays its own pending claim-intent: re-issues the idempotent `addIssueLabel`, then settles it. | The claim intent is pinned to `g+1`; the reconciler never targets a label its own superseded/absent intent does not name. |

**Fail-closed / operator path.** If the forge is unreachable during B, the
intent stays pending and the reconciler retries each tick (issue remains held,
not stranded in a worse state than the manual release today). After bounded
forge retries, park the issue as `HELD`/needs-human with the pending intent
surfaced on the §9 inspect surface; **an operator force-release is the only way
to clear a stuck barrier** — ambiguous automation defers to the operator rather
than pretending the DB commit fenced GitHub.

**Owner-change (reassign).** An operator reassign runs through the same state
machine: its intent names both labels (remove `agent/a`, add `agent/b`), so a
stale reconciler's delete for `agent/a` can never touch `agent/b`, and the
reconciler's Phase-A CAS on `(owner, token)` fails first when the operator
already moved the owner. Note this is **new behavior**: today's
`reassignAgentWork` (`src/app/api/agent-work/route.ts:364`) moves the
`AgentWork` row only and writes no GitHub labels; routing reassign through the
intent protocol is part of the implementation scope the tickets own.

**Pinned negative controls** (acceptance tests the implementation tickets
#1251/#1254 must ship; each asserts no work is ever stolen):

1. **Renewed same-agent claim during stale release.** Hold the release in
   Phase B; deliver `renew(token=g)` → rejected (token retired at A). Settle C,
   then the agent re-claims → `g+1` re-adds the label. Final state: exactly one
   `agent/<name>` label, owned by the *new* attempt.
2. **Changed-owner reassign.** Operator reassigns `agent/a → agent/b` mid-ladder;
   the reconciler's Phase-A CAS fails (owner moved); its Phase-B delete (if any
   in-flight intent predates the reassign) names only `agent/a`. Assert no
   automation path ever issues a delete for `agent/b`.
3. **GitHub delete succeeds, DB settlement fails.** Crash between B and C;
   replay finds the intent, re-issues the idempotent delete (404 accepted), and
   settles once. Assert no double-release, no second audit terminal row, no
   extra label writes.
4. **Retry of an old deletion with a fresh live token.** After settle and a
   fresh live `agent/<name>` claim at `g+1`, a late retry of the old release
   finds no matching intent and issues zero forge calls. Assert the new
   claim's label is untouched.
5. **In-flight claim vs Phase A commit (both lock orders).** Interleave the
   claim transaction and the Phase A intent commit on the anchor in both
   orders: (i) claim commits `g+1` first → Phase A CAS fails, zero forge
   calls, the new claim's label survives; (ii) Phase A commits first → the
   claim is `409`-held and its remote ADD is never issued until settle.
   Assert neither ordering yields a delete of a label the other side just
   added.

## 9. Operator escape hatch

The reconciler must expose, and never bypass, explicit operator controls:

| Control | Mechanism |
|---|---|
| Force-release a specific claim | existing `POST /api/issues/unclaim` (operator) and `POST /api/agent-work {action:"release"}` |
| Reassign to another agent | existing `POST /api/agent-work {action:"reassign"}` |
| Hold an issue (exempt from reconciliation) | new explicit hold marker (e.g. a label + audit row) that maps to `HELD`; distinct from a bare `status/blocked` |
| Admit despite admission gate | existing `POST /api/issues/[issueId]/admission-override` (#1065) — a precedent for an operator override with a reason |
| Inspect unresolved/conflicted ownership | a read surface that lists `CONFLICTED`/`ABANDONED_CANDIDATE` with their evidence |
| Tune windows | configuration for active/grace/re-check/reclaim limits |

All operator actions are maintainer-only and audit-logged, matching §3.6.

## 10. Race and failure cases

| Case | Required behaviour |
|---|---|
| **Active renewal concurrent with release** | Decided by the §8.7 Phase-A CAS: if the renewal commits first, token `g` is still live and the release intent CAS fails (no-op). If the intent commits first, `g` is retired, the renewal is rejected, and the reconnecting worker re-claims as a *new* attempt (`g+1`) held behind the barrier until settle — never reviving the old record, and never losing its label to the in-flight delete. |
| **Disconnected worker** | Not abandoned on first miss. Escalates `ACTIVE → LONG_RUNNING → CANDIDATE` across sustained observations; a reconnect within the grace cancels the candidate. |
| **Missing events / no telemetry** | Insufficient for release. Only raises a candidate; the confirmation ladder plus a bounded reclaim limit applies. |
| **Closed issue** | Do not release a live claim merely because the issue closed; the close/sync path owns terminal cleanup. If the claim is already abandoned, release is ownership-only and must not move status. |
| **Open linked PR** | `REVIEW_OWNED`; never release. PR-fix queue ownership (#1145) takes precedence. |
| **Explicit hold** | `HELD`; never auto-release. Requires an operator to clear. |
| **Deliberate block (`blockedReason`)** | `HELD`; release (if it ever applies) preserves `status/blocked`. |
| **Generic legacy assignment** (`agent/courier`) | `CONFLICTED`/migration policy (§12); never blanket-aliased or stolen. |
| **Multiple agent labels / cache divergence** | `CONFLICTED`; surface, do not guess. |
| **Reconciler crash mid-release** | The §8.7 crash/replay matrix: replay acts only on the pending intent (reusing the `staleClaimReleasePending` two-phase pattern) with an idempotent GitHub delete; a settled release's stale retry issues no forge call, so a later attempt's label is never deleted. |
| **Repeated release/reclaim churn** | Per-claim reclaim counter (`DISPATCH_RECONCILE_MAX_RECLAIMS`); on exhaustion park as `HELD`; reclaim cooldown between attempts (§8.3). |
| **Forge unreachable** | Fail closed: no writes, no cache mutation, retry next tick. |
| **Token rotation / identity change** | Ownership keys on the bound agent identity, so rotation is transparent; a genuinely different identity is a new owner and must re-claim. |

## 11. Improvements over the existing mechanisms (not a parallel system)

1. **Unify the clocks.** Make `renew` extend the same ownership record the queue
   reasons about, and stop letting a 30-min lease and a 5-min heartbeat drift.
   Either renew `Lease` from the checkpoint path or fold lease TTL into the
   ownership record.
2. **Add the missing state layer.** Introduce derived ownership states
   (§4) as a read model over existing tables; no new lease table.
3. **Confirm before releasing.** Replace the sweep's single-timestamp release
   with the §8.2 ladder, reusing the `staleClaimReleasePending` two-phase
   pattern.
4. **Fence with attempt tokens.** Adopt the PR-fix `generation` discipline
   (`PrFixQueueItem.generation`) for issue ownership so release/renew races are
   CAS-safe inside Postgres, and serialize across the Postgres/GitHub boundary
   through the §8.7 intent protocol rather than assuming the CAS reaches
   GitHub. #1259's `IssueMutationGuard` + `Lease.claimToken` already provide the
   per-issue serialization row and a per-claim receipt to build this on.
5. **Make `unknown` first-class.** Surface `CONFLICTED`/candidate rows instead
   of silently excluding.
6. **Reuse `releaseIssueClaim`.** Extend its status-selection policy (§8.5)
   rather than writing a second release path.
7. **Reuse the ack pattern.** Model `register`/`renew`/`disposition` on the
   existing `agentHandouts`/`handoutAcks`/`handoutReclaims` machinery
   (`pr-fix-queue.ts`) instead of inventing a new protocol.

## 12. Compatibility and legacy migration policy

- **No aliasing.** `agent/courier`, `agent/courier-frontier`, and any other
  identity are distinct. The reconciler never treats one as another, and never
  assumes one app owns a whole `agent/courier*` family.
- **No stealing.** A release only targets the *observed* owner of the specific
  claim, fenced by the attempt token; it never removes a newer/different owner.
  Cross-system, this is enforced by the §8.7 anchor: every automation label
  write — release delete *and* claim add — commits its intent under one
  per-issue serialization point before touching GitHub, so a new claim is
  held until settle instead of racing the delete. The local CAS alone fences
  neither direction.
- **`CONFLICTED` is surfaced, not resolved.** Migration is an operator decision
  recorded via the escape hatch (§9), with the reason audited.
- **Legacy identity migration is explicit.** If two identities are genuinely the
  same app (e.g. a rename), that mapping is an operator-declared, audited
  alias/migration — never inferred from a name prefix.
- **Capability adoption is gradual.** Clients may keep using the legacy path;
  they get the weaker liveness ceiling and the full confirmation ladder. New
  clients that implement `register`/`renew`/`disposition` get faster, safer
  recovery. `DISPATCH_WORKER_TOKENS` binding (#1129) is the identity anchor for
  both.

## 13. Rollout and open questions

- Implement behind a mode flag (`off`/`audit`/`enforce`), mirroring
  `DISPATCH_QUEUE_ADMISSION_MODE` (#1065), so the reconciler can annotate
  without acting first. **Landed (#1254)** as
  `DISPATCH_OWNERSHIP_RECONCILE_MODE` (default `off`), with
  `DISPATCH_RECONCILE_MAX_RECLAIMS`, `DISPATCH_RECONCILE_BATCH_SIZE`,
  `DISPATCH_RECONCILE_RECHECK_INTERVAL_MS`,
  `DISPATCH_RECONCILE_RECLAIM_COOLDOWN_MS` and
  `DISPATCH_RECONCILE_MAX_FORGE_RETRIES` as the bounded-window knobs (§8.3).
  Annotation volume is bounded per candidate (#1363) via
  `DISPATCH_RECONCILE_ANNOTATION_REEMIT_MS` (see the annotation-cadence note
  on the §8.7 implementation).
- **Open:** exact window defaults and whether `renew` should be a new endpoint
  or an extension of `POST /api/agent-work/checkpoint`. (#1251 settled the
  endpoint; the defaults remain operator-tunable.)
- **Open:** whether explicit holds use a new `status/`-adjacent label or a
  Postgres marker; either way it must be auditable and operator-cleared.
  (#1254 parks over-reclaimed claims via audit rows + the candidate read
  surface; a first-class hold marker remains open.)
- **Open:** whether the read model is computed on demand or materialised by the
  reconcile job. (#1254 persists only the ladder/candidate rows; the state
  itself stays derived on demand.)
- **Open:** how `CONFLICTED` ownership appears on the Board and in
  `GET /api/issues` for operators. (`GET /api/issues/ownership` surfaces it;
  Board rendering remains open.)

## 14. Requirements traceability (#1245)

Every requirement of #1245 mapped to where this design settles it. Per the
issue's non-goals this PR is **design-only**: the "enforcement" for each row is
the specification plus its pinned negative controls, and production predicates
and regression tests land in the designated implementation children
([#1251](https://github.com/misospace/dispatch/issues/1251) — renewal/capability
and state layer; [#1254](https://github.com/misospace/dispatch/issues/1254) —
bounded reconciliation and fenced release), whose acceptance criteria already
quote this document.

| #1245 requirement | Settled in | Negative controls / evidence anchors |
|---|---|---|
| Inventory claim/lease/ack/AgentWork semantics | §3.1–§3.9 (file:line cited) | Gap summary §3.9 |
| Authoritative ownership/liveness evidence, separate from labels | §4 (derived states), §5 (evidence tiers) | Tier separation §5 |
| Arbitrary workers; minimal optional capability; safe without it | §6.1 (`register`/`renew`/`disposition`), §6.2 | Unverified clients stay conservatively owned, never auto-abandoned |
| Distinguish abandoned / long-running / review-owned / external wait / human assignment / maintainer hold | §4 state table (`CLAIMED_LONG_RUNNING`, `REVIEW_OWNED`, `EXTERNAL_WAIT`, `HELD`, …) | `HELD`/`REVIEW_OWNED` terminal for automation |
| Bounded reconciliation, expiration/grace periods, restart recovery, explicit operator controls; missing telemetry ≠ abandonment | §8.1 (bounded, single-replica, quotas), §8.2 (confirmation ladder — never a single missing signal), §8.3 (grace windows), §8.7 crash/replay matrix (restart recovery of pending intents), §9 (operator controls) | §5 tiering explicitly rejects "missing telemetry" as abandonment evidence; §10 rows "disconnected workers", "missing events", "forge outage" |
| Release only verified obsolete ownership atomically, fenced against renewed/replaced owner | §8.2 ladder, §8.6 (CAS hard limit), §8.7 Phase A–C protocol | Controls 1–5 of §8.7 (same-agent reclaim, reassign, remote-success/local-failure, stale retry vs fresh token, both lock orders) |
| Preserve attempt history, audits, genuine blocker reasons, linked-PR ownership; select next eligible state, never force `ready` | §8.5 (reuses `releaseIssueClaim` status policy, `issue-claim.ts:207-241`), §8.7 Phase C | Blocked-reason preservation cited at §8.5; history rows §11 |
| Legacy identity migration explicit; no `agent/courier*` aliasing; no stealing | §12 | Operator-declared, audited migration only |
| GitHub/cache/lease consistency; unresolved ownership surfaced as unknown; bounded retries and release/reclaim churn | §8.7 (intents + fail-closed park), §4 (`CONFLICTED`), §10 (churn, forge outage rows) | Stuck barrier is operator-cleared only; bounded Phase-B retries then `HELD` |
| Deliverables: state model, evidence hierarchy, migration policy, transition table, operator escape hatch, race/failure cases, inspect-first | §4, §5, §12, §8.4, §9, §10, §3/§11 | §11: improvements over existing machinery, not a parallel system |

## References

- `docs/assignment-conflict-policy.md` — one-agent-label rule and conflict
  analysis.
- `docs/worker-execution-contract.md` — worker contract, PR-fix hand-out ack
  (#1211), token tiers (#1129).
- `docs/pr-review-fix-queue.md` — PR-fix ownership, generation fencing, reclaim.
- `docs/hosted-groomer.md` — admission mode/override (#1065), the
  audit/enforce rollout precedent.
- `docs/capacity-handoff.md` — fenced capacity-exhaustion handoffs (#1259),
  the landed `IssueMutationGuard`/`claimToken` serialization machinery this
  design builds on.
- `src/lib/lease.ts`, `src/lib/agent-work.ts`, `src/lib/stale-work.ts`,
  `src/lib/issue-claim.ts`, `src/lib/pr-fix-queue.ts` — current mechanisms.
