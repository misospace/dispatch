# Standalone Observability Snapshot API (#1252)

`GET /api/observability` returns a bounded, read-only JSON snapshot of the
signals and states specified in [observability.md](./observability.md),
derived entirely from Dispatch's own database. It implements integration
approach **D (Snapshot API)** from §7 of that design. It is not a Prometheus
`/metrics` endpoint and adds no exporter dependency; a consumer maps the JSON
to whatever backend it chose.

## Contract

- **Read-only.** The route and collector only issue `findMany` / `findFirst` /
  `count` queries. Exporting metrics never releases a claim, requeues an item,
  mutates an issue status, or touches credentials. There is no mandatory
  backend: the endpoint answers with the database alone.
- **Authenticated.** Maintainer tier only (bearer `DISPATCH_AGENT_TOKEN`,
  Basic, or OIDC per `src/lib/auth.ts`); worker-tier bearer tokens are
  rejected with 403. Responses carry `Cache-Control: no-store`.
- **Dispatch-cache, not forge truth.** Signals describe the Postgres cache of
  GitHub state and can lag between syncs (design §2).
- **Bounded dimensions.** Every grouped dimension is an allowlist with an
  `unknown` bucket: issue status, lane (configured lane ids only), AgentWork
  state/checkpoint, PR-fix status/lane/outcome, admission reason codes,
  grooming run status, sync type, scheduler job name, and a fixed
  `AuditLog.action` allowlist (dynamic `issue_groomed_*`, `reconcile_*`,
  `workflow_*` families fold to one bucket each). No repository names, issue
  or PR numbers, agent identities, task IDs, or error strings appear anywhere
  in the response — the response type has no place to put them.
- **Gauges, not counters.** Windowed values (audit failures, PR-fix
  reclaim/settle, pickups/reported/started) are as-of-scrape gauges
  recomputed from row timestamps over fixed windows (`900`/`3600` seconds for
  failures, `1800`/`3600` for activity). Evaluate them directly; never apply
  `rate()`, `increase()`, or `delta()` (design §4.1). Equal aggregate counts
  at two scrapes can still hide a fresh event — the as-of-scrape window is
  what makes the arrival observable.
- **Explicit unknown.** Absent baselines are `null`, never coerced to zero:
  no ever-completed sync (`pipeline.sync.lastSuccessTimestampSeconds: null`
  plus `everSucceeded: false`), admission state in `off` mode
  (`admission.notAdmitted: null`), a sync pipeline that is not armed (opted
  out, unknown, or the sync job disabled —
  `observations.eligibleWorkNotHandedOut: null`; otherwise the observation is
  decidable), assignment age without persisted evidence.
- **The sync-pipeline arm state is explicit too.** `config.syncPipeline` is
  the operator's **raw declaration** (`DISPATCH_SYNC_PIPELINE`: `auto`,
  `external`, or `off` — the value as declared, never inferred), and
  `pipeline.syncPipelineState` is the **derived** arm state the alerts gate on:
  `armed` (the pipeline is expected to run), `off` (the operator opted out),
  or `unknown` (it cannot be told). The derivation reads the declaration plus
  in-process facts only (is the in-process scheduler ticking? is a sync
  interval configured?) — **sync history is never evidence**: a one-off
  manual sync is not a pipeline, and inferring "armed" from history would
  arm a false CRITICAL A2 in the default deployment. An `unknown` state is
  neither healthy nor stale, so the dependent observations stay `null`.

## Sections

| Section | Catalogue rows | Notes |
|---|---|---|
| `workSupply` | §4.2 `dispatch_issues`, `dispatch_issues_open_claimable`, ages, `dispatch_dependency_blocked` | open issues only; status/lane dimensions on the issue gauges. `openClaimable` and `dependencyBlocked` are emitted aggregate-only — the per-`lane` split from the catalogue is not part of this snapshot |
| `execution` | §4.3 + §4.10 `dispatch_work_pickups_in_window`, `dispatch_agent_runs_reported_in_window`, `dispatch_agent_runs_started_in_window`, §4.4 AgentWork distribution | system-emitter exclusion: hosted-groomer leases/AgentWork and every non-task `AgentRun` row are filtered by `agentName`/`runType` allowlist, so a running groomer or a merely polling fleet cannot look busy; `BLOCKED` AgentWork never counts as active execution |
| `assignmentObservation` | §4.3 `dispatch_assigned_without_execution` + A6 inputs | see "aged specific assignments" below |
| `prFix` | §4.5 hand-out/ack/reclaim, §4.6 settlement | `PARKED` (operational exhaustion, by outcome) is reported separately from `BLOCKED` (`human_decision`) and never inflates it; overdue is **age-tied** to `dispatchedAt` vs `PR_FIX_HANDOUT_TIMEOUT_MS` |
| `admission` | §4.7 | reuses the canonical rule in `src/lib/queue-admission.ts`; withheld reason codes are the 12-code allowlist |
| `grooming` | §4.8 | persisted columns only; absent fingerprint is `unknown`, never `fresh` |
| `pipeline` | §4.9 | real `IssueSyncRun` statuses (`completed`/`failed`); the last-success series is absent (null) until the first completion; the arm state (`pipeline.syncPipelineState`) is derived from the raw declaration (`config.syncPipeline`) plus in-process facts — never from sync history |
| `failures` | §4.10 `dispatch_audit_failures_in_window` | per-action sparse maps per window |
| `observations` | §6 predicate helpers | derived states: A4 conjunction (with the fresh-sync and scheduler guards), A5, age-tied A7, aged-assignment evidence, A2 absent-series, discovery failing, scheduler overdue, admission withholding |

## Aged specific assignments (A6 evidence)

The aggregate `execution.assigned` minus active execution is a dashboard
number only — steady churn keeps it nonzero while every assignment is picked
up promptly. The snapshot therefore exposes the *inputs* an observer needs to
identify specific aged items, with the age evidence made explicit:

- `ageKnown` — items whose assignment age comes from a persisted successful
  `assign_agent` audit row (`DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS`
  is the consumer threshold, default 30m).
- `ageUnknown` — assignments with no persisted age evidence (GitHub-side
  label adds, or assignments older than the loaded evidence horizon
  `evidenceLookbackSeconds`, 30 days). These are **never** reported as aged
  (fail-open for alert safety) and the split is surfaced so a consumer cannot
  mistake "no age evidence" for "no waiting".
- `agedPastThreshold` / `oldestKnownAgeSeconds` — counts ONLY known-age items
  past the threshold. Any `Lease` or `AgentWork` row ever created for the
  issue (presence, not ordering — so a no-op re-assign of delivered work does
  not re-arm the clock) proves the assignment became execution.

The same age-tied rule governs PR-fix hand-outs: `unackedAggregate` is
dashboard-only; `overdueUnacked` and `oldestUnackedHandoutAgeSeconds` are the
alertable, per-item evidence for A7.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS` | 1800000 (30m, clamped 1m–24h) | threshold past which known-age un-executed assignments count as aged |

## Implementation

- `src/lib/observability-signals.ts` — pure derivation over loaded rows; all
  allowlists live here; unit-tested scenario matrix (healthy idle, busy
  churn, stranded assignment, no first sync, failing discovery, inactive
  worker, held dependency) with no database.
- `src/lib/observability-snapshot.ts` — read-only collector: loads the rows
  and calls the pure layer; window starts are computed from one `now`.
- `src/app/api/observability/route.ts` — authenticated GET.

Cost note: `Lease` and `AgentWork` are read in full per request (no time
bound) so state gauges cover the whole table. Both are row-bounded by
agent x issue uniqueness and the orphan sweep today; if scrape cost ever
becomes a problem at scale, a bounded or pre-aggregated variant is the
follow-up, not a change to the signal semantics.
