# Issue lifecycle events

`IssueLifecycleEvent` is Dispatch's durable, worker-neutral record of what
happened to a work item over its life: who claimed it, who let it go, which
status label moved, and when. It exists because the current state and the audit
log cannot answer a claim-to-merge question:

- `Issue` holds only the *current* status, so the first claim is
  indistinguishable from the third.
- `AuditLog` is per-request, is not deduplicated, and is written by each writer
  in its own vocabulary. A redelivered claim, a repeated sync and a real second
  attempt all look alike.

The stream is append-only, belongs to the `Issue` it describes (there is no
product-specific table or side channel), and is written through one contract —
`src/lib/issue-lifecycle.ts` — so the taxonomy, the idempotency rules and the
timestamps cannot drift between routes.

Non-goals for now: PR merge/link backfill, a duration API or UI, and worker
attempt telemetry/cohorts.

## Taxonomy

| Kind | Meaning | Typical source |
|---|---|---|
| `claim` | An agent took ownership. Recorded when the status label moved **or** the `agent/*` label changed (a force-claim between agents moves no status). | `api:claim` |
| `claim_released` | Ownership was given up. Kept distinct from a failed attempt: the status the release left behind is recorded, including when it deliberately retained `status/in-review`. | `api:unclaim`, `stale-recovery` |
| `attempt_failed` | A worker reported a `failed` or `blocked` outcome. Recorded once per report; an idempotent duplicate replays the original run and adds nothing. | `agent-report` |
| `status_changed` | The `status/*` label moved. `fromStatus`/`toStatus` carry the values. | `api:move`, `api:status`, `api:groom`, `hosted-groomer`, `reconciler`, `sync`, `webhook` |
| `completed` | A worker report closed the item as already done (`status/done` + GitHub close). Not evidence that a PR merged. | `agent-report` |
| `issue_closed` | The GitHub issue was observed closing. Distinct from the card reaching Done. | `reconciler`, `sync` |
| `issue_reopened` | The issue was observed reopening after a close. | `sync` |
| `pr_merged` | A PR referencing the item was observed merged. Only ever recorded from an observation of a merge — never from a worker's success report. | `reconciler` |

`kind` and `source` are stored as strings, not enums, so a new writer can be
added without a migration; `LIFECYCLE_EVENT_KINDS` and `LIFECYCLE_SOURCES` in
`src/lib/issue-lifecycle.ts` are the authoritative lists.

## Columns that carry provenance

| Column | Meaning |
|---|---|
| `issueId` | The work item the event belongs to (FK, cascades on delete). |
| `repoFullName`, `issueNumber` | Denormalized for reads that only know GitHub coordinates. |
| `source` | Which writer produced it — `api:*` for routes, `stale-recovery`, `hosted-groomer`, `reconciler`, `sync`, `webhook`, `agent-report`. |
| `actor` | The identity responsible: an agent name, an operator actor, `hosted-groomer`, `reconciler`, or GitHub's sender login. |
| `agentName` | Set when the event is about an agent's work (claim, release, failed attempt). |
| `occurredAt` | When the transition happened. For a Dispatch-authored write this is "now". For an observed event it is the source's own timestamp — the PR's `merged_at`, the issue's `updated_at`, its `closed_at`. |
| `observedAt` | When Dispatch saw it. Never backdated to `occurredAt`. |
| `sourceEventId` | The event's identity in its source system when it has one (GitHub delivery id, `pr-<n>`). Provenance only. |
| `dedupeKey` | Uniqueness identity for an observed event (unique index). See below. |
| `metadata` | Small JSON bag for the extra shape of that writer (force-claim details, grooming run id, pull-request number, block reason). |

## Which writers record what

| Writer | Where | What it records |
|---|---|---|
| `POST /api/issues/claim` | `src/app/api/issues/claim/route.ts` | `claim` |
| `POST /api/issues/unclaim`, stale-AgentWork sweep | `src/lib/issue-claim.ts` (shared core) | `claim_released` |
| Board drag-and-drop | `src/app/api/issues/move/route.ts` | `status_changed` |
| Manual / agent status set | `src/app/api/issues/status/route.ts` | `status_changed` |
| Operator grooming decision | `src/app/api/issues/groom/route.ts` | `status_changed` |
| Hosted groomer plan application | `src/lib/groomer/run.ts` | `status_changed` |
| Reconciler | `src/app/api/issues/reconcile/route.ts` | `status_changed`, `pr_merged`, `issue_closed` |
| Issue sync | `src/lib/issue-sync.ts` (`makePrismaIssueStore`, `makePrismaReconcileIssueStore`) | `status_changed`, `issue_closed`, `issue_reopened` |
| GitHub webhook | `src/app/api/issues/webhook/route.ts` | `status_changed` |
| Worker report | `src/app/api/agents/[agentName]/tasks/report/route.ts`, `src/lib/report-close.ts` | `attempt_failed`, `completed` |

## Idempotency

Two independent rules, because the writers are not equally repeatable.

**Transitions, not writes.** For a write Dispatch authors itself (claim, move,
status, groom), the event is recorded only when the status label actually
changed — or, for a claim, when the assigned agent changed. A redelivered claim
of an already-claimed issue, a drag that lands back in the same column and a
set-status to the current status therefore record nothing, while a genuine
release → reclaim pair records both attempts and leaves the first claim intact.
These events carry no `dedupeKey`; the guard is what makes them single.

**Source identity.** For an externally observed event the source usually has
its own identity, which becomes a unique `dedupeKey` and the write is an
upsert with an empty update, so redelivery lands on the row that already
exists without rewriting its timestamps:

- webhook — `webhook|<repo>|<n>|<delivery id>|<label>`
- sync — `sync|<repo>|<n>|<kind>|<from>|<to>|<issue updated_at>`
- reconciler — `reconciler|<repo>|<n>|<kind>|<pr number>|<merged_at>`

A second, genuine transition always carries a different source timestamp (or
a different PR), so it gets a different key and is appended normally.

Known limitation: Dispatch's own label writes also generate GitHub webhook
deliveries. A delivery that is processed before the originating request has
mirrored the change locally sees the older cache, so the same move can appear
once as `api:*` and once as `webhook`. Both rows carry the same `fromStatus` and
`toStatus`, so a reader deduplicating consecutive identical transitions sees
one; the alternative — dropping the webhook event outright — would lose genuine
human edits that happen to look the same.

## Late and out-of-order observations

Events are never replayed onto `Issue` state, so recording one cannot move the
present status — a sync that runs an hour late writes a row whose `occurredAt`
is an hour old and whose `observedAt` is now, and leaves the issue exactly as
the writer that owns it left it. Readers order by `occurredAt` and can see the
gap between occurrence and observation rather than having it hidden by a
backdated row.

## Failure behavior

- **Dispatch-authored writes** share a transaction with the local state they
  describe (claim, move, status, groom, unclaim release). A failed event write
  fails the write rather than leaving a claim with no evidence row; the route
  returns its existing error shape.
- **Observed writes** (sync, webhook, reconciler, worker report, hosted
  groomer) are best-effort and log a warning. Those paths are periodic,
  retried, and their job is the local mirror — an evidence-row problem must not
  cost a whole sync run or fail a worker's report.

## Migration

`prisma/migrations/20261013120000_add_issue_lifecycle_events` creates the table
and its indexes. It is additive: no backfill, no change to `Issue`, no change
to any API response, and no new worker requirement, token or model field. The
stream starts empty and fills as writers run, so a first claim recorded after
the migration has no earlier history to contradict — which is exactly why no
reader may infer a first claim from the absence of events.