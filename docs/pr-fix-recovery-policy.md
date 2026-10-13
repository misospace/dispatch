# PR-fix recovery on fresh evidence

> **Issue:** [misospace/dispatch#1244](https://github.com/misospace/dispatch/issues/1244)
>
> **Status: design only.** This document specifies behavior; it does not
> implement it. No schema, route, budget, credential, or deployment change is
> authorized by this design alone. See [Non-goals](#non-goals).

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
- No change to `PR_FIX_MAX_ATTEMPTS`, `PR_FIX_MAX_RECLAIMS`, or
  `PR_FIX_EXTERNAL_WAIT_COOLDOWN_MS` defaults.

## Vocabulary

| Term | Meaning |
|------|---------|
| **Evidence identity** | The stable key of an observation, e.g. `review:<repo>#<pr>:<reviewId>`. Replayed webhooks of the same observation share it. Current format: `computeEvidenceKey` in `src/lib/pr-followup-ingestion.ts:255`. |
| **Evidence version** | The state-bearing fields of an identity (head SHA, review state/`commit_id`, comment resolution/`updated_at`, check `status`/`conclusion`). A new *version* of a known identity is only fresh if its transition is actionable. |
| **Evidence watermark** | The set of `(identity, version)` pairs recorded at the moment an attempt's disposition was written, plus the head SHA observed then. Fresh evidence is measured against this watermark. |
| **Attempt** | One dispatchable unit of PR-fix work, identified by `(id, generation)`. |
| **Disposition** | The reason an item is not actively dispatchable: `human_decision`, `no_progress`, `infra_failure`, `security_failure`, or `external_wait`. Distinct from `status` (see below). |
| **Hold class** | The recovery semantics of a disposition: `operational`, `human`/maintainer, or `terminal`. Recovery keys off hold class, not status alone. |
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
| `review_comment` | comment id | `commit_id`, `updated_at`, `position`, `resolved`/outdated | unresolved comment on the current or a newer head |
| `comment` | comment id | `updated_at`, author association | non-bot comment on the PR |
| `check_run` | check run id | `head_sha`, `status`, `conclusion` | `failure`/`timed_out`/`action_required`/`cancelled` on the current or a newer head |
| `merge_state` | derived from the state string | the state string + head | a **persistent** problematic state (`behind`, `dirty`, `unstable`, `has_hooks`) |
| `merge_conflict` | derived (`conflicting`) | `mergeable` | `CONFLICTING` persists |

Two rules make this "fresh" rather than merely "seen":

1. **Identity is stable across replays.** A duplicated webhook, a re-read by the
   periodic sync, or an at-least-once redelivery has the same identity and must
   be a no-op. The current `evidenceKeys` dedupe (`uniqueAppend`,
   `src/lib/pr-fix-queue.ts:297`) already gives this for identity; this design
   extends it with version.
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

## Disposition model: status, disposition, hold class

Today `status` overloads three meanings. The design separates them.

| `status` | `disposition` | `hold class` | Recovery owner |
|----------|---------------|--------------|----------------|
| `QUEUED` | — | none | normal dispatch |
| `FIXED` | — (resolved tombstone) | none | fresh evidence / #940 / operator |
| `BLOCKED` | `human_decision` | **human** | operator/maintainer only |
| `PARKED` | `no_progress` | **operational** | fresh evidence after cooldown, bounded |
| `PARKED` | `infra_failure` | **operational (fail-closed)** | explicit recovery trigger or operator |
| `PARKED` | `security_failure` | **operational (fail-closed)** | operator only |
| `WAITING_EXTERNAL` | `external_wait` | **operational** | recovery trigger, fresh feedback, or cooldown |
| `STALE` | — | **terminal** | operator requeue only |
| `IGNORED` | — | **terminal** | operator requeue only |

Two hard separations the design enforces:

- **Operational parking ≠ human decision.** `PARKED` never carries the
  `needs-human` label; only `BLOCKED`/`human_decision` does
  (`docs/pr-fix-outcome-policy.md`). Evidence may reactivate *operational*
  holds; it must never auto-override a human decision.
- **Terminal ≠ recoverable.** A merged, closed, or archived PR is `STALE` and
  is never reactivated by evidence (`reconcileStalePrFixItems`,
  `reconcileArchivedRepoPrFixItems`, `src/lib/pr-fix-queue.ts:2206`,
  `:2274`).

## Fresh actionable evidence

Let `W` be the item's evidence watermark and `H_snapshot` the head recorded when
the current disposition was written. An observation `o = (identity, version)` is
**fresh actionable evidence** iff all hold:

1. `o.identity` is actionable by kind (table above) and is not in a
   terminal/resolved state (review no longer `CHANGES_REQUESTED`, comment
   resolved/outdated, condition cleared);
2. `(o.identity, o.version)` is not already in `W` (dedupe by identity **and**
   version, not identity alone);
3. `o.contentSignature` is not already in `W` at the same or newer head
   (anti-repetition);
4. `o` was observed **after** `W` was written (postdates the disposition), and
   `o` is not a replay of an event that predates it.

**Unknown evidence** is handled separately (see
[Unknown-evidence behavior](#unknown-evidence-behavior)); it never silently
satisfies or violates these predicates.

## State-transition table

Triggers are evaluated against the item's watermark. `gen` = generation change;
`att` = `fixAttempts` change.

| # | Current | Trigger | Result | gen | att | Budget / cooldown | Notes |
|---|---------|---------|--------|-----|-----|-------------------|-------|
| 1 | `QUEUED` (not dispatched) | new actionable evidence | stays `QUEUED`; version appended to `W` | — | — | — | Same attempt; inline comments of one review never count (`#1103`). |
| 2 | `QUEUED` (dispatched) | new actionable evidence | stays `QUEUED`; recorded in `postDispatchEvidenceKeys` | — | — | — | In-flight worker cannot see it; settlement must reopen (`#1119`). |
| 3 | `QUEUED` | duplicate / replayed event | no-op | — | — | — | Identity+version already in `W`. |
| 4 | `QUEUED` | non-actionable/cleared condition | no-op; recorded for audit | — | — | — | Transient `behind`, resolved comment, dismissed review. |
| 5 | `FIXED` | fresh actionable evidence | `QUEUED` fresh attempt | +1 | +1 | `PR_FIX_MAX_ATTEMPTS` → `PARKED` | Current: `enqueue` reopen or post-dispatch reopen (`src/lib/pr-fix-queue.ts:1136`, `:1762`). |
| 6 | `FIXED` | known evidence, head unchanged | `QUEUED` fresh attempt | +1 | +1 | cap → `PARKED` | `#940` no-progress recovery; FIXED tombstone is untrusted. |
| 7 | `FIXED` | duplicate/repeated text | no-op | — | — | — | Anti-churn (`#25`). |
| 8 | `PARKED`/`no_progress` | fresh actionable evidence, cooldown elapsed | `QUEUED` fresh attempt | +1 | +1 | `PR_FIX_MAX_ATTEMPTS`, new `PR_FIX_RECOVERY_COOLDOWN_MS` | **Gap today:** `PARKED` is sticky to enqueue (`:1116`). |
| 9 | `PARKED`/`infra_failure` | PR feedback | stays `PARKED`; recorded; stale-disposition flag | — | — | — | Infra recovery is not PR evidence; needs health signal/operator. |
| 10 | `PARKED`/`security_failure` | PR feedback | stays `PARKED`; recorded | — | — | — | Operator only (fail-closed). |
| 11 | `WAITING_EXTERNAL` | recorded recovery trigger fires | `QUEUED` recheck | +1 | +1 | — | **Gap today:** only cooldown fires (`reactivateDueExternalWaits`, `:559`). |
| 12 | `WAITING_EXTERNAL` | fresh actionable feedback | `QUEUED` fresh attempt; dependency re-checked on run | +1 | +1 | cap | Evidence is new work independent of the dependency. |
| 13 | `WAITING_EXTERNAL` | cooldown elapsed, no trigger | `QUEUED` recheck | +1 | +1 | `PR_FIX_EXTERNAL_WAIT_COOLDOWN_MS` | Existing bounded recheck. |
| 14 | `WAITING_EXTERNAL` | duplicate mark / late mark | no-op | — | — | — | Idempotent, cannot change generation (`:1610`). |
| 15 | `BLOCKED`/`human_decision` | any automatic evidence | stays `BLOCKED`; recorded; stale-disposition flag | — | — | — | Human hold; operator requeue/maintainer only. |
| 16 | any active | maintainer hold set | stays; hold recorded | — | — | — | Explicit hold; evidence cannot override. |
| 17 | any active | PR merged/closed/archived | `STALE` | — | — | — | Terminal (`:2206`, `:2274`). |
| 18 | `STALE`/`IGNORED` | evidence | stays | — | — | — | Operator requeue only. |
| 19 | any | operator requeue | `QUEUED` fresh attempt; budgets reset | +1 | reset | — | `requeuePrFixItem` (`:2419`). |
| 20 | any | maintainer mark `QUEUED` | `QUEUED` fresh attempt | +1 | +1 | — | `markPrFixItem` QUEUED path (`:1788`). |
| 21 | dispatched, unacked, stale | reclaim | `QUEUED` fresh generation | +1 | — | `PR_FIX_MAX_RECLAIMS` → `PARKED` | Hand-out never reached a worker (`#1211`). |
| 22 | dispatched, **acked**, stale | reclaim attempt | never reclaimed | — | — | — | Live owner's lease is protected (`:882`). |
| 23 | any | old-worker settle at stale generation | no-op (`skipped`) | — | — | — | Settlement token fencing (`:2666`). |

## Recovery policy

### Event-driven

1. The configured forge capability delivers an observation (webhook or pull
   sync). Ingestion computes `(identity, version, contentSignature)` and calls
   the enqueue path.
2. Enqueue is a **commit-time decision** pinned on the row's current
   `generation` and evidence watermark. It appends the observation, then
   re-derives the transition from the same snapshot the write is pinned on, so
   a concurrent append cannot be silently absorbed or clobbered (the `#1134`
   pinned loop, `src/lib/pr-fix-queue.ts:1276`).
3. The transition follows the state-transition table by hold class. Only
   `FIXED`, `PARKED`/`no_progress`, and `WAITING_EXTERNAL` are reactivatable by
   evidence; `BLOCKED`, `PARKED`/`infra_failure`, `PARKED`/`security_failure`,
   and terminal states are not.

### Bounded periodic reconciliation (missed events)

Webhooks can be lost and a single sync tick can miss a head. A bounded periodic
pass re-derives each active item's watermark from authoritative reads through
the configured forge capability and applies the **same** transition rules. It
must be:

- **Bounded** per run (page/cap, like `reclaimStalePrFixHandouts`,
  `:813`), so a backlog never becomes a thundering herd;
- **Idempotent** — it re-computes `(identity, version)` and no-ops on anything
  already in the watermark;
- **Cooldown-guarded** — a reactivation sets a cooldown so reconciliation cannot
  reopen the same item in a tight loop;
- **Audited** — every reactivation writes `PrFixHistory` with the actor
  (`reconciler`) and the evidence that justified it.

Cadence follows existing jobs (`pr-followup` 15 min, `reconcile` 30 min;
`src/lib/scheduler.ts`). This design does not add a new required interval; it
requires that whatever periodic pass exists applies the transition table rather
than only reaping closed PRs.

### Idempotency, cooldowns, budgets

- **Identity+version dedupe** makes replays and repeated reads no-ops.
- **Content signature** makes repeated review text no-ops.
- **Cooldown** (`PR_FIX_RECOVERY_COOLDOWN_MS`, proposed; default 6 h, matching
  the external-wait cooldown) bounds evidence-driven reactivation of operational
  holds.
- **Budgets** are unchanged and continue to bound loops: `PR_FIX_MAX_ATTEMPTS`
  (fresh attempts), `PR_FIX_MAX_RECLAIMS` (unacked hand-outs). Reactivation past
  the attempt cap parks as `no_progress`, never `BLOCKED`.
- **Generation bump** gives each reactivation a new `(id, generation)`, so
  already-consumed worker identities cannot suppress or double-run it.

### Audit trail

Every transition appends an immutable `PrFixHistory` row carrying: `action`,
from/to `status`, `lane`, `outcome`, the triggering `(identity, version)`,
`generation`, actor class (worker / operator / maintainer / reconciler), and a
reason. Prior attempts and their reasons are preserved; reactivation never
erases the record of why the item was parked or resolved.

### Operator controls

| Control | Effect |
|---------|--------|
| `POST /api/pr-fix-queue/requeue` | Release any hold (`BLOCKED`, `PARKED`, `FIXED`); fresh generation; reset attempt and reclaim budgets. |
| Mark to `QUEUED` (maintainer tier) | Release a sticky settlement; fresh generation; +1 attempt. |
| Maintainer hold (proposed) | Explicit hold that evidence cannot override; cleared only by an operator. |
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
| `recheckAt` | Cooldown deadline for the bounded recheck |

Rules:

- **Lack of a patch is not an external dependency.** A worker that simply has
  not produced a fix parks as `PARKED`/`no_progress`, not `WAITING_EXTERNAL`.
- A wait with no concrete `dependencyKind`/`dependencyRef` is invalid and must
  be downgraded to `PARKED`/`no_progress` (audited), not silently accepted.
- The wait is invalidated by (a) its `recoveryTrigger` firing, (b) fresh
  actionable feedback (new generation; dependency re-checked on run), or
  (c) `recheckAt` elapsing. Whichever is first.
- Duplicate or late marks for the same generation are idempotent and do not
  extend the cooldown.

## Ownership and fencing

- **Settlement authority is the attempt token.** A report settles exactly the
  `(id, generation)` it was issued; a stale generation, mismatched repo/PR, or
  already-settled status yields `action: "skipped"` with no mutation
  (`resolvePrFixFromAgentReport`, `:2641`). An old worker can never settle
  newer feedback.
- **Commit-time pins.** Every status write is generation-conditional and, where
  it touches the watermark, pinned on the exact snapshot it decided from, so a
  concurrent re-issue between read and write no-ops the loser.
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
| Missing/unknown PR state | Defer; never reopen or reap into a fresh attempt (`unknownState`, `:898`). |
| Head fetch failure | Defer with an audit note; never silently absorb and never loop unbounded. |

The asymmetry is deliberate: absorbing real evidence is the bug this design
fixes, so unknown-but-plausibly-actionable evidence is conservatively
actionable; unknown-but-unverifiable evidence defers rather than fabricating a
transition.

## Negative controls (to specify before implementation)

These are the invariants implementation tests must pin:

1. **Duplicate webhook** with the same `(identity, version)` → no generation
   bump, no attempt increment, single history row per distinct observation.
2. **Replayed event** delivered out of order after a newer attempt → no-op; the
   newer attempt's state is untouched.
3. **Repeated review text** under a new review id and same `commit_id` → not
   fresh (content signature match); no reopen.
4. **Already-resolved comment** re-read by sync → not fresh.
5. **Transient `behind`** that clears before the next pass → never opens work.
6. **Retry loop** — evidence-driven reactivation is bounded by
   `PR_FIX_MAX_ATTEMPTS` and `PR_FIX_RECOVERY_COOLDOWN_MS`; it terminates in
   `PARKED`/`no_progress`, never an infinite reopen.
7. **Old worker settle** at a superseded generation → `skipped`, no mutation.
8. **Reclaim vs ack race** — an ack landing in the read→write gap no-ops the
   reclaim; a healthy owner's lease is never cleared.
9. **Merged/closed/archived PR** → `STALE`; evidence never reactivates.
10. **Human hold** — no amount of automatic evidence overrides `BLOCKED` or a
    maintainer hold; only an operator release does.
11. **Unknown evidence** — unparseable input neither absorbs nor loops; it
    defers and audits.

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
actionable evidence, enqueue reopens a fresh attempt (`:1136`). With the same
evidence and an unchanged head, the `#940` path reopens because the FIXED
tombstone is untrusted. **Gap:** if the new feedback is repeated text under a
new review id, today it reopens; the design suppresses it via content signature.

### 3. Feedback arrives during an external wait

Item is `WAITING_EXTERNAL` on `org/repo#123` with `recheckAt = +6h`. A
`CHANGES_REQUESTED` review lands at +1h. **Current:** the item stays
`WAITING_EXTERNAL` until the cooldown (sticky at `:1116`), so the new feedback
is stranded. **Design:** fresh actionable feedback opens a fresh generation
immediately; the worker re-checks the dependency and, if it is still
unsatisfied, re-parks with a refreshed `recheckAt`. Alternatively, if the
recorded `recoveryTrigger` fires (e.g. upstream merged), the wait is invalidated
without waiting for the cooldown.

### 4. Feedback arrives while operationally parked

Item is `PARKED`/`no_progress` after exhausting attempts. A new review requests
changes. **Current:** sticky; stranded until an operator requeues. **Design:**
after `PR_FIX_RECOVERY_COOLDOWN_MS`, fresh actionable evidence opens a fresh
attempt; the attempt cap still bounds the loop. `PARKED`/`infra_failure` and
`PARKED`/`security_failure` are **not** reactivated by PR feedback — they need a
recovery trigger or an operator, preserving fail-closed behavior.

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
| Fresh evidence by authoritative identity | `evidenceKeys` dedupe by identity only (`:297`); `postDispatchEvidenceKeys` for the FIXED-settle path (`:1190`) | No version/content-signature model; new id ⇒ fresh even for repeated text; resolved comments still count. |
| Reactivate operational parking | `PARKED` and `WAITING_EXTERNAL` are sticky to enqueue (`:1116`); only operator requeue releases | Fresh evidence does not reactivate `no_progress` parking. |
| WAITING_EXTERNAL concrete dependency | Free-text note + timer only (`:1609`, `:559`) | No machine-checkable dependency/evidence/recovery trigger; "no patch" can masquerade as an external wait. |
| Event-driven invalidation of a wait | Cooldown only | No recovery-trigger or fresh-feedback invalidation. |
| Preserve human decisions | `BLOCKED` sticky; worker settlements pinned (`:1624`) | No explicit maintainer hold distinct from `BLOCKED`; no stale-disposition flag when evidence arrives. |
| Settlement fencing | Attempt token + generation pins + ack/reclaim (`:2641`, `:813`) | Already strong; design keeps it as the ownership invariant. |
| Bounded periodic reconciliation | `pr-followup` sync + `reconcile` reap closed/archived | Reconciliation reaps terminal PRs but does not apply the freshness transition table to active items. |
| Unknown evidence | Split: unknown event kinds non-actionable; unknown head actionable (`:388`) | No single documented policy; no audit entry. |

## Implementation outline (for the follow-up, not this issue)

1. Extend the evidence record with `(version, contentSignature, observedAt)` and
   a per-attempt watermark; keep `evidenceKeys` for backward compatibility.
2. Add a disposition/hold classifier and a single `evaluateRecovery(watermark,
   observation)` function used by both the event-driven enqueue path and the
   periodic reconciliation pass.
3. Add structured `WAITING_EXTERNAL` fields and downgrade waits without a
   concrete dependency to `PARKED`/`no_progress`.
4. Add `PR_FIX_RECOVERY_COOLDOWN_MS` (default 6 h, accepted range matching the
   external-wait cooldown) and a stale-disposition flag on `BLOCKED`.
5. Add the negative-control tests above.

## Open questions

- Should `infra_failure` auto-recover from a health signal, or always require an
  operator? (Design proposes: explicit recovery trigger or operator.)
- Should a maintainer hold be a new `status`/`outcome` value or an orthogonal
  column? (Design proposes orthogonal, to avoid overloading `status` further.)
- Content-signature normalization rules (whitespace, quotes, code fences) need
  a bounded, documented definition before implementation.

## Related

- [PR-fix outcome policy](pr-fix-outcome-policy.md) — `BLOCKED` vs `PARKED`,
  budgets, operator recovery.
- [PR review-fix queue](pr-review-fix-queue.md) — queue model, generation
  identity, attempt-token settlement, hand-out acknowledgement/reclamation.
- [Worker execution contract](worker-execution-contract.md) — worker-side
  settlement and completion gates.
