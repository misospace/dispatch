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

Non-goals for now: a board UI over the timeline, and worker attempt
telemetry/cohorts (downstream #1183/#1184 build on the read contract below).
The read contract, the authoritative merge linkage, and the bounded backfill
landed with #1203. The attempt chain built on that contract (execution
attempts and PR-fix rounds linked into one delivery chain) is documented in
[docs/work-attempt-chain.md](./work-attempt-chain.md).

## Taxonomy

| Kind | Meaning | Typical source |
|---|---|---|
| `claim` | An agent took ownership. Recorded when the status label moved **or** the `agent/*` label changed (a force-claim between agents moves no status). | `api:claim` |
| `claim_released` | Ownership was given up. Kept distinct from a failed attempt: the status the release left behind is recorded, including when it deliberately retained `status/in-review`. | `api:unclaim`, `stale-recovery` |
| `attempt_failed` | A worker reported a `failed` or `blocked` outcome. Recorded once per report; an idempotent duplicate replays the original run and adds nothing. | `agent-report` |
| `status_changed` | The `status/*` label moved. `fromStatus`/`toStatus` carry the values. | `api:move`, `api:status`, `api:groom`, `hosted-groomer`, `reconciler`, `sync`, `webhook` |
| `completed` | A worker report closed the item as already done (`status/done` + GitHub close). Not evidence that a PR merged. | `agent-report` |
| `issue_closed` | The GitHub issue was observed closing — or closed by the hosted groomer. Distinct from the card reaching Done. | `reconciler`, `sync`, `hosted-groomer` |
| `issue_reopened` | The issue was observed reopening after a close. | `sync` |
| `pr_merged` | A PR referencing the item was observed merged. Only ever recorded from an observation of a merge — never from a worker's success report. Metadata carries the PR number/url, GitHub's own `mergedAt`, and `headSha` / `mergeCommitSha` when the observer had them, plus a `linkSource` (`body-keyword`, `branch-name`, `reconcile-close-trigger`, `agent-run-touch`) saying how the PR is correlated to the issue. Multiple linked PRs record one row each; a title-only match is never a link. | `reconciler`, `backfill` |

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
| Hosted groomer plan application | `src/lib/groomer/run.ts` | `status_changed` (only the moves the plan actually made), `issue_closed` (when the plan closed the issue) |
| Reconciler | `src/app/api/issues/reconcile/route.ts` | `status_changed`, `pr_merged`, `issue_closed` |
| Issue sync | `src/lib/issue-sync.ts` (`makePrismaIssueStore`, `makePrismaReconcileIssueStore`) | `status_changed`, `issue_closed`, `issue_reopened` |
| GitHub webhook | `src/app/api/issues/webhook/route.ts` | `status_changed` |
| Worker report | `src/app/api/agents/[agentName]/tasks/report/route.ts`, `src/lib/report-close.ts` | `attempt_failed`, `completed` |
| Lifecycle merge backfill (operator, per issue) | `src/lib/lifecycle-backfill.ts`, `POST /api/issues/[issueId]/lifecycle` | `pr_merged`, only from a run record naming the PR plus that PR's persisted GitHub merge time |

## Reading the stream: the lifecycle timeline (#1203)

`GET /api/issues/[issueId]/lifecycle` (any authorized caller) projects the
stream into a typed, source-neutral read contract —
`dispatch.issue-lifecycle-timeline/v1` — built by
`buildIssueLifecycleTimeline` in `src/lib/issue-lifecycle-read.ts` (pure, no
I/O). It exposes, per work item:

- `claims[]` (every observed claim, in occurrence order) and `firstClaim` —
  **a missing first claim is `{ at: null, provenance: "unknown" }`, never
  zero and never the issue creation time**. A reclaim never replaces the
  first claim.
- `doneAt` / `closedAt` / `lastReopenAt` milestones. A close observed without
  a merge is `delivery: "closed-unmerged"` — never labeled shipped. Reopening
  preserves the earlier close milestone in `closedAt`, while `delivery` follows
  the latest close/reopen ordering: the latest close is the later of the last
  observed close and the issue cache's `closedAt` (the cache counts only for a
  closed issue), so a close after a reopen reports `closed-unmerged` again.
- `pullRequests[]`: one entry per distinct merged PR (multi-PR issues are
  first-class), each with the authoritative `mergedAt`, `mergeCommitSha`,
  `headSha`, and `linkSource` provenance, plus `firstMergedAt`.
- `claimToDoneMs` / `claimToMergeMs`, in **milliseconds**, null whenever
  either endpoint is unknown. A merge preceding the first observed claim
  yields a negative value plus a note — reported, not hidden.
- Every timestamp carries `provenance`: `observed` (a lifecycle event or the
  issue-cache fallback), `backfilled` (`metadata.backfilled === true`), or
  `unknown`. Rows written by the backfill are therefore never mistaken for
  real-time observations.

The read is bounded (`take` window of 500 events, `truncated: true` beyond
it) — no full-history GitHub scan on a routine request. Duplicate
observations (the documented `api:*` vs `webhook` pair) collapse in the
projection with a note. The raw window ships alongside the timeline as
`events[]` for downstream consumers (#1183 attempts, #1184 cohorts); the
contract assumes nothing Courier- or Dispatch-writer-specific. That 500-event
read window is a bound of its own, separate from the reconciler's 100-PR
merged-PR window: the first caps how much of the stream a read projects, the
second caps how many merged PRs reconcile can observe.

### Merge linkage and the bounded backfill

Merge evidence is written only through `recordPrMergedEvent`
(`src/lib/issue-lifecycle.ts`), whose canonical dedupe identity
(`reconciler|<repo>|<issue>|pr_merged|<pr>|<mergedAt>`) is shared by every
observer — reconcile, and the backfill — so the same physical merge observed
twice lands on one row. The reconciler records one `pr_merged` per *linked*
merged PR (#1203), each with its `linkSource`. Link evidence comes only from
an explicit correlation — a body Fixes/Closes/Resolves keyword or a
branch-name pattern. PR titles are never consulted, for links or for the
close decision: a merged PR that only names an issue in its title neither
closes it nor records a merge for it. When a caller supplies no evidence
list at all, the PR that actually drove a recorded close is still noted,
with `linkSource: "reconcile-close-trigger"`, because that correlation is
the observed action rather than a text guess. The dedupe stamp is
canonicalized so a `Date` and GitHub's second-precision string form of the
same merge produce the same key, keeping reconcile, sync, and backfill on
one row per physical merge.

Merge recording is decoupled from the reconcile action loop: a linked merge
records whether the issue is open or closed and whether the close action
executed. A second bounded pass inside the same reconcile run records the
merge for every linked number in the fetched window
(`recordLinkedMergeEvidence`, merges only — no close or status writes). It
re-derives links from the already-fetched merged-PR window, so it adds no
GitHub calls, and replays idempotently onto the same dedupe key — rows the
close path already wrote converge on the same row.

`POST /api/issues/[issueId]/lifecycle` (operator auth only — agent bearer
tokens get 403) backfills legacy issues **only from verifiable records**: an
`AgentRun` attached to the issue whose `touchedIssueUrls` name a PR,
correlated with that PR's authoritative merge timestamp already persisted in
Dispatch (`GithubPullRequest.mergedAt`).
It never fabricates a first claim, never reads `startedAt`/`createdAt` as
claim evidence, skips PRs without an authoritative merge time, and replays
idempotently onto the shared dedupe identity. Unknown stays unknown; nothing
here estimates.

The merge time has to be persisted before the backfill can use it. The
automation sync currently upserts open PRs only, and an open PR never carries a
merge, so a row it wrote holds no `mergedAt` and a PR that later merges is not
updated either — the backfill recovers a merge only where the merge time is
already in the table (#1313 tracks closing that gap). A PR without a persisted
merge time stays unrecorded: the backfill never infers a merge from a merge
state alone.

The reconciler's merged-PR window is bounded: reconcile fetches each repo's open
PRs and its most recently updated closed PRs (`fetchPullRequests` /
`fetchClosedPullRequests`, 100 per page — up to 200 open, 100 closed), and
merged PRs come from the closed side, since an open PR never carries a merge.
A merge outside that closed window is never seen by reconcile and is therefore
never recorded by reconcile — those merges are the operator backfill's
territory.

To recover merges for older issues, run `POST /api/issues/{issueId}/lifecycle`
for that issue. Both of the backfill's preconditions must hold: an `AgentRun`
attached to the issue whose `touchedIssueUrls` name the PR, and that PR's
persisted `GithubPullRequest.mergedAt` — and the merge time is only there if
it was persisted before the PR dropped out of the sync's open-PR listing
(#1313). Without both, the PR stays unrecorded — the backfill never infers a
merge from a merge state alone. Its own PR read is bounded to the PRs the
issue's runs touch, and the count of merged PRs no run touched comes from a
repo-wide aggregate count rather than a full repo scan.

## Idempotency

Two independent rules, because the writers are not equally repeatable.

**Transitions, not writes.** For a write Dispatch authors itself (claim, move,
status, groom), the event is recorded only when the status label actually
changed — or, for a claim, when the assigned agent changed. A redelivered claim
of an already-claimed issue, a drag that lands back in the same column and a
set-status to the current status therefore record nothing, while a genuine
release → reclaim pair records both attempts and leaves the first claim intact.
These events carry no `dedupeKey`; the guard is what makes them single. The one
keyed case is the stale sweep's ownership-only release: the sweep knows the
AgentWork row it is releasing, which is one claim epoch, so it supplies that as
the release's identity and a retry of the same sweep — which finds the agent
label already gone and repairs the cache — lands on the same `claim_released`
row instead of recording the release twice.

**Source identity.** For an externally observed event the source usually has
its own identity, which becomes a unique `dedupeKey` and the write is an
upsert with an empty update, so redelivery lands on the row that already
exists without rewriting its timestamps:

- webhook — `webhook|<repo>|<n>|<delivery id>|<label>`
- sync — `sync|<repo>|<n>|<kind>|<from>|<to>|<issue updated_at>`
- reconciler — `reconciler|<repo>|<n>|<kind>|<pr number>|<merged_at>`

A second, genuine transition always carries a different source timestamp (or
a different PR), so it gets a different key and is appended normally. A
hosted-groomer close is keyed by its application
(`hosted-groomer|<repo>|<n>|issue_closed|<application key>`) for the same
reason: a retry of the same plan collapses onto one row.

**Recovering a Dispatch-authored write whose GitHub mutation already landed.**
Claim and set-status write GitHub labels first and mirror them into the cache
inside the transaction that also records the event. If that transaction fails,
GitHub already carries the claim while the cache still holds the pre-write set,
so a retry observes labels that show no change — and the guard would record
nothing, losing the first attempt's evidence for good. Both routes therefore
pass their cached label set as `mirroredBefore`: the recorder prefers the
observed set whenever it shows the change and falls back to the mirror when it
does not, marking such a row `recoveredFromMirroredState`. The fallback is
consulted only when the observed set shows nothing, so a redelivered claim of an
already-claimed-and-committed issue still records nothing. The claim decision
itself always reads the live GitHub labels.

Known limitation of that fallback: the mirrored row is a witness of the
pre-write state only when the cache was in step with GitHub. If sync lag left it
behind, a retry can recover a row whose `fromStatus` describes the last mirrored
state rather than the state this claim actually displaced — the two are
indistinguishable at retry time, and telling them apart would need an intent
record written durably *before* the GitHub mutation. Every such row carries
`recoveredFromMirroredState`, so a reader can separate a recovered row from an
observed move; no status change is lost either way, because sync independently
records the real GitHub-side move — only its attribution to this writer is
approximate.

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
- **Sync** records before it mirrors: the events are written first, so a failed
  event write aborts that issue's cache write instead of leaving a cache that
  shows a move the stream has no record of. Both sync cores already catch a
  failing write — at repo level for the issue sync, per issue for closed-issue
  reconciliation — and report it in their existing result shape; because the
  cache row never moved, the next run re-derives the same transition from the
  same before-state onto the same `dedupeKey`, so the deferred mirror costs one
  row rather than a duplicate.
- **Webhook, reconciler, worker report, hosted groomer** stay best-effort and
  log a warning: those writers are periodic or retried, and their job is the
  local mirror — an evidence-row problem must not cost a whole run or fail a
  worker's report. The groomer therefore records its status move and its close
  through the same transition guard as everyone else (a `noop` or a `partial`
  that moved no `status/*` label records no `status_changed`) and both stay
  quiet, because a run that already landed its mutations must not fail over an
  evidence row.

## Migration

`prisma/migrations/20261013120000_add_issue_lifecycle_events` creates the table
and its indexes. It is additive: no backfill, no change to `Issue`, no change
to any API response, and no new worker requirement, token or model field. The
stream starts empty and fills as writers run, so a first claim recorded after
the migration has no earlier history to contradict — which is exactly why no
reader may infer a first claim from the absence of events.
