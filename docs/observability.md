# Standalone Portable Observability for Dispatch

Design only. This document defines Dispatch observability independently of
Courier and of any operator's monitoring environment. It specifies the signals
and states Dispatch already owns, a backend-neutral dashboard and alert
specification, and integration approaches — without choosing an exporter,
dashboard product, or rule engine. No implementation, requeues, claim release,
worker credential changes, dashboard/rule assets, deployments, or home-ops
configuration are part of this design.

- Tracking issue: misospace/dispatch#1237
- Informational counterpart (not a prerequisite): misospace/courier#289
- **Implementation status (#1252):** approach D (Snapshot API) from §7 is
  implemented as `GET /api/observability` — a bounded, read-only JSON
  snapshot of this catalogue. Its contract is specified in
  docs/observability-snapshot.md. This document remains the design source of
  truth; a `/metrics` scrape exporter, OTel push, and executable alert
  assets remain deferred decisions (§10).
- **Implementation status (#1255):** the catalogue is packaged for operation:
  an opt-in Prometheus text exposition at `GET /api/metrics`
  (`DISPATCH_METRICS_ENABLED`, default off), the portable alert definitions
  and evaluator in src/lib/observability-alerts.ts with a replayable fixture
  matrix, and optional Prometheus/VictoriaMetrics rules plus a Grafana
  dashboard under observability/. The metric contract and installation
  guidance live in docs/observability-packaging.md, kept separate from these
  semantics. OTel push and deployment-owned notification routing remain
  deferred (§10).

---

## 1. Purpose and scope

Dispatch owns **work-supply and task-lifecycle truth**: which issues are
eligible, who owns them, whether an execution is live, how work is handed out,
acknowledged, settled, reclaimed, and withheld. Observability must answer, from
Dispatch's own state alone:

1. Is there eligible work, and is any of it failing to reach a worker?
2. Is claimed/assigned work actually being executed, or is ownership stale?
3. How did work end — settled, blocked on a human, parked from exhaustion, or
   stale because upstream is gone?
4. Is the supply pipeline (sync, groomer, admission, scheduler) healthy, or is
   the queue empty because the pipeline stopped?

An observer must be able to consume this **without Courier**: any worker client,
or none, is a valid deployment. Optional correlation with a connector/operator
is composition (join on an exported identifier at the consumer), never a
required shared identifier, dashboard, phase, or release cadence.

### In scope

- A **signal/state catalogue** with units, timestamp/reset semantics, bounded
  dimensions, privacy constraints, and missing/unknown states.
- A **dashboard view specification** as backend-neutral state predicates.
- An **alert catalogue** covering stale ownership, failure to hand out eligible
  work, unavailable upstream evidence, and normal inactivity.
- An **integration matrix** for optional Prometheus/VictoriaMetrics and
  OTel-based approaches.
- Healthy/idle/degraded examples for a non-Courier consumer.
- The current instrumentation and the unknowns.

### Non-goals

No implementation, requeues, claim release, worker credential changes,
dashboard/rule assets, deployments, or home-ops configuration. Exporter and
dependency choices require a later decision (see [§10](#10-open-questions-and-deferred-decisions)).

---

## 2. Boundaries and design principles

- **Dispatch is standalone.** Every signal in this document is derived from
  Dispatch's own database or its own HTTP surface. Nothing depends on Courier
  telemetry, phases, dashboards, release cadence, or identifiers.
- **Backend-neutral.** Signals are specified as state predicates and
  dimensions. The document does not assume Prometheus, VictoriaMetrics, OTel,
  Grafana, Alertmanager, or any vendor. Each integration is a mapping, not a
  requirement.
- **Bounded, low-cardinality dimensions.** Allowed label values are enumerable
  (status, lane, reason code, run type). **Do not** use arbitrary repository
  names, issue/PR numbers, task IDs, credentials, commit SHAs, or raw error
  strings as metric labels — those belong in logs/events and drill-down views.
- **Explicit unknown.** "No data" and "zero" are different. Freshness and
  upstream reads have a first-class `unknown` state and must be surfaced as
  such, never silently coerced to healthy.
- **GitHub is the source of truth; Postgres is a cache.** Label-driven state
  (issue status, `agent/*`, dependencies) is authoritative on GitHub and can
  lag in Dispatch between syncs. Signals describe the cache and must not be
  presented as the authoritative forge state.
- **No secrets, no PII.** Tokens, credentials, and personal data never appear
  in a label, metric name, or exported event.

---

## 3. Current instrumentation inventory

Dispatch today has **no OpenTelemetry and no structured counters/timers**;
every exported signal is recomputed from its persisted rows at read time.
Observability is a health endpoint, in-process scheduler liveness, and
append-only database tables. (Update #1252: a bounded read-only snapshot
endpoint of this catalogue exists at `GET /api/observability`, see
docs/observability-snapshot.md. Update #1255: an opt-in scrape exporter of
this catalogue now exists at `GET /api/metrics`
(`DISPATCH_METRICS_ENABLED`, default off) — still no OTel, no in-process
counters, and no push transport; every series is recomputed from the cache
at scrape time.)

| Source | Location | What it exposes | Limitation |
|---|---|---|---|
| Health endpoint | `src/app/api/health/route.ts` | `{ok, database, version, authMode, scheduler, schedulerOverdue}`; HTTP 503 when the DB is unreachable | Liveness only; no queue/lease/queue-depth detail |
| Scheduler liveness | `src/lib/scheduler.ts:203-219` (`schedulerState()`) | Per job: `lastRunAt` (ISO or null), `intervalMs`, `overdue` (no run in > 2× interval) | In-process, `globalThis`; lost on restart; only reports armed jobs |
| Scheduler jobs | `src/lib/scheduler.ts:88-140` | `sync` 15m, `groomer` 10m, `pr-followup` 15m, `ci-failures` 30m, `prune-closed` 24h, `reconcile` 30m, `stale-work` 5m, `pr-fix-sweep` disabled | Default-disabled unless `DISPATCH_SCHEDULER_ENABLED=true`; jobs are loopback HTTP POSTs |
| Audit log | `prisma/schema.prisma:324-342`; `GET /api/audit` | actor, action, repo, issue number, success, errorMessage, before/after labels, notes, createdAt | Free-string `action`; read-only listing; no aggregation |
| Agent runs | `prisma/schema.prisma:254-287` | agentName, runType, status, startedAt/finishedAt, summary, errorMessage, touchedIssueUrls, escalated outcome | `status` and `runType` are free strings |
| Issue sync runs | `prisma/schema.prisma:699-712` | status, reposFetched, syncedCount, syncType (scheduled/manual/automation), startedAt/completedAt | No failure-reason taxonomy |
| Automation sync runs | `prisma/schema.prisma:530-545` | status, reposFetched, workflowsFetched, runsFetched, startedAt/completedAt | Automation view only |
| Sync lock | `prisma/schema.prisma:719-725` | Single row serializing scheduled sync | Not a signal by itself |
| In-memory rate limiting | `src/lib/rate-limit.ts` | Per-instance counters | Not exported; per-replica |

**Gap:** there is no way today to see queue depth/age, active leases, stale
ownership, PR-fix hand-out/reclaim state, admission withholding, grooming
freshness, or settlement outcomes as signals. This document specifies them.

---

## 4. Signal and state catalogue

### 4.1 Naming, kinds, and semantics

- **Naming:** `dispatch_<domain>_<measure>_<unit>` (e.g.
  `dispatch_pr_fix_oldest_queued_seconds`).
- **Kinds:** `gauge` (current value), `counter` (monotonic total), `histogram`
  (bounded buckets). Because Dispatch has no in-process event counters, most
  "counters" are derived from append-only tables and are **not process-
   monotonic**. Model them either as gauges or as windowed counts recomputed by
   the exporter at each scrape; document which. Counters derived from the DB do
   **not** reset on process restart, unlike a conventional process counter.
- **`increase()`, `rate()`, and `delta()` are counter/cumulative-only — and the
  distinction is load-bearing here.** They all assume a monotonically increasing
  series. DB counts in this document are exported as **as-of-scrape windowed
  gauges** — `dispatch_<...>_in_window{..., window="<seconds>"}` (see §4.10) —
  where each scrape recomputes the count over its window. Such a series is not
  monotonic, so **no** rate-style function applies to it. In particular,
  `delta()` is sound only over a *cumulative* (non-decreasing) exported total;
  applied to an already-windowed count it silently loses events: a rolling 15m
  failure count can read `1` at both ends of the evaluation window while an
  older failure expired and a new one arrived, giving `delta == 0` and missing
  the failure entirely. Therefore: "did anything happen in the last N" evaluates
  the as-of-scrape gauge **directly** (e.g.
  `dispatch_<...>_in_window{window="900"} > 0`), never via `increase()`,
  `rate()`, or `delta()`. The `_total` suffix that remains on some rows of this
  catalogue is historical; those rows are windowed counts under this same rule,
  not monotonic counters, and must not fire alerts through rate-style
  evaluators.
- **Timestamp semantics:** gauges are "as of scrape". Event-derived totals use
  the row's own timestamp (`createdAt`, `at`, `startedAt`/`completedAt`) and are
  windowed by the exporter (e.g. `[5m]`, `[1h]`).
- **Reset semantics:** DB-derived totals never reset; the window is the reset.
  If an in-process exporter is later added, its counters reset on restart and
  must be paired with a start-time gauge.
- **Unknown:** any dimension value not in the allowlist maps to `unknown`; an
  absent baseline (e.g. never groomed) is `unknown`, distinct from `fresh`.

### 4.2 Work supply

| Signal | Kind | Unit | Source | Dimensions (allowlisted) | Semantics |
|---|---|---|---|---|---|
| `dispatch_issues` | gauge | count | `Issue.state`, `Issue.labels`, `Issue.currentLane` | `status` (`backlog`,`ready`,`in-progress`,`in-review`,`blocked`,`done`,`unknown`), `lane`, `state` (`open`,`closed`) | Current cached issue count by status/lane |
| `dispatch_issues_open_claimable` | gauge | count | derived (open, not `done`/`blocked`, claimable status) | `lane` | Eligible-to-work supply |
| `dispatch_issue_age_seconds` | histogram | seconds | `Issue.createdAt` | `status`, `lane` | Waiting time since creation, for the tail that is starving |
| `dispatch_issue_stale_sync_seconds` | gauge | seconds | `now - Issue.lastSyncedAt` | — | Cache staleness |
| `dispatch_dependency_blocked` | gauge | count | open issues with open `blocked_by` / body deps | `lane` | Eligible-but-withheld by dependencies |

Status values are the six canonical labels (`src/types/index.ts:138-153`).
`claimable` is not the same as `ready`: `status/in-progress` and
`status/in-review` are active but not new supply (`src/lib/agent-queue.ts:206-213`).

### 4.3 Assignment vs active execution

Assignment is label-only (`agent/*`, `owner/*`) and has no lease. Execution is a
`Lease` and/or `AgentWork` row. These are distinct and must not be conflated.

| Signal | Kind | Unit | Source | Dimensions | Semantics |
|---|---|---|---|---|---|
| `dispatch_issue_assigned` | gauge | count | `Issue.labels` `agent/*` | `lane` | Label-assigned (may be idle) |
| `dispatch_leases_active` | gauge | count | `Lease.expiredAt > now` | — | Live ownership |
| `dispatch_lease_age_seconds` | histogram | seconds | `now - Lease.renewedAt` / `createdAt` | — | How long ownership has been held |
| `dispatch_leases_expired` | gauge | count | `Lease.expiredAt <= now` | — | Ownership past TTL (recoverable) |
| `dispatch_assigned_without_execution` | gauge | count | assigned (`agent/*`) and no active lease/`AgentWork` | `lane` | Assignment that never became execution. **Dashboard aggregate — must not fire alerts.** Steady assignment churn keeps it above zero continuously even when every assignment is picked up within seconds, and per-item waiting age is not derivable from persisted columns (`Issue` has no `assignedAt`; `updatedAt` is refreshed by any GitHub change at `src/lib/issue-sync.ts:115`, `lastSyncedAt` by claims/webhooks). See A6's future-gap pinning and §8.7 |
| `dispatch_execution_active` | gauge | 0/1 | derived: an unexpired `Lease` **or** an `AgentWork` in `CLAIMED`/`IN_PROGRESS` exists, **counted for worker identities only** (see the system-emitter exclusion below) | — | Something is executing right now. Used as the A4 in-flight guard: a task picked up before the pickup window still suppresses A4 for its whole duration. `BLOCKED` AgentWork rows are deliberately excluded — blocked work is active (§4.4) but not flowing, and must not mask an otherwise idle fleet |

`DEFAULT_LEASE_TTL_MS = 30 min` (`src/lib/lease.ts:18`). Lease active means
`expiredAt > now`; there is no lease status column — the issue's status label is
the state (`src/lib/lease.ts:99-112`). Orphan leases are released and audited:
a corrupted checkpoint at `src/lib/lease.ts:168-180`, and a lease whose
referenced issue is missing at `src/lib/lease.ts:191-204`.

**System-emitter exclusion.** The hosted groomer takes its own lease without any
worker involvement (`upsertLease({ agentName: "hosted-groomer", … })`,
`src/lib/groomer/run.ts:250-254`) on its normal schedule, and it writes
`AgentRun` rows with `runType: "groom"` as internal bookkeeping
(`src/lib/groomer/run.ts:1196-1200`). The heartbeat endpoint likewise writes an
`AgentRun` row per poll with `runType: "heartbeat"`
(`src/app/api/agents/[agentName]/heartbeat/route.ts:100-104`) for the worker's
own identity, and the legacy ingestion route accepts client-supplied run types
(`src/app/api/agent-runs/route.ts:78`). These are not task flow: groomer leases
and every non-task `AgentRun` row must be excluded from
`dispatch_execution_active`, `dispatch_work_pickups_in_window`, and
`dispatch_agent_runs_reported_in_window` — the last by **allowlisting task run
types** (`implement`, `followup-pr`) rather than subtracting `groom`, so a
heartbeat-only, zero-delivery fleet cannot keep the reported gauge above zero.
Otherwise a running groomer or a merely polling fleet makes the fleet look
permanently busy. The exclusion is an exporter-side filter on
`agentName`/`runType`, never a metric label (§9).

### 4.4 AgentWork lifecycle

| Signal | Kind | Unit | Source | Dimensions | Semantics |
|---|---|---|---|---|---|
| `dispatch_agent_work` | gauge | count | `AgentWork.state` | `state` (`CLAIMED`,`IN_PROGRESS`,`BLOCKED`,`DONE`,`RELEASED`,`STALE`,`unknown`) | Active + terminal work rows |
| `dispatch_agent_work_checkpoint` | gauge | count | `AgentWork.checkpoint` | `checkpoint` (8-value enum) | Progress distribution |
| `dispatch_agent_work_heartbeat_age_seconds` | histogram | seconds | `now - AgentWork.lastHeartbeatAt` | `state` | Liveness of active work |
| `dispatch_agent_work_stale_total` | gauge | count | `AgentWork.state = STALE` | — | Recovered/stale work |
| `dispatch_agent_work_release_pending` | gauge | count | `staleClaimReleasePending = true` | — | Stale recovery in flight (retryable) |

Enums are fixed: states `CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE`;
checkpoints `CLAIMED, REPO_PREPARED, BRANCH_CREATED, CHANGES_MADE,
TESTS_RUNNING, PR_OPENED, DONE, BLOCKED` (`prisma/schema.prisma:731-749`).
Active states are `CLAIMED/IN_PROGRESS/BLOCKED`; internal AgentWork lease is
5 min (`src/lib/agent-work.ts:168,209`). The stale sweep marks STALE with a
`staleClaimReleasePending` retry marker, releases the GitHub claim, then
finalizes (`src/lib/stale-work.ts`). Sweep defaults: max age 5 min, batch 50.

### 4.5 PR-fix hand-out, acknowledgement, reclaim

The PR-fix queue is a second supply path with its own lifecycle. **An empty
PR-fix listing does not prove there is no assigned issue work** — the two paths
are independent.

| Signal | Kind | Unit | Source | Dimensions | Semantics |
|---|---|---|---|---|---|
| `dispatch_pr_fix_items` | gauge | count | `PrFixQueueItem.status` | `status` (7-value enum), `lane` (3-value enum) | Queue composition |
| `dispatch_pr_fix_oldest_queued_seconds` | gauge | seconds | `now - queuedAt` for `QUEUED` | `lane` | Head-of-line wait |
| `dispatch_pr_fix_fix_attempts` | histogram | count | `PrFixQueueItem.fixAttempts` | `lane` | Attempts per item |
| `dispatch_pr_fix_handout_age_seconds` | histogram | seconds | `now - dispatchedAt` for stamped `QUEUED` | `lane` | Unacknowledged hand-out age |
| `dispatch_pr_fix_unacked_handouts` | gauge | count | `QUEUED`, `dispatchedGeneration = generation`, no matching ack | `lane` | Hand-outs that may be stranded (aggregate, includes both fresh and overdue) |
| `dispatch_pr_fix_overdue_unacked` | gauge | count | subset of unacked where `now - dispatchedAt > PR_FIX_HANDOUT_TIMEOUT_MS` | `lane` | **Age-tied** overdue hand-outs: items past the configured timeout still waiting on an ack. Use this for A7 ([§6](#6-alert-catalogue)) — the aggregate `dispatch_pr_fix_unacked_handouts` is intended for the dashboard view, not for firing alerts, because steady churn keeps it above zero indefinitely even when every hand-out is acknowledged quickly |
| `dispatch_pr_fix_overdue_acked` | gauge | count | QUEUED, current-generation ack present, newest current-generation ack time (dispatch stamp for legacy acks) older than `PR_FIX_ACK_LIVENESS_MS` | — | Stuck acknowledged hand-outs (#1419): the population the dead-owner recovery ladder evaluates. Deliberately NOT an alert — a 24h ack-age window tolerates legitimate long runs, and liveness probes decide the actual reclaim |
| `dispatch_pr_fix_reclaims_total` | gauge | count | `PrFixHistory.action = reclaim` | — | Reopens of stamped-unacked hand-outs |
| `dispatch_pr_fix_handout_reclaims` | histogram | count | `PrFixQueueItem.handoutReclaims` | — | Per-item reclaim count vs cap |

Statuses: `QUEUED, FIXED, BLOCKED, PARKED, STALE, IGNORED, WAITING_EXTERNAL`;
lanes `NORMAL, ESCALATED, NEEDS_HUMAN` (`prisma/schema.prisma:124-138`).
`generation` is the work identity (bumped on a fresh attempt); `fixAttempts` is
bounded by `PR_FIX_MAX_ATTEMPTS` default 5 (`src/lib/pr-fix-queue.ts:549-552`).
Hand-out timeout `PR_FIX_HANDOUT_TIMEOUT_MS` default 30 min; reclaim cap
`PR_FIX_MAX_RECLAIMS` default 3 (`src/lib/pr-fix-queue.ts:579-597`). Past the cap the
item is **PARKED + `no_progress`** — bounded exhaustion, never a human decision
(`src/lib/pr-fix-queue.ts:937-1010`). The `pr-fix-sweep` scheduler job is
default-disabled, so reclaim may be absent in a default deployment, and the
overdue signal can rise without an automated sweeper to drain it — see A7.

### 4.6 PR-fix settlement

| Signal | Kind | Unit | Source | Dimensions | Semantics |
|---|---|---|---|---|---|
| `dispatch_pr_fix_settled_total` | gauge (windowed) | count | `PrFixHistory.action = mark` with a terminal `status` (`FIXED`,`BLOCKED`,`PARKED`,`STALE`,`IGNORED`) | `status`, `outcome`, `type` | How work ended. Exclude `mark` transitions to `QUEUED` (external-wait retry, re-enqueue) so this counts settlements, not every mark |
| `dispatch_pr_fix_human_decisions` | gauge | count | `status = BLOCKED` (outcome `human_decision`) | `lane` | **Genuine** human decisions awaiting a call |
| `dispatch_pr_fix_parked` | gauge | count | `status = PARKED` | `outcome` (`no_progress`,`infra_failure`,`security_failure`) | Operational exhaustion, **not** a human decision |
| `dispatch_pr_fix_stale` | gauge | count | `status = STALE` | — | Upstream PR merged/closed |
| `dispatch_pr_fix_waiting_external` | gauge | count | `status = WAITING_EXTERNAL`, `retryAt` | — | External-dependency wait, with cooldown |
| `dispatch_pr_fix_oldest_human_decision_seconds` | gauge | seconds | `now - updatedAt` for `BLOCKED` | — | Age of the oldest unresolved human decision |

Outcomes: `human_decision, no_progress, infra_failure, security_failure`
(`src/types/index.ts:266`). Types: `MERGE_CONFLICT, CI_FAILURE,
REVIEW_FEEDBACK, OTHER, REBASE` — `REBASE` is the mechanical rebase lane
(#1327): one bounded-attempt rebase task per DIRTY episode instead of a fix
generation, bailed to a human decision on any semantic conflict. The
distinction is load-bearing: **BLOCKED** is a
genuine human decision (carries `needs-human`); **PARKED** is bounded exhaustion
or an operational failure and must not be presented as a decision
(`src/lib/pr-fix-surfacing.ts:175-230`). `WAITING_EXTERNAL` cooldown defaults to
6h (`PR_FIX_EXTERNAL_WAIT_COOLDOWN_MS`, bounded 60s–7d).

### 4.7 Admission and dependency withholding

| Signal | Kind | Unit | Source | Dimensions | Semantics |
|---|---|---|---|---|---|
| `dispatch_queue_withheld` | gauge | count | admission decision (`enforce`) | `reason` (12 reason codes) | Eligible `status/ready` issues withheld |
| `dispatch_queue_admission_mode` | gauge | 0/1 | `DISPATCH_QUEUE_ADMISSION_MODE` | `mode` (`off`,`audit`,`enforce`) | Which mode is active |
| `dispatch_queue_withheld_oldest_seconds` | gauge | seconds | oldest withheld issue age | `reason` | How long work has been withheld |

Reason codes (`src/lib/queue-admission.ts:50-63`): `dependency_blocked,
grooming_unknown, grooming_stale, grooming_issue_changed, grooming_unverified,
grooming_run_missing, grooming_not_applied, grooming_partial,
grooming_readiness_missing, grooming_not_ready, grooming_evidence_mismatch,
escalation_lane_mismatch`. In `audit` nothing is filtered; in `enforce` withheld
items are removed from worker pickup (still listable with `?includeWithheld=true`
as `claimable:false`). PR-fix items are never gated.

### 4.8 Grooming freshness

| Signal | Kind | Unit | Source | Dimensions | Semantics |
|---|---|---|---|---|---|
| `dispatch_grooming_runs_total` | gauge (windowed) | count | `GroomingRun.status`, `stage` | `status`, `stage`, `dry_run` | Grooming activity |
| `dispatch_grooming_freshness` | gauge | count | `Issue.groomedIssueFingerprint` / `groomingStaleAt` | `freshness` (`fresh`,`stale`,`unknown`) | Freshness of applied decisions |
| `dispatch_grooming_backoff` | gauge | count | `Issue.groomingRetryAfter > now` | — | Issues backing off after an unreadable read |
| `dispatch_grooming_stale_reasons` | gauge | count | `Issue.groomingStaleReasons` | `reason` (allowlisted) | Why decisions went stale |

`GroomingFreshnessStatus = unknown | fresh | stale`
(`src/lib/groomer/freshness.ts`). `groomedIssueFingerprint NULL` means freshness
is **unknown** — never groomed since freshness tracking, or the baseline could
not be recorded — and is distinct from `fresh`. `status`, `stage`, and
`applyOutcome` are free strings today (observed `status`: `running, completed,
partial, failed, dry_run_completed, unverifiable, stale`; `stage`: `selected,
context_built, explored, planned, validated, skipped, applied`), so label sets
must be allowlisted with an `unknown` bucket.

### 4.9 Sync and scheduler freshness

| Signal | Kind | Unit | Source | Dimensions | Semantics |
|---|---|---|---|---|---|
| `dispatch_scheduler_up` | gauge | 0/1 | scheduler enabled + token present | — | Scheduler armed at all |
| `dispatch_scheduler_job_last_success_timestamp_seconds` | gauge | unix seconds | `schedulerState().jobs[].lastRunAt` | `job` (8 names) | Last completed tick |
| `dispatch_scheduler_job_overdue` | gauge | 0/1 | `schedulerState().jobs[].overdue` | `job` | No run in > 2× interval |
| `dispatch_sync_last_success_timestamp_seconds` | gauge | unix seconds | newest `IssueSyncRun.completedAt` with `status = "completed"` | `type` | Supply-pipeline freshness. Emitted **only when a completed run exists** — on a fresh deployment with no sync yet there is no series, and absence must be evaluated as stale, not silent (see A2) |
| `dispatch_sync_failures_total` | gauge (windowed) | count | `IssueSyncRun.status = "failed"` | `type` | Failed syncs |
| `dispatch_repo_stale_sync_seconds` | gauge | seconds | `now - AutomationRepo.lastSyncedAt` | — | Per-repo cache staleness (aggregate max) |
| `dispatch_repo_stale_sync_threshold_seconds` | gauge | seconds | derived config: 2× `DISPATCH_SYNC_INTERVAL_MS`, 3600 fallback when the sync job is disabled | — | A13 threshold as a scrapeable series, so packaged rules track the configured interval instead of hard-coding it (same helper as the evaluator default) |
| `dispatch_health_up` | gauge | 0/1 | `GET /api/health` ok | — | Process + DB liveness. The #1255 exporter renders it as `1` whenever the exposition itself is served (the collector needs the database to answer); the down case is observed as a **failed scrape** (`up == 0`), which is how A3 is wired in the packaged rules — a missing series is never coerced to healthy |
| `dispatch_scheduler_healthy` | gauge | 0/1 | derived: `dispatch_scheduler_up == 1` **and** no `dispatch_scheduler_job_overdue == 1` | — | Scheduler armed and every job ticking on time |
| `dispatch_sync_pipeline_state` | gauge | 0/1 per state | operator declaration `DISPATCH_SYNC_PIPELINE` (`auto`/`external`/`off`) + in-process facts (scheduler enabled, sync interval) — **never** sync history | `state` (`armed`,`off`,`unknown`) | Arm state of the issue-sync pipeline under the **declared-topology** model: `armed` = the pipeline is expected to run (freshness IS evaluable; `external` declared, or `auto` with the in-process scheduler ticking), `off` = the operator opted out (`off` declared, or `auto` with the sync interval at `0` — never a fault), `unknown` = it cannot be told (`auto` with no in-process scheduler — never healthy, never stale). Sync history is never evidence: one manual sync is not a pipeline. Exactly one state is 1; the other two are 0 |

Job names (`src/lib/scheduler.ts:88-140`): `sync, groomer, pr-followup,
ci-failures, prune-closed, reconcile, stale-work, pr-fix-sweep`. `overdue`
means no run in more than two intervals; `lastRunAt` is in-process and resets on
restart, so a freshly started process reports `null` until the first tick.

**Sync-pipeline arm state.** `dispatch_sync_pipeline_state` is a *declared +
derived* fact, not a scheduler inference. The in-process scheduler is **off by
default** while external cron/CronJob drivers are a supported topology, so
"is the scheduler armed?" is not the same question as "should the sync
pipeline run?" — inferring the latter from the former suppressed every
sync-freshness alert in exactly the deployments where the pipeline genuinely
runs. The arm state is therefore the operator's **declared topology**
(`DISPATCH_SYNC_PIPELINE`) plus **in-process facts** (is the in-process
scheduler ticking? is a sync interval configured?), and it resolves to one of
three values (`src/lib/sync-pipeline.ts:99`):

- `armed` — the pipeline is expected to run: the operator declared
  `external`, or `auto` with the in-process scheduler ticking. Freshness IS
  evaluable; A2/A4 are armed.
- `off` — the operator opted out (`DISPATCH_SYNC_PIPELINE=off`, or `auto`
  with the sync job disabled, i.e. the interval at `0`). An opt-out is never a
  fault.
- `unknown` — it cannot be told: `auto` with no in-process scheduler running.
  Never healthy and never stale — the freshness judgement is simply
  unavailable.

`auto` (the default) means **"the in-process scheduler decides"**: Dispatch
answers for the topology it can observe. It does **not** mean "guess from what
happened" — sync history is deliberately **not** part of the arm state. A
single one-off manual sync is not a pipeline, and history cannot tell a broken
external driver from a deployment that syncs rarely by design: inferring
"armed" from history turned the default deployment (in-process scheduler off,
`auto`, default 15m interval) into a false CRITICAL A2 thirty minutes after
any manual `POST /api/sync`. The trade-off is explicit — an external driver
that is not declared `external` is reported as `unknown` (never healthy, never
stale) and therefore never pages. An operator running an external driver MUST
declare `external`, and MUST set `DISPATCH_SYNC_INTERVAL_MS` to their own
cadence: the interval defines the freshness window A2/A4 judge (and the A13
threshold), so a driver slower than the interval pages falsely.

The sync-staleness gauge is emitted **only** for an armed pipeline that has
completed at least one sync and has a configured interval — it reads `0` while
the last sync is fresh and `1` once it is older than two intervals. In every
other case (not armed, never synced, no configured interval) the series is
**absent**: no judgement at all, never a coerced `0`.

`IssueSyncRun.status` is a free string whose only persisted values are
`running` (created at lock acquisition, `src/lib/sync-lock.ts:160`),
`completed` (manual and scheduled success paths,
`src/app/api/sync/route.ts:67`, `src/app/api/sync/scheduled/route.ts:151`), and
`failed` (error path, `src/app/api/sync/scheduled/route.ts:227`). There is **no**
`success` value: predicates must match `"completed"`/`"failed"`, allowlist these,
and bucket anything else as `unknown`. Note the coverage gap: the manual-sync
error path returns a 500 **without** persisting `failed`
(`src/app/api/sync/route.ts:80-82`), leaving the row `running` forever — so
`dispatch_sync_failures_total` undercounts manual failures and A2 freshness is
the backstop for them.

### 4.10 Failure and outcome signals

| Signal | Kind | Unit | Source | Dimensions | Semantics |
|---|---|---|---|---|---|
| `dispatch_audit_failures_in_window` | gauge (as-of-scrape) | count | `AuditLog.success = false` **and** `createdAt >= now() - window` | `action` (allowlisted), `window` (allowlisted: `900`, `3600`) | Failed mutations in the previous N seconds, recomputed at scrape time. Evaluated **directly** (e.g. `{window="900"} > 0` for A12) — never via `increase()`, `rate()`, or `delta()` (§4.1). Replaces the earlier `dispatch_audit_failures_total` windowed gauge, which A12 misused through `delta()` |
| `dispatch_agent_runs_total` | gauge (windowed) | count | `AgentRun.runType`, `status` | `run_type`, `status` | Outcome distribution across `AgentRun` rows. **Windowed count only**: the rows are append-only and the window is the reset, so the exporter recomputes the count over the chosen window at each scrape. It is **not** process-monotonic and **must not** be evaluated with `increase()`-style rate functions (§4.1) |
| `dispatch_agent_runs_started_in_window` | gauge (as-of-scrape) | count | `AgentRun.startedAt >= now() - window` | `run_type` (allowlisted), `window` (allowlisted: `1800`, `3600`) | Number of runs whose **reported start time** falls in the previous N seconds, computed at scrape time. Used directly (e.g. `== 0`) — never via `increase()`. Survives process restarts because it is derived from the row timestamp. **Blind spot:** `AgentRun` rows are inserted by `tasks/report` when work *finishes* (`src/app/api/agents/[agentName]/tasks/report/route.ts:571`), and `startedAt` is a retrospective optional field defaulting to report time. A worker still mid-task (running longer than the window) is invisible to this gauge until it reports. It measures *reported starts*, not real-time pickups — do not use it alone to detect "nothing being handed out"; use `dispatch_work_pickups_in_window` / `dispatch_agent_runs_reported_in_window` for that |
| `dispatch_work_pickups_in_window` | gauge (as-of-scrape) | count | new `AgentWork` rows (`AgentWork.createdAt >= now() - window`) **or** newly created `Lease` rows (`Lease.createdAt >= now() - window`), worker identities only (system-emitter exclusion, §4.3) | `window` (allowlisted: `1800`, `3600`) | Work **picked up** in the previous N seconds, recorded at pickup time: `AgentWork` rows are created by `POST /api/agent-work/start` (`src/lib/agent-work.ts:186`) and `Lease` rows by claim via `upsertLease` (`src/lib/lease.ts:69`, `createdAt = DB now()`). Lease *renewals* do not count (they reuse the original `createdAt`) |
| `dispatch_agent_runs_reported_in_window` | gauge (as-of-scrape) | count | task `AgentRun` rows (`AgentRun.createdAt >= now() - window`, `runType` allowlisted to the task types `implement`/`followup-pr` — heartbeat/groom/legacy rows excluded, §4.3) | `run_type` (allowlisted), `window` (allowlisted: `1800`, `3600`) | Completed tasks **reported** in the previous N seconds. Throughput evidence for the canonical loop (next-task → execute → report), which — unlike claim/agent-work — writes no pickup row, so pickups alone under-count a fleet that delivers without materializing a lease. A row lands only at finish, so this gauge cannot see a single task still in flight; that is what `dispatch_execution_active` covers |
| `dispatch_agent_run_failures_total` | gauge (windowed) | count | `AgentRun.status = failed` | `run_type` | Hard run failures |
| `dispatch_scheduler_job_errors_total` | gauge (windowed) | count | job HTTP non-2xx/409 (logs today) | `job` | Requires a future counter; **unknown** today |

`AuditLog.action`, `AgentRun.status`, and `AgentRun.runType` are free strings.
Allowlist the observed values and bucket the rest as `unknown`; never label by
`errorMessage`. The default `window` allowlists shared by
`dispatch_agent_runs_started_in_window`, `dispatch_work_pickups_in_window`,
`dispatch_agent_runs_reported_in_window` (`1800`, `3600`) and
`dispatch_audit_failures_in_window` (`900`, `3600`) cover the alerting needs
in [§6](#6-alert-catalogue); consumers may add other windows but must keep
cardinality bounded.

---

## 5. Dashboard view specification

Backend-neutral. Each view is described by the state predicate it evaluates; the
mapping to panels, queries, or widgets is left to the consumer. Recommended
layout is rows of related signals.

| Row | Views (predicate) | Question answered |
|---|---|---|
| **1. Work supply** | `dispatch_issues` by `status`/`lane`; `dispatch_issues_open_claimable`; `dispatch_issue_age_seconds` p50/p95/max | Is there eligible work, and how old is it? |
| **2. Execution** | `dispatch_issue_assigned`; `dispatch_leases_active`; `dispatch_execution_active`; `dispatch_work_pickups_in_window`; `dispatch_agent_runs_reported_in_window`; `dispatch_agent_work` by `state`; `dispatch_agent_work_heartbeat_age_seconds` | Is assigned work actually executing, and is new work being picked up and reported? |
| **3. Ownership health** | `dispatch_leases_expired`; `dispatch_agent_work` `STALE`; `dispatch_assigned_without_execution` | Is any ownership stale or orphaned? |
| **4. PR-fix supply** | `dispatch_pr_fix_items` by `status`/`lane`; `dispatch_pr_fix_oldest_queued_seconds` | What PR-fix work is queued, and for how long? |
| **5. PR-fix hand-out health** | `dispatch_pr_fix_unacked_handouts`; `dispatch_pr_fix_handout_age_seconds`; `dispatch_pr_fix_reclaims_total` | Are hand-outs reaching and being acknowledged by workers? |
| **6. Settlement** | `dispatch_pr_fix_settled_total` by `status`/`outcome`/`type` | How is work ending? |
| **7. Human decisions** | `dispatch_pr_fix_human_decisions`; `dispatch_pr_fix_oldest_human_decision_seconds`; `dispatch_queue_withheld` by `reason` | What genuinely needs a human, and how long has it waited? |
| **8. Pipeline freshness** | `dispatch_scheduler_job_overdue`; `dispatch_scheduler_job_last_success_timestamp_seconds`; `dispatch_sync_last_success_timestamp_seconds`; `dispatch_repo_stale_sync_seconds`; `dispatch_health_up` | Did the supply pipeline stop? |
| **9. Grooming** | `dispatch_grooming_freshness`; `dispatch_grooming_stale_reasons`; `dispatch_grooming_backoff` | Is the admission gate starved by stale/unknown grooming? |
| **10. Failures** | `dispatch_audit_failures_in_window{window="900"}`; `dispatch_agent_run_failures_total` | Are mutations/runs failing? |

**Separation requirement.** The dashboard must keep these distinct, because
collapsing them produces wrong operator conclusions:

- **Settled/closed** (`FIXED`, `STALE`, `IGNORED`; issues `status/done`) —
  terminal, not work.
- **Awaiting review** (issues `status/in-review`; `WAITING_EXTERNAL`) — active,
  not stuck.
- **Stale claims** (`dispatch_leases_expired`, `AgentWork STALE`) — recoverable
  ownership loss.
- **Blocked dependencies** (`dispatch_dependency_blocked`,
  `withheld: dependency_blocked`) — correct withholding, not a bug.
- **Genuine human decisions** (`BLOCKED` / `human_decision`) — the only class
  that is a request for a person. `PARKED` must not appear here.
- **Operational exhaustion** (`PARKED`) — bounded failure; requeueable by an
  operator, not a design question.

An empty PR-fix listing is a valid state and must not be read as "no work": the
issue queue and the PR-fix queue are independent supply paths. Show both.

---

## 6. Alert catalogue

Conditions are backend-neutral state predicates. `for` is the minimum duration
the predicate must hold before firing (avoid flapping). Severity is a
recommendation; the consumer maps it.

| # | Alert | Condition (predicate) | Enabled | Severity | `for` | Why actionable | Recovery / operator action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Scheduler job overdue | `dispatch_scheduler_job_overdue{job=...} == 1` | yes | critical | 10m | Every queue is fed by these jobs; a stopped timer starves the loop silently | Inspect logs; restart/verify `DISPATCH_SCHEDULER_ENABLED`; supervisor re-arms, but a persistent stop is a real fault |
| A2 | No successful sync | `dispatch_sync_last_success_timestamp_seconds` series **absent** (no `IssueSyncRun` has ever completed — the never-successful first sync must not be silent) **or** `time() - dispatch_sync_last_success_timestamp_seconds > 2× sync interval` — **and** the sync pipeline is armed (`dispatch_sync_pipeline_state{state="armed"} == 1`: the pipeline is expected to run — declared via `DISPATCH_SYNC_PIPELINE` (`external`), or `auto` with the in-process scheduler ticking; an opted-out (`off`) or indeterminate (`unknown`) pipeline is not a fault and is not evaluable) **and** the observation is live (the scrape is succeeding, so a dead instance routes to A3 instead) | yes | critical | 5m | Supply is stale, or has never flowed; issues will not enter the queue. Consumers must evaluate the absent-series case as firing (e.g. `absent(...) == 1` in Prometheus), because `time() - <no data> > x` yields no data, not true | Check `IssueSyncRun` errors and GitHub reachability |
| A3 | Health/DB down | the Dispatch scrape is failing (`up{job="dispatch"} == 0` in the packaged rules; `dispatch_health_up` is rendered by the #1255 exporter as 1-when-served — see §4.9 — so a missing series is the down signal, never an exported 0) | yes | critical | 2m | The service cannot serve work | Check DB connectivity; `/api/health` returns 503 |
| A4 | Eligible work not handed out | `dispatch_issues_open_claimable > 0` **and** `dispatch_execution_active == 0` **and** `dispatch_work_pickups_in_window{window="1800"} == 0` **and** `dispatch_agent_runs_reported_in_window{window="1800"} == 0` **and** `dispatch_sync_pipeline_state{state="armed"} == 1` **and** `(time() - dispatch_sync_last_success_timestamp_seconds) <= 2 × sync interval` **and** the in-process scheduler is either not running (`dispatch_scheduler_up == 0` — an external driver owns the pipeline and has no in-process job that can be overdue) or every scheduled job is ticking (`dispatch_scheduler_healthy == 1`) | yes | warning | 30m | Work exists **and** nothing is executing **and** nothing has been picked up or reported in 30 minutes **and** the in-process scheduler is either not running or every scheduled job is ticking **and** the last sync is fresh enough that A2 would be silent — an idle fleet while work waits, i.e. supply is not reaching workers. Three suppressors cover both delivery modes: a task in flight keeps `dispatch_execution_active` at 1 for its full duration (claim/agent-work workers — see §8.6); a fresh claim/start raises the pickup gauge; and any finished task's report lands in the reported gauge even for the canonical loop (next-task → execute → report), which writes no pickup row. Both gauges exclude the non-task system rows (groomer, heartbeat, legacy ingestion) per the §4.3 filter, so a busy groomer or a merely polling fleet cannot mask an idle fleet — nor disarm A4 the other way. Residual blind spot (documented, not solvable from the DB): a worker that materializes no claim/agent-work and runs a *single* task longer than the window without reporting is invisible while mid-task, and A4 fires; that firing is a truthful "Dispatch cannot observe this fleet" warning, and materializing a claim or agent-work start removes the ambiguity. A *hung* claimed task is caught by A5 and the AgentWork heartbeat-age signal instead. The fresh-sync guard is the explicit spelling of A2-suppresses-A4: a pipeline that ticks on time while sync is failing (or has never completed, so the sync series is absent and the guard cannot pass) no longer satisfies A4, and is routed to A2/A13 instead | Check worker availability/credentials; confirm `next-task` returns `implement`; confirm workers materialize a claim or agent-work start |
| A5 | Stale ownership | `dispatch_leases_expired > 0` or `dispatch_agent_work{state="STALE"} > 0` | yes | warning | 15m | Ownership is lost; the issue may be stuck in-progress | Stale sweep releases it; if it persists, inspect the sweep job (A1) |
| A6 | Assigned without execution | **Future gap — must NOT fire on the aggregate.** Intended predicate: an individual **open, eligible** issue (not `done`/`blocked`) has carried `agent/*` with no active lease/`AgentWork` for longer than a threshold T. Per-item waiting age is not derivable from persisted columns today — label assignment carries no timestamp (`Issue` has no `assignedAt`; `updatedAt`/`lastSyncedAt` refresh on unrelated changes), and only actions-route assignments produce `assign_agent` audit rows (`src/app/api/issues/actions/route.ts:14`; claims audit as `claim_issue` but materialize a lease, so they fall outside this predicate), so a GitHub-side assignment has no age source at all. Firing `dispatch_assigned_without_execution > 0` sustained would misreport healthy churn as failure (§8.7), so this row stays pinned — an exporter that ships an age source promotes it to a real alert (§10) | no — pinned future gap | info (pinned; not firing) | — (T applies only when promoted) | Assigned but never picked up; invisible in a queue-depth-only view. Until the age gap closes, execution-loss detection is owned by A5 (expired leases / STALE work) and pickup starvation by A4/A10 | Verify the worker polls its lane; check admission withholding |
| A7 | Unacknowledged hand-outs (overdue) | `dispatch_pr_fix_overdue_unacked > 0` sustained | yes | warning | 35m | A worker may have died before materializing its run; item is stranded past the configured hand-out timeout. The predicate is age-tied to `dispatchedAt` (per-row `now − dispatchedAt > PR_FIX_HANDOUT_TIMEOUT_MS`), not the aggregate unacked count, so steady churn does not fire | Reclaim sweep (`pr-fix-sweep`, default-disabled) or operator requeue |
| A8 | PR-fix head-of-line | `dispatch_pr_fix_oldest_queued_seconds > threshold` | yes | warning | 30m | Work is queued but not draining | Check worker concurrency, lane routing, and `fixAttempts` saturation |
| A9 | Human decisions piling up | `dispatch_pr_fix_human_decisions > 0` **and** oldest age > threshold | yes | info | 1h | A person must decide; PARKED is excluded so this is real | Review the BLOCKED item's decision context and act |
| A10 | Admission withholding | `dispatch_queue_withheld{reason="grooming_unknown"}` or `{reason="grooming_stale"}` sustained | yes | warning | 1h | The admission gate is starving the queue on missing/stale grooming | Fix grooming pipeline; or operator admission override for a specific issue |
| A11 | Grooming backoff | `dispatch_grooming_backoff > 0` sustained | yes | warning | 30m | Upstream GitHub reads are failing; issues cannot be groomed | Check GitHub reachability/rate limits |
| A12 | Audit failures | `dispatch_audit_failures_in_window{window="900"} > 0` | yes | warning | 5m | Mutations are failing (labels/claims). The predicate evaluates the as-of-scrape 15-minute gauge **directly**, so a new failure fires even when an older one expires from the window at the same moment — a `delta()` over a rolling windowed count could read zero there (§4.1) | Inspect `AuditLog.errorMessage` for the action; **do not** label by error string |
| A13 | Upstream evidence unavailable | `dispatch_repo_stale_sync_seconds > 2× sync interval` (3600 fallback when the sync job is disabled; packaged rules compare against the exported `dispatch_repo_stale_sync_threshold_seconds`) **or** `dispatch_grooming_backoff > 0` | yes | warning | 15m | Admission/settlement decisions lack current evidence; the forge could not be read | Check GitHub reachability/rate limits; treat `unknown` as unknown, never healthy |

The `Enabled` column is the wiring contract: `yes` means a consumer **may**
evaluate the predicate and map it to a rule; `no` means the row documents a known
gap and **must not** be wired into an evaluator. A6 is the only disabled row —
its intended predicate (per-issue assignment age T) and the missing age source
are spelled out in the row itself, and it graduates to `yes` via
[§10](#10-open-questions-and-deferred-decisions) once a per-item assignment age
exists.

### Normal inactivity must NOT alert

- Empty issue queue with `dispatch_issues_open_claimable == 0`: **no alert**.
  An idle fleet is healthy.
- Empty PR-fix listing: **no alert**. It is independent of the issue queue.
- `dispatch_agent_runs_total == 0` when there is no eligible work: **no alert**.
- PR-fix steady-churn where every hand-out is acknowledged within the timeout:
  **no alert** for A7 even though `dispatch_pr_fix_unacked_handouts > 0` — the
  age-tied `dispatch_pr_fix_overdue_unacked` is zero. Aggregate unacked is
  surfaced on the dashboard only.
- Assignment steady-churn where every `agent/*` assignment gains a
  lease/`AgentWork` within seconds: **no alert** for A6 even though
  `dispatch_assigned_without_execution > 0` — see §8.7. A6 is pinned as a
  future gap and never fires on the aggregate.
- No `BLOCKED` items: **no alert**. Absence of a human decision is good.
- No `status/ready` issue with `unknown` freshness (no issue withheld as
  `grooming_unknown`): **no alert**. Never-groomed backlog is not a fault.
- `lastRunAt == null` immediately after process start: **no alert** until at
  least one interval has elapsed.
- A sync pipeline that is opted out or indeterminate (arm state `off` or
  `unknown`): **no alert** — an operator opt-out is not a fault, and "cannot be
  told" is never healthy. `off` is an explicit `DISPATCH_SYNC_PIPELINE=off`,
  or `auto` with the sync job disabled (the interval at `0`); `unknown` is
  `auto` with no in-process scheduler running. A1/A2 (and A4's fresh-sync
  guard) are not evaluable while the pipeline is not armed; the packaged rules
  gate on `dispatch_sync_pipeline_state{state="armed"}` for the same reason.
  A **disabled in-process scheduler alone is not an opt-out**: external
  cron/CronJob drivers are a supported topology, so such a deployment declares
  `DISPATCH_SYNC_PIPELINE=external`.
- Workers mid-task **with the work materialized** (live lease or active
  `AgentWork` row): **no alert** for A4 — in-flight work keeps
  `dispatch_execution_active == 1` for the whole task, independent of when — or
  whether — the worker reports; see §8.6. A claim-less canonical-loop worker
  mid-single-task is the documented blind spot in A4, not this case. A hung
  materialized task is caught by A5 and the heartbeat-age signal, not A4.

Alerts must be gated on **eligible work existing** (A4; A6 is pinned as a
future gap and fires nothing until it gains per-item age) or on a **pipeline
that should have run** (A1–A3, A13) or on an **overdue age** (A7, A8, A9, A11).
"Nothing happened" is not a failure, and "something exists right now" is not
a failure when nothing is past its timeout.

---

## 7. Integration matrix

Optional approaches. **None is required, and none is chosen here.** Neither
Grafana nor Alertmanager is assumed; the dashboard and evaluator are explicit
choices at composition time.

| Approach | Transport | State source | Dashboard choice | Evaluator choice | Cardinality control | Notes / gaps |
|---|---|---|---|---|---|---|
| **A. Pull exporter (Prometheus / VictoriaMetrics)** | HTTP `/metrics` scrape | Read-only DB queries (state gauges, as-of-scrape windowed gauges, windowed counts over append-only tables) | Any (Grafana, VM UI, custom) | Prometheus rules / vmalert / custom | Enforce label allowlists at the exporter | Needs a new read-only exporter; no in-process counters exist. Evaluate "did anything happen in the last N" predicates **directly** against the as-of-scrape `_in_window` gauges — never `increase()` (any series here is non-monotonic) and never `delta()` over an already-windowed count (window roll can cancel a fresh event to zero); `delta()` is sound only if the exporter instead emits cumulative totals (§4.1) |
| **B. OTel push metrics** | OTLP push | Same as A, emitted as OTel instruments | Any OTel-compatible backend | OTel-native or downstream | Use OTel attribute allowlists; avoid high-cardinality attributes | Adds an OTel SDK/dependency; exporter/collector choice deferred |
| **C. OTel logs/events** | OTLP logs | `AuditLog`, `PrFixHistory`, `AgentRun`, `IssueSyncRun` as events | Any log backend | Backend rules | Event attributes may carry IDs; **keep them out of metric labels** | Good for drill-down; not a substitute for gauges |
| **D. Snapshot API** | HTTP JSON | A read-only `GET` that returns the catalogue as JSON | Any | Any | Consumer controls | Optional convenience; would be a small, separately-scoped implementation |
| **E. Direct SQL / warehouse** | Batch | Postgres read replica | BI tool | BI/scheduled queries | Query-side | Couples to schema; acceptable for operators who already run a warehouse |

**Recommended composition:** A or B for state gauges and windowed totals; C for
drill-down. Exporter, collector, dashboard, and evaluator choices are
**deferred** ([§10](#10-open-questions-and-deferred-decisions)). Correlation with
an external connector is done at the consumer by joining on an exported
identifier (e.g. repository + issue number), never by requiring a shared ID in
Dispatch.

---

## 8. Worked examples for a non-Courier consumer

These illustrate interpretation for a consumer that knows nothing about Courier.
Values are illustrative.

### 8.1 Healthy

```
dispatch_health_up                                  1
dispatch_scheduler_up                               1
dispatch_sync_pipeline_state{state="armed"}        1
dispatch_scheduler_job_overdue{job="sync"}          0
dispatch_sync_last_success_timestamp_seconds        (2m ago)
dispatch_issues{status="ready",state="open"}        12
dispatch_issues_open_claimable                      9
dispatch_leases_active                              4
dispatch_agent_work{state="IN_PROGRESS"}            4
dispatch_agent_work{state="STALE"}                  0
dispatch_pr_fix_items{status="QUEUED"}              3
dispatch_pr_fix_unacked_handouts                    0
dispatch_pr_fix_human_decisions                     1
```
**Read:** supply is flowing, execution is live, ownership is fresh, hand-outs
are acknowledged. A1–A8 and A10–A13 silent; A9 fires only if the one human
decision has aged past the threshold. This is the expected steady state.

### 8.2 Idle

```
dispatch_health_up                                  1
dispatch_scheduler_up                               1
dispatch_sync_pipeline_state{state="armed"}        1
dispatch_scheduler_job_overdue{job="sync"}          0
dispatch_issues_open_claimable                      0
dispatch_agent_work{state="IN_PROGRESS"}            0
dispatch_pr_fix_items{status="QUEUED"}              0
dispatch_agent_runs_total{run_type="implement"}     0
```
**Read:** nothing to do. No alert should fire. In particular, A4 must be gated
on `open_claimable > 0`, and empty PR-fix must not alert. This is the example
that most often produces false alarms if inactivity is treated as failure.

### 8.3 Degraded — scheduler stopped, work piling up

```
dispatch_health_up                                  1
dispatch_scheduler_up                               1
dispatch_sync_pipeline_state{state="armed"}        1
dispatch_scheduler_job_overdue{job="sync"}          1     # last tick 45m ago, interval 15m
dispatch_sync_last_success_timestamp_seconds        (45m ago)
dispatch_issues_open_claimable                      20
dispatch_execution_active                                   0     # nothing executing
dispatch_work_pickups_in_window{window="1800"}             0     # nothing picked up
dispatch_leases_expired                             2
dispatch_agent_work{state="STALE"}                  2
dispatch_queue_withheld{reason="grooming_unknown"}  6
```
**Read:** A1 (scheduler overdue) and A2 (no sync) fire first. A4 does **not**
fire here: its `dispatch_scheduler_healthy == 1` guard is false while A1 is
active, **and** the fresh-sync guard `(time() - dispatch_sync_last_success_timestamp_seconds) <= 2 × sync interval` fails because the last sync is 45m ago against a 15m interval. A stopped pipeline is therefore routed to A2 (sync freshness) and never to A4, so it is not misreported as a worker problem. A5 fires on the expired leases/stale work. A10 fires on sustained `grooming_unknown` withholding. The operator checks the scheduler logs, then the grooming pipeline.
Recovery is `sync` re-arming; the stale sweep recovers ownership. Once the
scheduler is healthy again AND the sync is fresh, A4 becomes the relevant
signal if work still is not picked up.

### 8.4 Degraded — worker hand-outs stranded (PR-fix)

```
dispatch_pr_fix_items{status="QUEUED"}              8
dispatch_pr_fix_unacked_handouts                    5
dispatch_pr_fix_overdue_unacked                     5
dispatch_pr_fix_handout_age_seconds{quantile="0.5"} 2400   # 40m > 30m timeout
dispatch_pr_fix_reclaims_total                      2
dispatch_agent_runs_total{run_type="followup-pr"}   1
```
**Read:** A7 fires — the **age-tied** `dispatch_pr_fix_overdue_unacked` is 5
(the same items the histogram counts above the timeout). Either
workers are not acknowledging (they should after durably materializing a run),
or the reclaim sweep is disabled (default). Recovery: enable the reclaim sweep
or have an operator requeue. This is distinct from A8 (head-of-line age) and
from A9 (a human decision).

### 8.5 Healthy — PR-fix steady churn (A7 must NOT fire)

```
dispatch_pr_fix_items{status="QUEUED"}              3
dispatch_pr_fix_unacked_handouts                    2     # recent hand-outs exist
dispatch_pr_fix_overdue_unacked                     0     # none past timeout
dispatch_pr_fix_handout_age_seconds{quantile="0.5"} 30    # < 60s old
dispatch_pr_fix_reclaims_total                      0
dispatch_agent_runs_total{run_type="followup-pr"}   47
```
**Read:** workers are acknowledging quickly and there is no stranded work. A7
must **not** fire even though `dispatch_pr_fix_unacked_handouts > 0`. The
earlier counter-style predicate was hazardous for exactly this steady-churn
state — the aggregate held above zero whenever any item was recently handed
out, even with every individual hand-out acknowledged within seconds. The
age-tied `dispatch_pr_fix_overdue_unacked` is zero, so A7 stays silent and the
unacked aggregate is correctly surfaced on the dashboard only.

### 8.6 Healthy — long-running worker, no report yet (A4 must NOT fire)

```
dispatch_health_up                                  1
dispatch_scheduler_up                               1
dispatch_sync_pipeline_state{state="armed"}        1
dispatch_scheduler_job_overdue{job="sync"}          0
dispatch_sync_last_success_timestamp_seconds        (6m ago)
dispatch_issues_open_claimable                      7     # backlog exists
dispatch_execution_active                           1     # AgentWork IN_PROGRESS (worker identity)
dispatch_leases_active                              1     # kept live by the worker's re-claim renewal (src/lib/lease.ts:55-57)
dispatch_agent_work{state="IN_PROGRESS"}            1
dispatch_agent_work_heartbeat_age_seconds           40    # seconds — checkpoint heartbeat extends lastHeartbeatAt (src/lib/agent-work.ts:220-227)
dispatch_work_pickups_in_window{window="1800"}     0     # the pickup was 45m ago
dispatch_agent_runs_reported_in_window{window="1800"}  0 # nothing finished/reported yet
dispatch_agent_runs_started_in_window{run_type="implement", window="1800s"}  0  # no report row exists at all
```
**Read:** one worker picked up an implement task 45 minutes ago and is still
executing; the backlog is real but the fleet is not idle. A4 must **not** fire:
`dispatch_execution_active == 1` fails its in-flight guard even though all
three 30-minute window gauges are zero. This is the state a
*reported-starts*-only predicate misfires on, because `AgentRun` rows — and
their optional retrospective `startedAt` — only exist once `tasks/report`
lands. If this worker died mid-task, its checkpoint heartbeats stop, the
agent-work sweep marks the row `STALE` (§4.4) and the lease expires — A5 fires
on stale work/expired ownership; a live-but-silent worker is caught by the
`dispatch_agent_work_heartbeat_age_seconds` trend — not A4. Only when nothing
is executing, nothing new is picked up, **and** nothing is reported does A4
become the relevant alert. (A fleet that delivers through the canonical loop
without ever materializing a claim or agent-work row is unobservable mid-task;
see the blind spot stated in A4.)

### 8.7 Healthy — assignment steady churn (A6 must NOT fire)

```
dispatch_health_up                                  1
dispatch_scheduler_up                               1
dispatch_sync_pipeline_state{state="armed"}        1
dispatch_sync_last_success_timestamp_seconds        (3m ago)
dispatch_issues{status="ready",state="open"}        5
dispatch_issue_assigned                             3     # label-assigned supply
dispatch_assigned_without_execution                 1     # just assigned; gains a lease <60s later
dispatch_leases_active                              2
dispatch_execution_active                           1
dispatch_work_pickups_in_window{window="1800"}     4
dispatch_agent_runs_reported_in_window{window="1800"} 3
```
**Read:** workers label-assign, then pick up within seconds, so the
`dispatch_assigned_without_execution` aggregate is nonzero at most scrapes —
each individual assignment waits under a minute, but the waits overlap. A
`for: 30m` timer over the aggregate does not help: overlapping short waits keep
it *continuously* nonzero and an aggregate-fired A6 would alert on a perfectly
healthy fleet. This is the same false-positive class the A7 review fix removed by
making the predicate age-tied, but A6 has no age-tied equivalent today: label
assignment carries no persisted timestamp, so per-item waiting age cannot be
computed (see A6's future-gap pinning and §10). This state must **not** alert;
real ownership loss here is caught by A5 (expired lease / `STALE` work) and
pickup starvation by A4/A10.

---

## 9. Privacy, cardinality, and security

- **Label allowlists only.** Metric labels are drawn from fixed enums: status,
  lane, reason code, job name, run type, state/checkpoint. Anything else is
  `unknown`.
- **Never label by** repository name (unless the tracked-repo set is small and
  operator-approved), issue/PR number, task ID, commit SHA, credential, agent
  name (potentially sensitive), or error string. These belong in logs/events and
  drill-down views.
- **No secrets or PII** in metric names, labels, or exported events. Token tiers
  and identities are never exported.
- **Auth:** the health endpoint is public; everything else is authenticated
  (bearer maintainer/worker, Basic, OIDC, or signed webhook). Any future
  exporter must be read-only and scoped accordingly; it must not accept
  mutations.
- **Source-of-truth caveat:** signals reflect Dispatch's cache. Label-driven
  state is authoritative on GitHub and can lag; do not present cache state as
  forge state in an alert that requires a human to act on the forge.

---

## 10. Open questions and deferred decisions

Exporter and dependency choices are **explicitly deferred**; this document is a
design, not a decision.

- **Exporter shape:** pull exporter (A) vs OTel push (B) vs snapshot API (D).
  Trade-offs: pull is simple and scrape-native; push fits an existing collector;
  a snapshot API is vendor-neutral but adds an endpoint.
- **Counter modeling:** since Dispatch has no in-process counters, decide
  whether DB-derived totals are as-of-scrape windowed counts or exported
  cumulative totals (the only shape `delta()` is sound on — §4.1), and how the
  consumer evaluates them.
- **Repo dimension:** whether `repo` is a bounded, acceptable label (small,
  configured tracked set) or must be aggregated.
- **Scheduler state is in-process** (`globalThis`) and resets on restart; decide
  whether to persist last-run timestamps for cross-restart freshness.
- **GitHub-native state** (native `blocked_by` links, PR review/merge state) is
  read through the forge; decide how to represent `unknown` when a read fails
  without writing back to Postgres.
- **Free-string dimensions** (`AgentRun.status`, `GroomingRun.status/stage/
  applyOutcome`, `PrFixHistory.action`, `AuditLog.action`) need a published
  allowlist with an `unknown` bucket, or conversion to enums in a later change.
- **Reclaim observability:** the `pr-fix-sweep` job is default-disabled, so
  reclaim signals may be absent; decide how to surface that state explicitly.
- **Acknowledgement gap:** issue claims have no ack (only PR-fix hand-outs do);
  decide whether stale-claim detection is sufficient without one. Related: the
  canonical loop (next-task → execute → report) writes no pickup row, so A4's
  mid-task visibility depends on workers materializing a claim or agent-work
  start ([§6 A4](#6-alert-catalogue) documents the residual blind spot).
- **Assignment age source (A6 graduation):** A6 is pinned as a future gap
  because "assigned without execution" has no per-item age. Candidate sources:
  persist an `assignedAt`-style timestamp when an `agent/*` label first appears
  in the sync diff (covers GitHub-side and Dispatch-side assignments alike),
  or derive age from `assign_agent` AuditLog rows (covers only actions-route
  assignments — GitHub-side label adds never hit the audit path, and claims
  audit as `claim_issue` but materialize a lease, so they are outside A6's
  predicate). No AuditLog
  pruning exists today, but retention must be settled before a join-based age
  is relied on. Decide before unpinning A6 ([§6 A6](#6-alert-catalogue), §8.7).
- **Retention and windowing:** how long event tables feed windowed totals, and
  whether the exporter queries the primary or a replica.
- **OTel semantic conventions:** whether to map to standard metric/log
  conventions or keep Dispatch-prefixed names.

---

## 11. Design self-verification

Because this document is design-only, its invariants are enforced by an
executable check at `docs/observability.test.ts`, run as part of `npm run test`
— not by production code, which has no exporter yet.

- **Alert structure:** alert IDs `A1`–`A13` appear exactly once, every row has
  the required columns, and the required cells are non-empty.
- **Enablement contract:** disabled rows carry no `for` duration and a severity
  of `info`, so a `no` row can never look like a live rule.
- **Rate functions:** no alert condition evaluates a signal with `increase()`,
  `rate()`, or `delta()` (§4.1).
- **Signal closure:** every `dispatch_*` signal named in an alert condition is
  defined in the [§4](#4-signal-and-state-catalogue) catalogue.
- **Citation drift:** every `file:line` citation in this document resolves to an
  existing file and an existing line, so a refactor that moves code fails here.
- **Source drift:** the `IssueSyncRun.status` values the predicates match are
  exactly the values the source writes.

This verifies **structure and source drift only**. It does not exercise alert
runtime behavior: the snapshot exporter (#1252) is tested against this
catalogue by the unit suites for `src/lib/observability-signals.ts` and
`src/lib/observability-snapshot.ts`. Since #1255, the opt-in scrape exporter
(`src/lib/observability-export.ts`), the portable alert evaluator
(`src/lib/observability-alerts.ts`, with the replayable acceptance fixtures),
and the optional-asset drift contract (`src/lib/observability-assets.test.ts`)
have their own suites; OTel transport and notification routing remain
deferred ([§10](#10-open-questions-and-deferred-decisions)).
