# Work-item attempt chain (#1183)

`GET /api/issues/[issueId]/lifecycle` answers what happened to a work item.
The attempt chain, additive to that same response, answers a different
question: *who executed it, how many times, and how did each execution end*.
It exists because the timeline's claim milestones cannot tell a first attempt
from a third, an execution from the admission that preceded it, or a PR-fix
round from the issue work that preceded it.

The chain is built by `buildWorkItemDeliveryChain` in
`src/lib/work-attempt-chain.ts` — a pure, order-invariant projection with no
Prisma, no I/O, and no clock reads, in the same style as
`issue-lifecycle-read.ts`. It consumes three bounded plain-data feeds for ONE
work item:

- the `IssueLifecycleEvent` rows the timeline already reads (same shape the
  GET route builds),
- the `AgentRun` rows attached to the issue **or** durably associated to one
  of its PR-fix items' fix rounds (capped at 500, oldest first) — a
  `followup-pr` run may carry no `issueId`; its `prFixQueueItemId` stamp is
  what pulls its evidence into this item's chain,
- the `PrFixQueueItem` rows matching the item's exact (repo, issue)
  coordinates — the filter is bounded to the linked PRs (one row per PR),
  each with its history capped at the OLDEST 100 entries per item (asc
  order; the read takes one extra row to detect truncation).

The response carries the chain as an **additive top-level `attempts` key**
plus an `attemptsTruncated` flag when the run read hit its cap and a
`prFixEventsTruncated` flag when any item's history read hit its cap. No
existing response field changes shape.

## Stable identity

Everything hangs off identity that survives retries and replays:

- **Work item** = `repoFullName` + `issueNumber` (GitHub remains the source
  of truth; Dispatch's database is a cache).
- **Execution attempts** = `exec-<hash12>`, where `hash12` is the first 12
  hex characters of a sha256 over the claim event's **canonical dedupe
  identity** — the exact key the projection's dedupe uses: `kind`,
  `fromStatus`, `toStatus`, `occurredAtMs`, `agentName` (joined with a
  NUL separator; a `pr_merged` observation adds its resolved PR number as a
  sixth element, and only a `claim` anchors an attempt). `source` and
  `actor` are deliberately NOT part of the
  identity: the same transition observed by two writers (the documented
  api-vs-webhook double-record) is ONE fact, and either writer may be the
  only one recorded so far. The id is therefore content-derived, not
  positional, and stable in both directions: a backfilled claim that arrives
  EARLIER than already-projected claims adds a new attempt without renaming
  any existing one, and a later duplicate observation of an existing claim
  (different `source`/`actor`, same fact) collapses into the existing
  attempt without renaming it. The join is exactly as discriminating as the
  dedupe key, so two claim rows that survive dedupe can never share an
  attempt id. Every observed `claim` event anchors one attempt.
- **Fix rounds** = `fix-<itemId>-g<generation>`, exactly one per generation
  `1..item.generation` on the PR-fix queue item (#1044's work identity). The
  id keys off the item id — unique even when two queue items share the same
  repo#pr. `fixAttempts` is a worker-execution count (#1103), not a work
  identity, and never fabricates extra rounds. Each fix-round attempt
  carries `prFix: { itemId, repo, pr, type }` identifying the queue item,
  the PR the round was about, and the item's CURRENT queue type
  (`MERGE_CONFLICT` / `CI_FAILURE` / `REVIEW_FEEDBACK` / `OTHER` — mutable
  across rounds, so it is item context, not per-round truth; per-round
  triggering evidence is distinct in `prFixEvents`). Execution attempts
  carry `prFix: null`. A round's worker-execution evidence (agent, timing,
  artifacts, metadata) comes ONLY from runs carrying the durable run→round
  association for that exact (item, generation) — see "Fix rounds link their
  worker runs" below.
- **Artifacts** = the `AgentRun` ids whose intervals overlap the attempt
  window **and whose agent identity does not contradict the claim's** (see
  "Run attribution is agent-aware"), plus the PR numbers of `pr_merged`
  lifecycle events whose occurrence falls in that window. Merge evidence
  stays lifecycle-owned: it is never derived from a run record or a worker
  report.

## Contract fields

Each `attempts.attempts[]` entry carries:

| Field | Meaning |
|---|---|
| `attemptId` | Stable id as above. |
| `kind` | `"execution"` or `"fix-round"`. |
| `agentName` | From the claim / closing event or the matched run; `null` when unknown. Fix rounds carry the single known agent shared by ALL of the round's associated runs; a mixed set is `null` rather than a picked representative — the PR-fix history stream itself carries no agent attribution. |
| `claimedAt` | `{ at, provenance }` from the claim event: `observed` when at least one observation of the claim was recorded live, `backfilled` when every observation of it is a backfill (see "Dedupe guarantees"). Null means unknown — **never** inferred from the issue's creation time or from run timestamps. |
| `startedAt` / `endedAt` | Only from `AgentRun` intervals (`startedAt` / `finishedAt`): for execution attempts when a run's interval lies within/overlaps the attempt window **and is attributable to the attempt** (see "Run attribution is agent-aware"); for fix rounds from the runs carrying that round's durable association (see "Fix rounds link their worker runs"). Null otherwise. Claim/admission time and actual execution time are different facts and stay distinct: `claimedAt` is admission, these are execution. |
| `reportedAt` | `occurredAt` of the closing lifecycle event (`attempt_failed` / `completed` / `claim_released`) that ends the attempt; null when open. |
| `outcome` | See below. Every attempt is preserved with its outcome. |
| `classification` | `"active-execution"` when an attributable run interval overlaps the attempt window (execution) or a run carries the round's durable association (fix round); `"waiting-review"` when a `claim_released` deliberately retained `status/in-review`; `"unclassified"` otherwise. Conservative by design: queued, waiting-CI, and merge-adjacent states stay unclassified unless explicit evidence says otherwise. |
| `executionMetadata` | `{ workerProduct, model, reasoningEffort, runtimeRevision, cohortLabel }` normalized from the matched runs' stored execution metadata (keys `worker`, `model`, `reasoningEffort`, `runtimeRevision`, `cohortLabel`). Unknown/missing stays null and is never inferred from timestamps or deployment data. Multiple matched runs union first-non-null-per-field in run order. |
| `artifacts` | `agentRunIds` + `pullRequestNumbers` as above. |
| `prFix` | `{ itemId, repo, pr, type }` for fix-round attempts (the PR-fix queue item the round belongs to and its current queue type), `null` for execution attempts. |
| `wallTimeMs` | The **union** (not the sum) of the attempt's overlapping run intervals; null with no run evidence. |

Top level: `totalExecutionWallTimeMs` unions ALL execution-interval evidence
across attempts and fix rounds, so overlapping intervals across attempts are
never double-counted; `notes` carries deduplicated notes for skipped or
unparseable rows and ambiguities (e.g. "attempt closed by a newer claim
without a release").

### wallTimeMs is attribution, not a partition

Per-attempt `wallTimeMs` attributes run intervals to attempts; it does not
partition a total. An attributable run that spans a claim boundary appears
in BOTH neighboring attempts with its full interval, so per-attempt values
may overlap each other and `startedAt` can predate `claimedAt`. An event or
run exactly at a shared boundary may attribute to both neighboring attempts.
The only deduplicated quantity is the top-level `totalExecutionWallTimeMs` —
never sum the per-attempt values.

### Run attribution is agent-aware

A run is attributable to an attempt when its interval overlaps the attempt
window AND the identities do not contradict each other (#1183 review):

| Claim agent | Run agent | Attribution |
|---|---|---|
| known | same known agent | yes, by time overlap |
| known | **different known agent** | **never** — not even when the interval crosses the claim boundary |
| known | unknown (`null`) | yes, by time overlap (identity cannot be discriminated) |
| unknown (`null`) | any | yes, by time overlap |

Without this rule, two concurrent workers on one issue cross-attribute:
alpha claims 10:00 with `run-alpha` 10:05–11:30, beta claims 11:00 (alpha
superseded) with `run-beta` 11:05–11:45 — beta's unbounded window overlaps
`run-alpha`, so a time-only match would give beta alpha's run id, alpha's
`executionMetadata`, a `startedAt` predating beta's claim, and alpha's wall
time. With the rule each attempt carries only its own worker's evidence.
The top-level `totalExecutionWallTimeMs` is unchanged by this rule: it
remains the item-wide union of **every** run interval, so no execution time
is lost — only misattribution is prevented.

## Fix rounds link their worker runs (durable association)

The reviewer blocker (#1183 re-review at `aeb2774`): fix rounds must not be
synthesized shells always carrying `artifacts.agentRunIds: []` — the worker
execution that actually implemented a generation must be durably linked to
it, **never guessed from timestamps**.

The link is a persisted pair on `AgentRun`:

- `prFixQueueItemId` + `prFixGeneration` (nullable; FK `SET NULL` on item
  deletion, so a pruned queue row never erases run evidence).

Writer boundary (`POST /api/agents/[agentName]/tasks/report`): a
`followup-pr` report echoing the `prFixItem { id, generation }` token that
next-task issued gets the pair stamped **only after it is verified against
real queue state**. Outcomes that did not implement the round never stamp:
`handed-off` returns the task to independent sync, and
`capacity-exhausted` releases the SAME generation for a fresh worker with no
progress — stamping either would render a round that is still awaiting real
work as executed.

| Check | Fail-closed result |
|---|---|
| The item id exists | no stamp |
| The item's queue-normalized repo/PR (`normalizeQueueRepo`, #1145) match the report's coordinates | no stamp |
| The claimed generation is within `1..item.generation` (a superseded generation still names a round that really ran; a future one is a forged identity) | no stamp |

Stamp authority is identity agreement with the queue, deliberately separate
from **settlement** authority: settling the item still requires the issued
hand-out token inside `resolvePrFixFromAgentReport`. The stamp records which
round the execution claims to have implemented; it never mutates the queue.
Reports without a verified identity (issue work, legacy token-less reports,
`already_done` closes, hand-offs) leave the pair null.

Projection rules:

- A run with the pair lands in exactly one round: `fix-<prFixQueueItemId>
  -g<prFixGeneration>`, and only if that round exists (`generation ≤
  item.generation`). Rounds never absorb a run by time proximity.
- A stamped run is **excluded from the execution-attempt time join**: it is
  fix-round evidence, and a PR-fix execution crossing a claim's window must
  never be read as that claim's issue work (cross-product / cross-worker
  leakage guard).
- A stamped run whose generation is missing or unusable attaches nowhere
  (with a note); pre-association history stays exactly as before — an empty
  round shell is the truthful rendering, not a guess.
- The runs of a round are ordered by `(startedAt, id)`; `agentRunIds`, the
  metadata union, and timing are order-invariant.
- Unassociated stamped runs still count in `totalExecutionWallTimeMs` (the
  item-wide union of every retained run interval).

## Outcomes

| Evidence | Outcome |
|---|---|
| Closed by a `completed` event **from the claim's agent** | `success` |
| `attempt_failed` with `metadata.outcome` `"failed"` / `"blocked"` **from the claim's agent** | the same word |
| Closing `completed` / `attempt_failed` from a DIFFERENT agent than the claim | the window still closes (`reportedAt` is set), but the outcome stays `unclassified` — the closing report is ignored for outcome attribution ("closing report from a different agent ignored for outcome attribution" note). When the claim's OWN agent also closed at that same instant, its report is the one used |
| Claim closed by a newer claim with no intervening release | `superseded` — the previous attempt is preserved, not deleted |
| Fix round with a newer generation on the same item | `superseded` |
| Fix round, item status `FIXED` / `BLOCKED` / `PARKED` | `success` / `blocked` / `abandoned` |
| Claim closed by a `claim_released` alone | `unclassified` — a release never certifies success or failure, whatever status it retained |
| Open attempt (no closing evidence) | `unclassified` |

A worker success report (`completed`) **never** produces merged evidence: the
chain has no merge outcome. Merges live only in the timeline's `pr_merged`
events, and appear in the chain solely as artifact PR numbers inside an
attempt's window.

An attempt left open (no closing evidence) has an **unbounded forward
window**: later attributable runs and merges on the issue attach to it
until the next claim (attribution rules above still apply, so a different
known agent's runs never flow into an open attempt).

## Dedupe guarantees

- **Keyed duplicate reports cannot inflate counts.** Two identical reports
  carrying an idempotency key (the same `AgentReportDedupe` idempotency key)
  land on one `AgentRun` row — the report dedupe reuses it — so the chain
  sees one run, one attempt's worth of evidence. The projection additionally
  dedupes runs by id. **This guarantee is scoped to keyed reports:** reports
  WITHOUT an idempotency key are at-least-once — a retried keyless report
  creates a second `AgentRun` and can double-count wall time.
- **Repeated webhook/sync events collapse.** The projection reuses the
  timeline's exact-duplicate collapse: the same transition observed by two
  writers (the documented `api:*` vs `webhook` pair) is one fact, with a
  "duplicate observation collapsed" note. PR-fix history rows are persisted
  facts with their own ids: `prFixEvents` keys on the row id, so an exact
  replay of one row is one event and never inflates the evidence stream.
- **A late duplicate observation cannot rename an attempt.** Because the
  attempt id is derived from the fact's canonical dedupe identity and not
  from the observing row, a duplicate that arrives later — with a different
  `source`/`actor` — collapses into the existing attempt and leaves its id
  unchanged. Only a claim that differs in a field of the identity (kind,
  status transition, occurrence time, or agent) is a new attempt.
- **A fact's evidence is the union of its observations.** Which row happens
  to represent a collapsed duplicate never decides an attempt's content:
  - `claimedAt.provenance` is `observed` when AT LEAST ONE observation of
    the claim was recorded live, and `backfilled` only when EVERY
    observation of it is a backfill (a backfill is a reconstruction from
    existing evidence, so a fact that also has a live observation was
    observed). More evidence never weakens the claim.
  - A failure's outcome (`failed` / `blocked`) is the first non-null
    `metadata.outcome` across the fact's observations; a duplicate that
    carries no outcome never erases an attested one. Conflicting
    attestations inside one fact resolve deterministically by content
    order.
  - When several closing events land at the SAME instant, the closing event
    from the CLAIM's own agent wins, so a cross-agent report at that
    instant cannot mask the claim's own outcome.

## Unparseable input is skipped, never guessed

A row whose timestamp does not parse is skipped with a note (event
`occurredAt`, run `startedAt`, PR-fix history `at`, item `queuedAt`). A run
with an unparseable `finishedAt` evidences execution at its start without
inventing an end. Nothing is ever fatal and nothing is ever guessed.

## Execution metadata: privacy and size validation

Workers may attach an optional `executionMetadata` object to
`POST /api/agents/[agentName]/tasks/report`, validated by
`src/lib/execution-metadata.ts` before anything is hashed or persisted:

- Recognized keys ONLY: `worker`, `model`, `reasoningEffort`,
  `runtimeRevision`, `cohortLabel`. Unknown keys fail the request (fail
  closed) so the bag cannot grow into a free-form side channel.
- Values must be trimmed non-empty strings of at most 128 printable ASCII
  characters on a single line. **This validation is structural only — it is
  not a content filter.** It guarantees that no multiline prompt or stack
  trace can ride into the column and bounds the stored size, but a
  credential short enough to fit the shape would pass. Workers must not send
  secrets, and Dispatch does not scan content.
- At least one key must be present when the object is supplied;
  `undefined`/`null` validate to an empty bag.
- Values are preserved (trimmed), never inferred.

**Backward compatibility:** an absent field changes nothing — the column
stays null and the idempotency payload hash is unchanged for existing
workers, since the canonical hashing omits explicitly-undefined fields. The
migration (`20261021180000_add_agent_run_execution_metadata`) is additive:
one nullable JSONB column on `AgentRun`, no backfill.

## PR-fix evidence events stay distinct

The fix round answers *which generation of fix work*; it deliberately does
NOT absorb the queue item's history. The `PrFixHistory` stream is delivered
alongside the attempts as `attempts.prFixEvents` — one classified event per
retained history row — so enqueue, review-triggered, CI-failure, conflict,
ack, reclaim, requeue, capacity-handoff, reactivation, external-wait, and
settlement evidence remain **distinct facts** (#1183 acceptance), never
folded into the round's single outcome.

| Field | Meaning |
|---|---|
| `eventId` | The persisted `PrFixHistory` row id — the event's identity. Exact replays of one row produce one event; conflicting duplicates of one id keep the first in content order with a note. |
| `itemId` / `repo` / `pr` | The queue item the row belongs to. |
| `at` | The row's timestamp, ISO. Rows whose `at` does not parse are skipped with a note. |
| `action` | The raw persisted action, verbatim — classification never replaces the source fact. |
| `eventClass` | Closed classification from the row's own fields: `enqueue`, `ack`, `reclaim`, `requeue`, `capacity-handoff` (`capacity_handoff`); `mark` splits by the status it stamped — `reactivation` (QUEUED: cooldown, post-dispatch-evidence reopen, failure-report reopen), `external-wait` (WAITING_EXTERNAL), `settlement` (anything else). An unrecognized action stays `other` — never guessed. |
| `status` / `outcome` | The row's stamped status/outcome, verbatim (nullable). |
| `evidenceKind` / `evidenceTrigger` | Only enqueue rows carry an `evidenceKey` (`"<kind>:<repo>#<pr>[:<sourceId>]"`): `evidenceKind` is the raw prefix and `evidenceTrigger` maps it to a closed set — `review` (`review`/`review_comment`), `ci-failure` (`check_run`), `conflict` (`merge_conflict`), `comment`, `merge-state`, `unknown`. `merge_state` is ambiguous and never folded into `conflict`. Every other row reports `null` — it never inherits the item's mutable current `type` as a guess. |

Events are chronological, with a deterministic tie-break on
`(itemId, eventId)`, and are **not** attributed to a generation: history rows
carry no generation field, so guessing which round an event fed would be
fabrication. Item coordinates plus time place each event against the rounds.

## Worked example

A worker (any worker product — nothing here assumes a specific harness)
reports a finished attempt:

```
POST /api/agents/[agentName]/tasks/report
Authorization: Bearer <token>

{
  "taskType": "implement",
  "outcome": "pr_opened",
  "repoFullName": "octocat/hello-world",
  "issueNumber": 42,
  "pullRequestNumber": 7,
  "summary": "Fixed the flaky retry loop",
  "idempotencyKey": "attempt-42-1",
  "executionMetadata": {
    "worker": "my-ci-harness",
    "model": "gpt-5.5",
    "reasoningEffort": "high",
    "runtimeRevision": "abc1234",
    "cohortLabel": "exp-42"
  }
}
```

The validated bag is stored on the resulting `AgentRun` row and participates
in the idempotency payload hash, so an identical-body retry replays the same
result. The chain then reads, for that issue:

```json
{
  "attempts": {
    "schema": "dispatch.work-item-attempt-chain/v1",
    "units": "milliseconds",
    "workItem": { "repoFullName": "octocat/hello-world", "issueNumber": 42 },
    "attempts": [
      {
        "attemptId": "exec-3f9a1c2b7d04",
        "kind": "execution",
        "agentName": "alpha",
        "claimedAt": { "at": "2026-10-01T10:00:00.000Z", "provenance": "observed" },
        "startedAt": "2026-10-01T10:05:00.000Z",
        "endedAt": "2026-10-01T11:00:00.000Z",
        "reportedAt": "2026-10-01T11:02:00.000Z",
        "outcome": "success",
        "classification": "active-execution",
        "executionMetadata": {
          "workerProduct": "my-ci-harness",
          "model": "gpt-5.5",
          "reasoningEffort": "high",
          "runtimeRevision": "abc1234",
          "cohortLabel": "exp-42"
        },
        "artifacts": { "agentRunIds": ["run-1"], "pullRequestNumbers": [7] },
        "wallTimeMs": 3300000,
        "prFix": null
      }
    ],
    "totalExecutionWallTimeMs": 3300000,
    "prFixEvents": [],
    "prFixEventsTruncated": false,
    "notes": []
  },
  "attemptsTruncated": false
}
```

A different worker product with no execution metadata produces the same
chain shape with every `executionMetadata` field null — the contract is
worker-neutral and has no product-specific branching.
