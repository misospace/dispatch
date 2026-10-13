# PR-fix recovery on fresh evidence

> **Issue:** [misospace/dispatch#1244](https://github.com/misospace/dispatch/issues/1244)
>
> **Status: design only.** This document specifies behavior; it does not
> implement it. No schema, route, budget, credential, or deployment change is
> authorized by this design alone. See [Non-goals](#non-goals).

**Reading this document.** Every claim is marked:

- **Current** — implemented today; the cited code is the authority.
- **Proposed** — specified by this design and not yet implemented.
- **Gap** — required by the issue but missing from current behavior.

Where a sentence mixes current and proposed behavior, the qualifier is explicit.
The state-transition table marks proposed rows.

## Problem

Actionable PR feedback can remain stranded behind an older disposition. A
`no_change_needed`/`FIXED` tombstone, a `PARKED` operational hold, or a
`WAITING_EXTERNAL` wait can all predate feedback posted afterwards, and the
queue has no general rule that says "this evidence is newer than that
disposition, so the work must be reactivated."

Observed 2026-10-13 on Courier PR #294 and Dispatch PR #1239: newer review
blockers sat behind preceding attempts while items were reported
`WAITING_EXTERNAL` with scheduled retries and the note *"no changes pushed;
queued feedback resolution is not verified."* PR #1239 had also received a
successful push from another attempt — a single queue note is not the complete
PR history. These observations motivate the design; they do not prove the
precise transition defect.

The root shape of the defect is a **missing freshness relation**: the queue
records *that* evidence was seen (dedupe keys) but not *what state it was
relative to which attempt*, so it cannot answer "is this observation newer than
the disposition that parked or resolved the item?"

## Scope

This design covers Dispatch's `PrFixQueueItem` lifecycle as implemented in
`src/lib/pr-fix-queue.ts`, `src/lib/pr-followup-ingestion.ts`,
`src/lib/pr-fix-surfacing.ts`, and the `/api/pr-fix-queue/*`,
`/api/pr-followup/*`, and `/api/agents/{agentName}/tasks/report` routes. It
defines evidence identity, freshness, disposition classes, reactivation rules,
ownership fencing, reconciliation, unknown-evidence behavior, and negative
controls. It is worker-independent: it coordinates only through the documented
queue API, the `(id, generation)` attempt token, and `tasks/report`.

## Non-goals

- No implementation, automatic bulk requeues, attempt-counter erasure,
  credential changes, timeout increases, or deployment changes.
- Not a Courier contract. No requirement for Courier, its phases, or its
  telemetry. Execution-provider exhaustion is
  [misospace/courier#320](https://github.com/misospace/courier/issues/320), not
  Dispatch recovery ownership.
- No change to the `PR_FIX_MAX_ATTEMPTS`, `PR_FIX_MAX_RECLAIMS`, or
  `PR_FIX_EXTERNAL_WAIT_COOLDOWN_MS` defaults. Reactivation uses the existing
  attempt cap; this design adds no counter.

## Vocabulary

| Term | Meaning |
|------|---------|
| **Evidence identity** | The stable key of an observation, e.g. `review:<repo>#<pr>:<reviewId>`. Replayed webhooks of the same observation share it. Current format: `computeEvidenceKey` in `src/lib/pr-followup-ingestion.ts:255`. |
| **Evidence version** | The state-bearing fields of an identity (head SHA, review state/`commit_id`, comment resolution/`updated_at`, check `status`/`conclusion`). A new *version* of a known identity is only fresh if its transition is actionable. |
| **Evidence watermark** | The record of `(identity, version, observedAt)` seen for the item, plus the head SHA, relative to which freshness is measured. Backed today by `evidenceKeys` (40, FIFO) and `postDispatchEvidenceKeys` (20, priority-eviction); see [Evidence watermark lifetime](#evidence-watermark-lifetime). |
| **Attempt** | One dispatchable unit of PR-fix work, identified by `(id, generation)`. |
| **Disposition** | The reason an item is not actively dispatchable: `human_decision`, `no_progress`, `infra_failure`, `security_failure`, or `external_wait`. Distinct from `status` (see below). |
| **Hold class** | The recovery semantics of a disposition: `active`, `resolved`, `operational`, `human`, or `terminal`. Recovery keys off hold class, not status alone. |
| **Hand-out** | A stamped dispatch of an attempt to a worker (`dispatchedGeneration`/`dispatchedAt`). |
| **Ack** | The worker's durable claim of a hand-out (`handoutAcks`), which protects a live attempt from reclamation. |

## Authoritative evidence identity

Freshness must be computed from identities the forge guarantees, never from
prose. The configured forge capability is the only read/write path; this design
does not depend on any forge-specific CLI or on a particular provider, only on
the presence of the following fields through the configured capability.

| Event kind | Identity | Version / freshness fields | Actionable transition |
|------------|----------|----------------------------|-----------------------|
| `review` | review id | `state`, `commit_id`, `submitted_at` | `CHANGES_REQUESTED` (and only while it is the review's current state) |
| `review_comment` | comment id | `commit_id`, `updated_at`, resolution/outdated state (**Proposed** read) | unresolved comment on the current or a newer head |
| `comment` | comment id | `updated_at`, author association | non-bot comment on the PR |
| `check_run` | check run id | `head_sha`, `status`, `conclusion`, `completed_at` | `failure`/`timed_out`/`action_required`/`cancelled` on the current or a newer head |
| `merge_state` | derived from the state string | the state string + head | a **persistent** problematic state (`behind`, `dirty`, `unstable`, `has_hooks`) |
| `merge_conflict` | derived (`conflicting`) | `mergeable` | `CONFLICTING` persists |

**Gap:** the current forge reads expose head SHA, merge state, and PR state
(`src/lib/github-prs.ts`) but **not** review-comment resolution/outdated state.
Discriminating "already-resolved comments" (a required behavior) therefore needs
a new read capability; this design assumes it can be obtained through the
configured forge capability and marks the field **Proposed**.

Two rules make this "fresh" rather than merely "seen":

1. **Identity is stable across replays.** A duplicated webhook, a re-read by the
   periodic sync, or an at-least-once redelivery has the same identity and must
   be a no-op. The current `evidenceKeys` dedupe (`uniqueAppend`,
   `src/lib/pr-fix-queue.ts:297`) gives this for identity; this design extends
   it with version.
2. **Version transitions, not repetitions, are fresh.** A `check_run` that was
   `pending` at the snapshot and is now `failure` is fresh. A `review` submitted
   on a *new* commit is fresh; a second review with the same body and the same
   `commit_id` submitted as a new review id is **repeated review text** and is
   not fresh. An issue comment that was resolved/outdated and is re-read
   unchanged is not fresh. This closes the gap where a new id alone counted as
   new work.

### Content signature (anti-repetition)

To distinguish genuinely new feedback from repeated review text, freshness for
`review` and `comment`/`review_comment` kinds also compares a **content
signature** = hash of `(normalized body, author identity, state, commit_id)`.
If a new identity carries a signature already present in the watermark at the
same or newer head, it is recorded for audit but is **not** actionable on its
own. Body text alone never establishes freshness; the authoritative identity and
version do.

### Conditions vs one-shot events

`merge_state` and `merge_conflict` describe a **condition** that can persist or
clear, not a single observation. They are actionable only while the condition
holds and only when it is persistent across at least one re-read (so transient
`behind` churn during normal rebases does not open work). A condition that
clears is not evidence of anything and must not reactivate.

## Evidence watermark lifetime

Freshness cannot rely on "not present in a cache" alone, because the current
caches are bounded and lossy:

- **Current:** `evidenceKeys` is a 40-entry FIFO (`uniqueAppend` is
  `slice(-maxItems)`, `src/lib/pr-fix-queue.ts:297`), and one review contributes
  one key per inline comment, so eviction is routine.
- **Current:** `postDispatchEvidenceKeys` is a *separate* 20-entry list with
  priority eviction (`:311`). Every fresh attempt **clears** it (`:1238`).
- **Current:** `PrFixHistory` is the immutable audit record.

The design therefore makes a **durable disposition record** the authoritative
freshness boundary, not cache membership or a re-read timestamp:

- **Proposed:** each item stores `disposedAt` (set when a disposition is
  written), `recoveryAppliedAt` (set when a reactivation is applied), and
  `disposedEvidence` (the `(identity, version)` that triggered the current
  disposition).
- `observedAt` is the **forge-side event timestamp** where one exists
  (`review.submitted_at`, `comment.updated_at`, `check_run.completed_at`), not
  the time ingestion happened to re-read the observation. A periodic re-read of
  an unchanged observation must not mint a fresh `observedAt`.
- `merge_state`/`merge_conflict` have no forge event timestamp (their identity
  *is* the condition string), so for those kinds freshness is decided **only**
  by the durable `(identity, version)` comparison against `disposedEvidence`,
  never by a re-read timestamp.
- An observation is fresh only if its `(identity, version)` differs from
  `disposedEvidence` **and**, where a forge timestamp exists, `observedAt >
  disposedAt` (and `> recoveryAppliedAt` for a repeat). A key evicted from a
  bounded cache but equal to `disposedEvidence` is **not** fresh, no matter when
  it is re-read.
- Cache membership remains a fast-path dedupe; the durable comparison is the
  correctness boundary that survives eviction.
- The per-attempt reset of `postDispatchEvidenceKeys` is preserved as an
  optimization; the immutable history and `disposedEvidence` preserve the prior
  attempt's reason (issue: "Preserve immutable prior attempts and reasons").

## Disposition model: status, disposition, hold class

Today `status` overloads three meanings. The design separates them. Reactivation
by fresh evidence depends on **hold class** and **remaining budget**, not on
`status` alone.

| `status` | `disposition` | Hold class | Reactivatable by fresh evidence? |
|----------|---------------|------------|----------------------------------|
| `QUEUED` | — | active | n/a |
| `FIXED` | — (resolved tombstone) | resolved | **Yes**, bounded by `PR_FIX_MAX_ATTEMPTS` |
| `PARKED` | `no_progress`, budget available | operational | **Yes**, after cooldown, bounded |
| `PARKED` | `no_progress`, budget exhausted | operational (budget-exhausted) | **No**; sets stale-disposition flag; operator requeue resets budget |
| `PARKED` | `infra_failure` | operational (fail-closed) | **No**; needs a recovery trigger or operator |
| `PARKED` | `security_failure` | operational (fail-closed) | **No**; operator only |
| `WAITING_EXTERNAL` | `external_wait` (structured) | operational | **Yes** (trigger / fresh feedback / cooldown) |
| `WAITING_EXTERNAL` | `external_wait` (no dependency) | operational (fail-closed) | **No**; downgraded, see [contract](#waiting_external-contract) |
| `BLOCKED` | `human_decision` | human | **No**; operator/maintainer only |
| any | maintainer hold (**Proposed**) | human | **No** |
| `STALE` | — | terminal | **No**; maintainer mark to `QUEUED` |
| `IGNORED` | — | terminal | **No**; maintainer mark to `QUEUED` |

**Budget-exhausted** means `fixAttempts >= PR_FIX_MAX_ATTEMPTS` **or**
`handoutReclaims >= PR_FIX_MAX_RECLAIMS`. This matters because
`PARKED`/`no_progress` is *created by* those caps: six of the seven `PARKED`
write sites are cap-exhaustion (`src/lib/pr-fix-queue.ts:955`, `:1157`, `:1684`,
`:1847`, `:2130`, `:2805`). The seventh is the generic `markPrFixItem` `PARKED`
path (`:1608`, `:1784`), reachable from the worker-tier
`POST /api/pr-fix-queue/mark` and from the bare-`blocked` report in
`resolvePrFixFromAgentReport` (`:2732`); it parks without incrementing
`fixAttempts`, so it is **budget-available** and reactivatable.

**Proposed:** the item records why it parked (cap-exhausted vs. budget-available
vs. fail-closed), so reactivation never mistakes an exhausted park for a
recoverable one. Reactivation itself increments `fixAttempts`, so repeated
park→reopen cycles terminate at the cap; no new counter is introduced.

Two hard separations the design enforces:

- **Operational parking ≠ human decision.** `PARKED` never carries the
  `needs-human` label; only `BLOCKED`/`human_decision` does
  (`docs/pr-fix-outcome-policy.md`). Evidence may reactivate *operational* holds;
  it must never auto-override a human decision or maintainer hold.
- **Terminal ≠ recoverable.** A merged, closed, or archived PR is `STALE` and
  is never reactivated by evidence (`reconcileStalePrFixItems`,
  `reconcileArchivedRepoPrFixItems`, `src/lib/pr-fix-queue.ts:2206`, `:2274`).

**On "dependency block" (issue bullet 4).** That bullet's non-overridable
"dependency block" is read as the human/maintainer hold class and unresolved
scope decisions — a `BLOCKED` item, or a maintainer hold. An automated
`WAITING_EXTERNAL` on an external dependency is an *operational* wait: fresh
feedback on the PR is new work, not an override of the dependency (the
dependency is re-checked when the new attempt runs).

## Fresh actionable evidence

Let `d` be the item's `disposedAt` and `W` its watermark. An observation
`o = (identity, version, observedAt)` is **fresh actionable evidence** iff all
hold:

1. `o.identity` is actionable by kind (table above) and is not in a
   terminal/resolved state (review no longer `CHANGES_REQUESTED`, comment
   resolved/outdated, condition cleared);
2. `(o.identity, o.version)` is not already recorded in `W` (dedupe by identity
   **and** version, not identity alone);
3. `o.contentSignature` is not already recorded in `W` at the same or newer head
   (anti-repetition);
4. `(o.identity, o.version)` differs from `disposedEvidence` (the evidence that
   triggered the current disposition), **and** `o.observedAt > d` where a
   forge-side event timestamp exists (and `> recoveryAppliedAt` for a repeat
   after a reactivation). This is what handles a key evicted from the bounded
   cache: an old key either equals `disposedEvidence` or has a forge timestamp
   `<= d`, so it is not fresh even when re-read now. For condition kinds with no
   forge event timestamp, only the durable `(identity, version)` comparison
   applies.

**Unknown evidence** is handled separately (see
[Unknown-evidence behavior](#unknown-evidence-behavior)); it never silently
satisfies or violates these predicates.

## State-transition table

Rows marked **P** are proposed; unmarked rows are current. `gen` = generation
change; `att` = `fixAttempts` change. "Cooldown" is
`PR_FIX_RECOVERY_COOLDOWN_MS` (**Proposed**, default 6 h) unless the external
cooldown is named.

| # | Current | Trigger | Result | gen | att | Budget / cooldown | Notes |
|---|---------|---------|--------|-----|-----|-------------------|-------|
| 1 | `QUEUED` (not dispatched) | new actionable evidence | stays `QUEUED`; version recorded | — | — | — | Same attempt; inline comments of one review never count (`#1103`). |
| 2 | `QUEUED` (dispatched) | new actionable evidence | stays `QUEUED`; recorded in `postDispatchEvidenceKeys` | — | — | — | In-flight worker cannot see it; settlement must reopen (`#1119`). |
| 3 | `QUEUED` | duplicate / replayed event | no-op | — | — | — | Identity+version already in `W`. |
| 4 | `QUEUED` | non-actionable/cleared condition | no-op; recorded for audit | — | — | — | Transient `behind`, resolved comment, dismissed review. |
| 5 | `FIXED` | fresh actionable evidence | `QUEUED` fresh attempt | +1 | +1 | cap → `PARKED` + stale flag (row 9) | Enqueue reopen (`:1140`). |
| 6 | `FIXED` | known evidence, head unchanged | `QUEUED` fresh attempt | +1 | +1 | cap → `PARKED` + stale flag (row 9) | `#940`; FIXED tombstone is untrusted (`:1136`). |
| 7 | `FIXED` | duplicate/repeated text | no-op | — | — | — | Anti-churn (`#25`). |
| 8 | **P** `PARKED`/`no_progress`, **budget available** | fresh actionable evidence, cooldown elapsed | `QUEUED` fresh attempt; clear `retryAt`/stale flag | +1 | +1 | cap → `PARKED` | **Gap today:** `PARKED` is sticky to enqueue (`:1116`). |
| 9 | **P** `PARKED`/`no_progress`, **budget exhausted** | fresh actionable evidence | stays `PARKED`; set stale-disposition flag; record evidence | — | — | — | Operator requeue resets budget. Prevents livelock. |
| 10 | `PARKED`/`infra_failure` | PR feedback | stays `PARKED`; recorded; stale flag | — | — | — | Infra recovery is not PR evidence; needs health signal/operator. |
| 11 | `PARKED`/`security_failure` | PR feedback | stays `PARKED`; recorded | — | — | — | Operator only (fail-closed). |
| 12 | **P** `WAITING_EXTERNAL` | recorded recovery trigger fires | `QUEUED` recheck; clear `retryAt` | +1 | — | — | Recheck of the dependency; uncharged (matches current cooldown). |
| 13 | **P** `WAITING_EXTERNAL` | fresh actionable feedback | `QUEUED` fresh attempt; dependency re-checked on run; clear `retryAt` | +1 | +1 | cap | New work independent of the dependency. |
| 14 | `WAITING_EXTERNAL` | cooldown elapsed, no trigger | `QUEUED` recheck; clear `retryAt` | +1 | — | `PR_FIX_EXTERNAL_WAIT_COOLDOWN_MS` | Current `reactivateDueExternalWaits` (`:559`); **uncharged**. |
| 15 | `WAITING_EXTERNAL` | duplicate mark / late mark | no-op | — | — | — | Idempotent; cannot change generation (`:1610`). |
| 16 | `BLOCKED`/`human_decision` | any automatic evidence | stays `BLOCKED`; recorded; stale flag | — | — | — | Human hold; operator requeue/maintainer only. |
| 17 | **P** any active | maintainer hold set | stays; hold recorded | — | — | — | Explicit hold; evidence cannot override. |
| 18 | any active | PR merged/closed/archived | `STALE` | — | — | — | Terminal (`:2206`, `:2274`). |
| 19 | `STALE`/`IGNORED` | evidence | stays | — | — | — | Maintainer mark to `QUEUED` only (`requeue` rejects `STALE`, `:2434`). |
| 20 | any | operator requeue | `QUEUED` fresh attempt; budgets reset | +1 | reset | — | `requeuePrFixItem` (`:2419`). |
| 21 | any | maintainer mark `QUEUED` | `QUEUED` fresh attempt | +1 | +1 | — | `markPrFixItem` QUEUED path (`:1788`). |
| 22 | dispatched, unacked, stale | reclaim | `QUEUED` fresh generation | +1 | — | `PR_FIX_MAX_RECLAIMS` → `PARKED` | Hand-out never reached a worker (`#1211`). |
| 23 | dispatched, **acked**, stale | reclaim attempt | never reclaimed | — | — | — | Live owner's lease is protected (`:882`). |
| 24 | any | old-worker settle at stale generation | no-op (`skipped`) | — | — | — | Settlement token fencing (`:2657`, `:2666`). |

Row 12 vs row 14: a wait that ends because its dependency resolved is an
uncharged recheck (as today); a wait interrupted by *new feedback* opens a
charged attempt (row 13), consistent with `FIXED` reopening on new evidence.

## Recovery policy

### Event-driven

1. The configured forge capability delivers an observation (webhook or pull
   sync). Ingestion derives `(identity, version, contentSignature)` and
   populates `observedAt` from the forge payload (see
   [watermark lifetime](#evidence-watermark-lifetime)), and calls the enqueue
   path.
2. Enqueue is a **commit-time decision** pinned on the row's current
   `generation` and evidence watermark. It appends the observation, then
   re-derives the transition from the same snapshot the write is pinned on, so
   a concurrent append cannot be silently absorbed or clobbered (the `#1134`
   pinned loop, `src/lib/pr-fix-queue.ts:1276`).
3. The transition follows the state-transition table by hold class and remaining
   budget. Only `FIXED`, budget-available `PARKED`/`no_progress`, and structured
   `WAITING_EXTERNAL` are reactivatable by evidence; `BLOCKED`, fail-closed
   parks, budget-exhausted parks, and terminal states are not.

### Bounded periodic reconciliation (missed events)

Webhooks can be lost and a single sync tick can miss a head. A bounded periodic
pass re-derives each active item's watermark from authoritative reads through
the configured forge capability and applies the **same** transition rules. It
must be:

- **Bounded** per run (page/cap, like `reclaimStalePrFixHandouts`,
  `:813`), so a backlog never becomes a thundering herd;
- **Idempotent** — it re-computes `(identity, version)` and no-ops on anything
  already recorded;
- **Cooldown-guarded** — a reactivation sets `recoveryAppliedAt` so
  reconciliation cannot reopen the same item in a tight loop;
- **Audited** — every reactivation writes `PrFixHistory` with the actor
  (`reconciler`) and the evidence that justified it.

Cadence follows existing jobs (`pr-followup` 15 min, `reconcile` 30 min;
`src/lib/scheduler.ts`). This design adds no required interval; it requires that
whatever periodic pass exists applies the transition table rather than only
reaping closed PRs.

### Idempotency, cooldowns, budgets

- **Identity+version dedupe** makes replays and repeated reads no-ops.
- **Content signature** makes repeated review text no-ops.
- **`disposedEvidence` durable comparison** (plus `disposedAt` for
  timestamped kinds) makes cache eviction harmless (see
  [watermark lifetime](#evidence-watermark-lifetime)).
- **Cooldown** (`PR_FIX_RECOVERY_COOLDOWN_MS`, **Proposed**; default 6 h,
  matching the external-wait cooldown) paces evidence-driven reactivation of
  operational holds.
- **Budgets are unchanged.** `PR_FIX_MAX_ATTEMPTS` (fresh attempts) and
  `PR_FIX_MAX_RECLAIMS` (unacked hand-outs) continue to bound loops.
  Reactivation increments `fixAttempts`, so a park→reopen→park cycle terminates
  at the cap; a cap-exhausted park is not reactivated at all (row 9).
- **Generation bump** gives each reactivation a new `(id, generation)`, so
  already-consumed worker identities cannot suppress or double-run it.

### Audit trail

Every transition appends an immutable `PrFixHistory` row. **Proposed** fields
extend the current row (`prisma/schema.prisma:237`) with: from/to `status`,
`generation`, actor class (worker / operator / maintainer / reconciler), and the
triggering `(identity, version)`. Prior attempts and their reasons are
preserved; reactivation never erases the record of why the item was parked or
resolved. The stale-disposition flag (rows 9, 10, 16) is a **Proposed**
per-item field with an operator read path and a clearing rule (cleared on the
next reactivation or operator requeue).

### Operator controls

| Control | Effect |
|---------|--------|
| `POST /api/pr-fix-queue/requeue` | Release `BLOCKED`, `PARKED`, or `FIXED`; fresh generation; reset attempt and reclaim budgets. |
| Mark to `QUEUED` (maintainer tier) | Release a sticky settlement including `STALE`/`IGNORED`; fresh generation; +1 attempt. |
| `POST /api/pr-fix-queue/requeue` for `WAITING_EXTERNAL` (**Proposed**) | Explicitly end an external wait early; today `requeue` rejects it (`:2434`). |
| Maintainer hold (**Proposed**) | Explicit hold that evidence cannot override; cleared only by an operator. |
| `GET /api/audit` / `PrFixHistory` | Inspect why an item is held and what evidence has arrived since. |

## WAITING_EXTERNAL contract

`WAITING_EXTERNAL` must name a **concrete dependency**, not merely "we have not
pushed a patch." Today the status carries only a free-text note and a timer
(`markPrFixItem`, `src/lib/pr-fix-queue.ts:1609`); the note is not machine
checkable, so the queue cannot tell whether the dependency resolved.

A conforming wait records:

| Field | Meaning |
|-------|---------|
| `dependencyKind` | `upstream_pr` \| `upstream_issue` \| `ci_check` \| `external_service` |
| `dependencyRef` | Authoritative identity, e.g. `org/repo#123`, `check:<name>@<head>` |
| `observedEvidence` | What was observed that shows the dependency is not satisfied |
| `recoveryTrigger` | An event predicate (`upstream PR merged`, `check <name> concludes success on head <h>`) or a cooldown recheck predicate |
| `recheckAt` | Cooldown deadline for the bounded recheck (today `retryAt`) |

Rules:

- **Lack of a patch is not an external dependency.** A worker that simply has
  not produced a fix parks as `PARKED`/`no_progress`, not `WAITING_EXTERNAL`.
- **Proposed:** a *new* wait mark without a concrete
  `dependencyKind`/`dependencyRef` is invalid and is downgraded to a
  **fail-closed** park (`PARKED`, not reactivatable by evidence) with an audit
  note; it requires an operator to requeue. The downgrade is generation-pinned
  so it cannot clobber a newer attempt, and it is **prospective only** — legacy
  free-text waits are flagged for operator action, never auto-downgraded in
  bulk (issue non-goal: "no automatic bulk requeues").
- The wait is invalidated by (a) its `recoveryTrigger` firing, (b) fresh
  actionable feedback (new generation; dependency re-checked on run), or
  (c) `recheckAt` elapsing. Whichever is first.
- Duplicate or late marks for the same generation are idempotent and do not
  extend the cooldown.

## Ownership and fencing

- **Settlement authority is the attempt token.** A report settles exactly the
  `(id, generation)` it was issued; a stale generation, mismatched repo/PR, or
  already-settled status yields `action: "skipped"` with no mutation
  (`resolvePrFixFromAgentReport`, `:2604`; fences at `:2657`, `:2666`). An old
  worker can never settle newer feedback.
- **Commit-time pins.** Settlement, reclaim, and enqueue writes are
  generation-conditional and, where they touch the watermark, pinned on the
  exact snapshot they decided from, so a concurrent re-issue between read and
  write no-ops the loser. **Current exception:** the terminal reap in
  `reconcileStalePrFixItems` (`:2229`) and `reconcileArchivedRepoPrFixItems`
  (`:2292`) writes `STALE` by `id` only, with no generation/status predicate, so
  a concurrent requeue can be clobbered. **Proposed:** make the reaps
  generation-pinned, or scope this invariant to settlement/reclaim/enqueue
  writes and document the reap exception.
- **Hand-out ownership.** An acked attempt is never reclaimed, even when stale
  by wall-clock; reclamation targets only unacked stamped hand-outs and counts
  toward `PR_FIX_MAX_RECLAIMS` (`:813`–`:1065`). Reactivation must not clear a
  healthy owner's ack or duplicate an active hand-out.
- **Generation bump on every reactivation** is what makes old-worker settling
  safe: the consumed identity is no longer current.

## Unknown-evidence behavior

| Situation | Behavior |
|-----------|----------|
| Unparseable / unknown event kind | Do **not** advance the watermark; record an `unknown_evidence` audit entry; do **not** reopen (fail-closed against churn); bounded reconciliation re-reads authoritative state. |
| Missing head SHA on a check | Treat as actionable (conservative) but bounded by cooldown and attempt cap; re-fetch on the next pass. |
| Missing/unknown PR state | Defer; never reopen or reap into a fresh attempt (`report.unknownState`, `:892`). |
| Head fetch failure | Defer with an audit note; never silently absorb and never loop unbounded. |

The asymmetry is deliberate: absorbing real evidence is the bug this design
fixes, so unknown-but-plausibly-actionable evidence is conservatively
actionable; unknown-but-unverifiable evidence defers rather than fabricating a
transition.

## Negative controls (to specify before implementation)

These are the invariants implementation tests must pin:

1. **Duplicate webhook** with the same `(identity, version)` → no generation
   bump, no attempt increment, one history row per distinct observation.
2. **Replayed event** delivered out of order after a newer attempt → no-op; the
   newer attempt's state is untouched.
3. **Repeated review text** under a new review id and same `commit_id` → not
   fresh (content signature match); no reopen.
4. **Already-resolved comment** re-read by sync → not fresh.
5. **Transient `behind`** that clears before the next pass → never opens work.
6. **Budget-available `PARKED`** + fresh evidence → reopens, consumes an attempt;
   repeated cycles terminate at the cap in `PARKED`/`no_progress`.
7. **Cap-exhausted `PARKED`** + fresh evidence → no reopen, no attempt
   increment, no generation bump; stale flag set; operator requeue required.
8. **Evicted watermark key** re-read → not fresh: its `(identity, version)`
   equals `disposedEvidence`, or its forge-side `observedAt <= disposedAt`.
9. **Watermark reset** at a fresh attempt → the prior attempt's reason survives
   in history; no re-open of already-settled evidence.
   - **`FIXED` reopened at the attempt cap** → lands `PARKED`/`no_progress`
     **with** the stale-disposition flag (row 9), never a silent park.
10. **Old worker settle** at a superseded generation → `skipped`, no mutation.
11. **Reclaim vs ack race** — an ack landing in the read→write gap no-ops the
    reclaim; a healthy owner's lease is never cleared.
12. **Merged/closed/archived PR** → `STALE`; evidence never reactivates.
13. **Human hold / maintainer hold** — no amount of automatic evidence overrides
    `BLOCKED` or a hold; only an operator release does.
14. **Unknown evidence** — unparseable input neither absorbs nor loops; it
    defers and audits.
15. **Reconcile vs requeue** — a generation-pinned reap does not clobber a
    concurrent requeue (or the reap exception is explicitly accepted).
16. **Wait downgrade** — a new dependency-less wait parks fail-closed and is not
    evidence-reactivatable; a legacy wait is flagged, not bulk-downgraded.

## Worked examples

### 1. Feedback arrives during execution

Item is `QUEUED` and dispatched (generation `g`). A new `CHANGES_REQUESTED`
review lands before the worker reports. It is recorded in
`postDispatchEvidenceKeys` bound to `g`. When the worker reports `FIXED`/`no_changes_needed`,
settlement sees actionable post-dispatch evidence and reopens a fresh attempt
at `g+1` (`:1762`) instead of marking `FIXED`. Current behavior already matches
this case.

### 2. Feedback arrives after no-change

Worker reports `no_changes_needed`; item becomes `FIXED` at head `H`. Later a
review requests changes on head `H` (same head) or on a newer head. With new
actionable evidence, enqueue reopens a fresh attempt (`:1140`). With the same
evidence and an unchanged head, the `#940` path reopens (`:1136`) because the
FIXED tombstone is untrusted. **Gap:** if the new feedback is repeated text
under a new review id, today it reopens; the design suppresses it via content
signature.

### 3. Feedback arrives during an external wait

Item is `WAITING_EXTERNAL` on `org/repo#123` with `retryAt = +6h`. A
`CHANGES_REQUESTED` review lands at +1h. **Current:** the item stays
`WAITING_EXTERNAL` until the cooldown (sticky at `:1116`), so the new feedback
is stranded. **Proposed:** fresh actionable feedback opens a fresh generation
immediately (row 13); the worker re-checks the dependency and, if it is still
unsatisfied, re-parks with a refreshed `recheckAt`. Alternatively, if the
recorded `recoveryTrigger` fires (e.g. upstream merged), the wait is invalidated
without waiting for the cooldown (row 12).

### 4. Feedback arrives while operationally parked

Two sub-cases:

- **Budget available** (e.g. a bare `blocked` report parked without exhausting
  the cap): after `PR_FIX_RECOVERY_COOLDOWN_MS`, fresh actionable evidence opens
  a fresh attempt (row 8); the attempt cap bounds the loop.
- **Budget exhausted** (the common `no_progress` park, created by the cap):
  fresh evidence does **not** auto-reopen (row 9). The item is flagged
  stale-disposition and an operator requeue (which resets budgets) is the
  recovery. This is deliberate: the loop is already bounded, so auto-reopening
  would only re-park or livelock. `PARKED`/`infra_failure` and
  `PARKED`/`security_failure` are not reactivated by PR feedback either — they
  need a recovery trigger or an operator, preserving fail-closed behavior.

### 5. Feedback arrives after an explicit human hold

Item is `BLOCKED`/`human_decision` on an unresolved scope question. A review
comments again. **Current and design:** the item stays `BLOCKED`; the evidence
is recorded and flagged as a stale disposition for operator visibility. Only
`POST /api/pr-fix-queue/requeue` (or a maintainer mark to `QUEUED`) releases it.
New evidence must never silently override a maintainer hold, authorization
boundary, dependency block, or unresolved scope decision.

### 6. Feedback arrives after merge/close

The PR merged. Reconcile marks the item `STALE` (`:2206`). A late webhook then
arrives. **Current and design:** no reopen; terminal states are inert. The late
observation is recorded for audit only.

## Current behavior vs gaps

| Requirement | Current behavior | Gap |
|-------------|------------------|-----|
| Fresh evidence by authoritative identity | `evidenceKeys` dedupe by identity only (`:297`); `postDispatchEvidenceKeys` for the FIXED-settle path (`:1190`) | No version/content-signature model; new id ⇒ fresh even for repeated text. |
| Already-resolved comments excluded | No resolution/outdated state is read (`src/lib/github-prs.ts`) | **Gap:** needs a new forge read capability. |
| Watermark sound under bounds | 40-entry FIFO + 20-entry priority caches; per-attempt reset (`:1238`) | No disposition timestamp; evicted keys can read as fresh. |
| Reactivate operational parking | `PARKED` and `WAITING_EXTERNAL` are sticky to enqueue (`:1116`) | Fresh evidence does not reactivate budget-available `no_progress`; cap-exhausted parks need an explicit operator path + stale flag. |
| WAITING_EXTERNAL concrete dependency | Free-text note + timer only (`:1609`, `:559`) | No machine-checkable dependency/evidence/recovery trigger; "no patch" can masquerade as an external wait. |
| Event-driven invalidation of a wait | Cooldown only | No recovery-trigger or fresh-feedback invalidation. |
| Preserve human decisions | `BLOCKED` sticky; worker settlements pinned (`:1624`) | No explicit maintainer hold distinct from `BLOCKED`; no stale-disposition flag when evidence arrives. |
| Settlement fencing | Attempt token + generation pins + ack/reclaim (`:2604`, `:813`) | Reap writes are not generation-conditional (`:2229`, `:2292`). |
| Bounded periodic reconciliation | `pr-followup` sync + `reconcile` reap closed/archived | Reconciliation reaps terminal PRs but does not apply the freshness transition table to active items. |
| Unknown evidence | Split: unknown event kinds non-actionable; unknown head actionable (`:388`) | No single documented policy; no audit entry. |

## Implementation outline (for the follow-up, not this issue)

1. Extend the evidence record with `(version, contentSignature, observedAt)`,
   where `observedAt` is the forge-side event timestamp; add
   `disposedAt`/`recoveryAppliedAt`/`disposedEvidence` to `PrFixQueueItem`; keep
   `evidenceKeys` for backward compatibility.
2. Add a disposition/hold classifier (including cap-exhausted vs budget-available)
   and a single `evaluateRecovery(watermark, observation)` used by both the
   event-driven enqueue path and the periodic reconciliation pass.
3. Add structured `WAITING_EXTERNAL` fields; downgrade **new** dependency-less
   waits to a fail-closed park; flag legacy waits for operators.
4. Add `PR_FIX_RECOVERY_COOLDOWN_MS` (default 6 h) and a stale-disposition flag.
5. Extend `PrFixHistory` with from/to `status`, `generation`, actor class, and
   `(identity, version)`; extend `PrFixOutcome`/`VALID_PR_FIX_OUTCOMES`
   (`src/types/index.ts:264`) if `external_wait` is promoted to a stored
   outcome, or keep it status-implied.
6. Make the terminal reap writes generation-pinned (or document the exception).
7. Add the negative-control tests above.

## Open questions

- Should `infra_failure` auto-recover from a health signal, or always require an
  operator? (Design proposes: explicit recovery trigger or operator.)
- Should a maintainer hold be a new `status`/`outcome` value or an orthogonal
  column? (Design proposes orthogonal, to avoid overloading `status` further.)
- Content-signature normalization rules (whitespace, quotes, code fences) need a
  bounded, documented definition before implementation.
- Whether `external_wait` becomes a stored `PrFixOutcome` or remains
  status-implied.

## Related

- [PR-fix outcome policy](pr-fix-outcome-policy.md) — `BLOCKED` vs `PARKED`,
  budgets, operator recovery.
- [PR review-fix queue](pr-review-fix-queue.md) — queue model, generation
  identity, attempt-token settlement, hand-out acknowledgement/reclamation.
- [Worker execution contract](worker-execution-contract.md) — worker-side
  settlement and completion gates.
