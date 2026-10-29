# Fenced Capacity-Exhaustion Handoff (#1256)

Dispatch-native recovery for the case "the worker holding a handed attempt
cannot actually run it because its execution capacity is exhausted". The work
must return to circulation **for other compatible workers** without letting a
stale worker stomp a newer claim, a human hold, or anyone's retry budget.

This is a generic Dispatch capability. The `capacity` identifier is an opaque,
worker-chosen string (for example `provider/model-a` or `runner-pool-gpu`);
Dispatch never interprets it and carries no coupling to any particular
executor, provider, or source product.

## The two surfaces

| Work form | Operation | Fencing token (issued by) |
|---|---|---|
| PR-fix queue attempt | `POST /api/agents/{agent}/tasks/report` with `outcome: "capacity-exhausted"`, `capacity`, and the issued `prFixItem: { id, generation, handoutToken }` | `next-task` hand-out (#1074 token + #1256 per-hand-out receipt token) |
| Claimed issue | `POST /api/issues/capacity-handoff` with `issueId`, `repoFullName`, `issueNumber`, `agentName`, `claimToken`, `capacity` (optional `settlementKey` for durable replay, #1262) | `POST /api/issues/claim` response `claimToken` (also in the `active-work` resume context) |

Both require bearer auth; a bound worker credential (`DISPATCH_WORKER_TOKENS`)
may only hand off its **own** agent's work, and the unbound legacy worker token
is refused (#1129). A handoff must be an *explicit* recognition: a non-empty,
bounded (≤200 chars) `capacity` and a valid issued token are hard 400 gates.

## Attempt tokens and fencing

* **PR-fix**: settlement is a compare-and-set on `(item id, status QUEUED,
  generation)` — a stale generation (a fresh attempt was re-issued meanwhile),
  an already-settled status, or a human hold (BLOCKED / PARKED / NEEDS_HUMAN)
  settles as a no-op; the report never overwrites newer state. For
  `capacity-exhausted` the CAS is bound further, to the **exact source
  attempt**: next-task mints a fresh opaque `handoutToken` per hand-out and
  persists it as a receipt (`PrFixQueueItem.handoutReceipts`, one entry per
  live hand-out, format `token@agent@generation`). The report must present
  that token, and the write — pinned on the full receipt/hand-out/ack lists —
  removes **only the reporting agent's** receipt, hand-out record, and own
  ack. An unrelated agent that merely knows `(id, generation)` has no
  authority, and neither does the *same* agent presenting a token from a
  **previous** hand-out of the same generation (release keeps the generation,
  so generation alone cannot distinguish hand-outs). A receipt exists exactly
  while its `agentHandouts` entry exists — issuance pushes both in one
  conditional write and every clear site clears both — so a released,
  reclaimed, or generation-superseded hand-out can never be settled with its
  old token. Pre-receipt (legacy) hand-outs cannot settle this outcome; every
  other outcome ignores the token and settles unchanged.
* **Issue**: the claim token lives on the `Lease` row (`Lease.claimToken`,
  unique, minted at lease creation). Renewals deliberately keep the token (a
  heartbeating worker keeps its receipt), but a released or expired lease that
  is re-claimed is a **new row with a new token** — an old worker's token is
  permanently inert against a newer claim. A durable `IssueMutationGuard`
  serializes cooperating claim, lease-upsert, and capacity-release mutations
  per issue. The release retains the lease while it performs remote cleanup;
  only after GitHub cleanup succeeds does it CAS-delete
  `(lease id, agentName, issueId, expiredAt > now)`. A failed CAS is an
  invariant/bypass race, not the normal inter-writer coordination mechanism.

## Human-hold and ownership safeguards (issue surface)

Checked **before** any write; every refusal is 409/400 with zero mutation:

* closed issue, cached or **live** `status/done`;
* deliberate block: cached `status/blocked` carrying a `blockedReason`, or
  **any live `status/blocked`** — fail-closed: a block applied on GitHub that
  has not reached the cache is still a hold, and releasing it is an explicit
  operator action, never a side effect of a capacity handoff;
* ownership changed: the **live GitHub** label set (not the cache — #1037
  rule) carries a *different* `agent/*` label, or *no* agent label at all
  (already released or human-cleared).
* GitHub unreachable → 503 fail-closed: no lease delete, no label write.

**Post-read ownership re-verification**: a force-claim (which does not delete
the previous agent's lease row) or a human change can land during label
verification. If ownership moved, the release narrows to
**ownership-only** — our own `agent/*` label is removed idempotently and the
cache mirrors the freshest known set minus that label — and no status label
is ever touched, so a newer owner's transition survives. A re-read failure
returns 503 without remote writes, retaining the lease and guard for retry.
A blocked/done hold found on either read is refused without label or lease
mutation; ownership-only cleanup is reserved for genuine changed owners.

## What success does

**Issue handoff** (`issue_capacity_handoff` audit action):

1. The operation creates a committed per-issue durable mutation guard with
   `executing: true`. Cooperating claim and `upsertLease` writers cannot enter
   during release. Only an exact agent+token retry can atomically resume a
   retained `capacity-release` guard with `executing: false`; unrelated
   operations and retries while executing are refused as busy.
2. Claim cleanup uses the shared `releaseIssueClaim` policy, based on live
   labels: `agent/<name>` removed; `status/in-progress` → `status/ready`
   (immediately discoverable to another compatible worker); `status/in-review`
   is retained with a status note. If ownership changed during verification,
   cleanup removes only our own agent label and never changes status.
3. When the caller supplied a `settlementKey` (#1262), a durable
   `IssueHandoffSettlement` record is written **before** the lease CAS-delete
   (see the next section). A record-write failure fails closed: 500
   `release_failed`, lease and guard retained for the exact-token retry.
4. Only after remote label cleanup succeeds is the exact lease CAS-deleted.
   Active `AgentWork` rows are then retired with history, followed by the
   `CapacityHandoff` cooldown (`kind: "issue"`, pinned to the same deadline as
   the settlement record) and audit record.

**PR-fix handoff** (`capacity_handoff` PrFixHistory action):

1. Exact-owner CAS (see “Attempt tokens and fencing”): removes the reporting
   agent's receipt, hand-out record, and own ack — and nothing else. Other
   agents' live receipts, hand-out records, and acknowledgements at the same
   generation are preserved, and the dispatch stamps
   (`dispatchedGeneration/At`) plus `postDispatchEvidenceKeys` survive while
   any *other* hand-out at that generation is still live (clearing them would
   reclassify the surviving workers' mid-run evidence as pre-dispatch, #1119);
   only the report that consumes the last live hand-out resets them, making
   the generation freshly dispatchable. The item **stays `QUEUED`** at the
   same `generation` and `fixAttempts`, with `branch`, `url`, and PR state
   untouched — the attempt is returned, not burned, and no repair budget is
   spent. It is explicitly *not* a `WAITING_EXTERNAL` park: nothing hides the
   item from workers whose capacity is unrelated.
2. A `CapacityHandoff` row is written (`kind: "pr_fix"`, recording the
   settled `generation`).
3. Idempotency is layered: a repeat report of the **same capacity at the
   same generation** while the cooldown is active replays as `deferred`
   without minting a second window; concurrent duplicates are fenced by the
   consumed receipt (only one write can remove the exact token) and by the
   CAS pinning the issued hand-out stamp (`dispatchedGeneration =
   generation`) and the full receipt/hand-out/ack lists, so exactly one
   duplicate can win and losers settle as no-ops with zero mutation. A
   *different* capacity exhausting the same live generation records its own
   scoped cooldown (it was legitimately dispatched alongside or after the
   first hand-off, with its own receipt); an older generation's window never
   absorbs a fresh attempt.

## Durable settlement replay (#1262)

A successful issue handoff can lose its HTTP success response, and the success
audit row is best-effort — so the completed release was unprovable: a retry
found no lease and could only be refused (`no_active_claim`), forcing the
caller into a conservative hold. The optional request field `settlementKey`
(at most 200 chars, opaque, caller-chosen) closes that gap without redesigning
the existing path; callers that omit it keep the previous behavior exactly.

* **The record.** A successful keyed release persists an
  `IssueHandoffSettlement` row: unique `(agentName, issueId, settlementKey)`,
  bound to the exact settled `claimToken`, carrying the released
  `labels`/`status`/`statusNote`, the pinned `cooldownUntil`, and a bounded
  retention deadline (`ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS`, 7 days). It is
  tagged `operation: "capacity-handoff"` — the shared ledger also carries the
  fenced attempt-requeue family (#1491), and a key committed by one family is
  a foreign payload for the other. It is
  written **before** the lease CAS-delete — a crash between the two leaves
  the lease intact for the exact-token resume, and the first-write-wins
  upsert can never rewrite the original proof (a resumed attempt therefore
  replays the *first* attempt's recorded result, even if its own would differ
  in `statusNote`/label details). Retention is enforced at read time: expired
  rows are pruned when looked up, rows for never-retried keys live until the
  issue row is hard-deleted (FK cascade). A lease CAS miss (bypass race)
  retracts the row just written — and only its own row (pinned to its claim
  token); a retraction failure is logged for operator reconciliation.
* **Replay.** A retry with the same key + original claim token while the lease
  is gone replays the recorded result verbatim (`replayed: true`) with **zero
  ownership mutation**: no label write, no lease change, no cooldown row, no
  cache mirror — only a best-effort replay audit row and (when the request
  enters the mutation guard) the transient guard row itself. The replay is
  checked before the cached state refusals, so a later close or human block
  can never mask the recorded outcome (a replay mutates nothing, so it cannot
  reverse a hold). A record found while the lease is **still present** is a
  crash-before-CAS window: it is never replayed; the exact-token resume
  finishes the release instead. The replay also answers while the issue's
  mutation guard is **held** (busy path): after a post-release crash the
  orphaned executing guard would otherwise hide the durably completed release
  behind a busy 409 — the replay is gated on lease absence, so a release that
  is genuinely still in flight (lease live) is never announced early.
* **Refusals (fail-closed, no synthetic success).**
  * Newer claim epoch (lease re-issued with a fresh token) → 409
    `stale_claim_token` — the existing fence; replacement ownership is never
    touched.
  * Key settled under a **different** claim token: with the lease gone → 409
    `no_active_claim` (foreign token to a settled key); with a live matching
    lease → 409 `settlement_key_conflict` before any remote work. A fresh key
    is the caller's recovery — keys are never reused across claim incarnations,
    and the token binding wins even when the old proof has already expired.
  * Expired proof → 409 `no_active_claim` with an explicit expiry note; the
    expired row is pruned.
  * Settlement-key fence **read failure** → 503 `settlement_unavailable`
    before any remote work: a failed read establishes nothing, so it is never
    treated as "key unused" (that would let a durable proof under an older
    claim token fail to fence the release of a newer live claim). Retryable
    with the same `claimToken`/`settlementKey`; the guard is retained.
  * Concurrent foreign insert → the first-write-wins upsert returns the other
    claim's row; if its `claimToken` is not this one, the release refuses with
    409 `settlement_key_conflict` **before** the lease CAS — a lease is never
    consumed on a proof this claim does not own (stale-recovery owns
    reconciling the retained lease; retry with a fresh key).
  * Key committed by the **fenced attempt-requeue** family (`operation:
    "attempt-requeue"`) → 409 `settlement_key_conflict`, never a replay: the
    recorded row carries no capacity cooldown, so replaying it would answer a
    capacity handoff with a proof that skips its cooldown. The refusal is
    exact and zero-mutation (the fence read rejects the key before any
    remote work, and the upsert result is rejected before the lease CAS).
  * Settlement-record write failure after cleanup → 500 `release_failed`;
    lease and guard retained for the exact-token retry (proof must be durable
    or the release does not report success).
* **Keys are caller data**, persisted in the database and echoed into audit
  notes — do not embed secrets in them. Dispatch derives nothing from the key
  except idempotency; capacity remains the only (opaque) scoping value. A
  replay echoes the request's `capacity` field while the audit note records
  the settled one; neither is interpreted, and nothing behavioral derives
  from either string.

## Capacity-scoped cooldown

**Trust boundary.** The `capacity` identifier is **caller-declared and
trusted for scoping only** — it is a shaping hint, not an identity claim.
Settlement authority comes exclusively from the issued receipt/claim token,
never from the capacity string, and the cooldown deliberately does **not**
filter by agent: the same worker legitimately declares different capacities
(a different model or runner pool behind one agent name), and an unrelated
capacity must keep receiving the work. A worker that lies about its capacity
can only re-acquire work for a capacity it claims to have exhausted — it
consumes no extra repair budget, and its own hand-out is fenced from anyone
else. Given the active
(`cooldownUntil > now`) handoff rows:

* requester's capacity **equals** the exhausted capacity (matched
  case-insensitively — the identifier is opaque and `Model-A` re-declared is
  the same capacity) → the cooled item is skipped until the deadline;
* requester declares an **unrelated** capacity → the item dispatches normally
  (this is the entire point of scoping the cooldown);
* requester declares **no capacity** → conservatively skips *any* cooled item
  (Dispatch cannot prove it is not the exhausted capacity). Legacy workers are
  thus protected until expiry without globalizing the wait for declared,
  unrelated capacities.

Cooldown bound: `DISPATCH_CAPACITY_COOLDOWN_MS` (default 15 minutes, clamped
to [1 minute, 6 hours]). Expired rows are pruned lazily on read, throttled to
once per minute per process so the prune never becomes a per-poll write on the
dispatch hot path. When every remaining candidate is cooled, `next-task` says
so in the idle reason instead of a bare "No work available". A cooldown read
failure **fails open** (dispatch proceeds unfiltered): handing cooled work to
the exhausted capacity is a bounded nuisance the worker reports again;
blocking the whole lane is not. Symmetrically, a cooldown **write** failure
after the release already committed does not fail the handoff — the response
returns `cooldownUntil: null` (audited), because the ownership release is the
operation the worker asked for and a false 500 would invite a retry that can
only 409. A durable settlement record keeps the **pinned** deadline regardless:
a later replay echoes the recorded proof, so the fresh-response `null` and the
replayed timestamp intentionally differ (bounded dispatch shaping self-expires;
the replayed result is what the first caller earned).

The exhausted capacity's own re-report is also fenced: the PR-fix attempt
token is consumed and the issue lease is gone, so the same worker cannot
double-settle; at worst it re-receives the item after the cooldown, which is
the intended bounded retry for that capacity.

## Label / lease effects and consistency boundaries

**GitHub is the source of truth for the issue's labels and status. The
database (Issue cache, Lease, AgentWork, CapacityHandoff, PrFixQueueItem) is
Dispatch's coordination layer — never write it as if GitHub were behind.**

* Ownership is *verified* against live GitHub labels before any mutation; the
  Prisma cache is used only for non-label facts (`blockedReason`,
  `linkedPrNumber`, closed state) and the post-write mirror.
* Label writes are targeted (`removeIssueLabel` for the agent label,
  `transitionIssueStatus` for the status swap), never a full label-set
  replacement, so concurrent human label changes on GitHub are not reverted.
* A durable `IssueMutationGuard` serializes cooperating claim,
  `upsertLease`, and capacity-release writers for an issue. It is a persistent
  singleton row per issue, not a lease: there is no automatic timeout or
  stale-guard clearing. The `executing` flag is a durable, nonexpiring
  execution fence: callback work runs outside database transactions, and only
  the matching owner can reopen a completed-but-incomplete attempt. A crash
  leaves `executing: true`; an operator must confirm process termination
  before resetting it to false. Routine local-only lease failures remove
  their own guard safely. A failed claim can resume under the same agent's
  nonexecuting guard: it re-verifies live ownership and human holds, repairs
  the cache plus lifecycle event transaction and lease, and does not steal a
  changed claim. Other agents cannot enter until reconciliation finishes.
* Capacity release retains its lease until GitHub label cleanup succeeds; the
  exact lease CAS delete follows remote cleanup. A cleanup failure retains both
  lease and guard for an exact-token retry. Failed GitHub reads/removals must
  not be represented as a successful cache mirror or lease release. After a
  crash, an operator must confirm the prior process stopped and reconcile live
  GitHub state before removing the guard. There is no timeout-based automatic
  recovery that could overlap an in-flight remote mutation.
* `CapacityHandoff` rows are Dispatch-local dispatch shaping. They are not
  mirrored to GitHub, carry no label, and self-expire; deleting them is always
  safe.
* The PR-fix cooldown deliberately does not touch PR state on GitHub at all:
  no label, no comment, no push. Queue-row changes are cache-side work
  bookkeeping; the PR/branch identity is retained exactly.
* Lease expiry alone never clears labels — expiry is a *staleness* signal
  owned by stale-claim recovery; capacity handoff is an *intentional* release
  owned by the worker holding the token.

## Failure-mode summary

| Situation | Result |
|---|---|
| Missing/blank capacity, attempt token, or receipt token (PR-fix) | 400 |
| PR-fix receipt token not owned by the reporting agent (unknown, rotated, or another agent's) | report `skipped`, queue untouched |
| Wrong agent's token (bound worker) | 403 |
| GitHub labels unreadable | 503, zero writes |
| Stale claim token (re-claimed lease) | 409 `stale_claim_token` |
| Expired lease | 409 `claim_expired` (stale recovery owns release) |
| Different/missing live `agent/*` label | 409 `ownership_changed` |
| Deliberate block / done / closed | 409/400 human hold |
| Another cooperating issue mutation is active / guard is not the exact resumable release | 409 busy response; no remote mutation |
| Cleanup fails after guard acquisition | Lease and durable guard retained; exact-token retry can resume |
| Lease CAS unexpectedly misses after remote cleanup (bypassing writer) | 409 `handoff_race_lost`; no cooldown is recorded; reconcile GitHub and lease state |
| Retry with same `settlementKey` + original claim token after lease release | replayed recorded success (`replayed: true`), zero ownership mutation |
| Same replay while the issue mutation guard is held (post-release crash) | still replayed — lease absence gates the answer; a live release (lease present) stays 409 busy |
| `settlementKey` bound to a different claim token | 409 (`no_active_claim` or `settlement_key_conflict`); no replay, no mutation |
| `settlementKey` committed by another settlement family (the fenced attempt-requeue ledger) | 409 `settlement_key_conflict`; never replayed as a capacity handoff (its cooldown would be skipped), no remote work |
| Settlement-key fence read fails | 503 `settlement_unavailable` before any remote work; a failed read is never "absent"; retryable with the same token + key |
| Concurrent foreign settle wins the upsert race | 409 `settlement_key_conflict` before the lease CAS; lease retained, no success reported |
| Settlement proof expired (7-day retention, read-time prune) | 409 `no_active_claim` with expiry note |
| Settlement record write fails after cleanup | 500 `release_failed`; lease + guard retained for exact-token retry |
| Guard remains after process crash | Operator confirms prior process stopped and reconciles GitHub before removal; no automatic timeout; a recorded settlement lets the retry answer definitively even while the guard is held |
| PR-fix generation moved / status settled | report `skipped`, queue untouched |
| Repeat PR-fix report | `deferred`, one cooldown window only |

## Relation to the fenced attempt-requeue (#1491)

The pinned retry routes (`POST /api/pr-fix-queue/attempt-requeue`,
`POST /api/issues/requeue`) deliberately reuse this family's machinery and
vocabulary rather than the CI-park or operator-reset ones:

- The issue-requeue settlement rides the same `IssueHandoffSettlement`
  ledger (#1262): first-write-wins, reaxed on a lease-CAS miss, bounded
  retention. Rows are tagged `operation: "attempt-requeue"` and carry a
  payload fingerprint — a key first committed by capacity-handoff is a
  payload conflict for the requeue (and vice versa), never a cross-family
  replay.
- The human-hold rule is identical: any live `status/blocked` label refuses
  fail-closed (`human-hold`).
- The release is the shared `releaseIssueClaim` under the per-issue mutation
  anchor and the fenced remote write — the current owner is never touched,
  and a newer claim token on the lease refuses the retry
  (`stale-generation`).
- What differs: the capacity handoff records a capacity cooldown; the
  requeue consumes nothing and cools nothing — it returns the work to
  offerable. And the requeue fence validates against the durable
  `AttemptIssuance` issuance history (a terminal report releases the live
  receipt before the retry arrives), which the capacity handoff — issued
  mid-run against a live lease — never needed.
