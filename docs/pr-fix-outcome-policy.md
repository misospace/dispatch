# PR-fix outcome policy

## Purpose

`needs-human` must mean an actual unresolved design, scope, authorization, or conflicting-requirements decision that automation cannot safely make. Retry exhaustion is not a human decision; it is recorded separately so bounded automation failures do not create false human escalations.

## Outcomes

| Outcome | Meaning | Status | Lane | Surfacing |
|---------|---------|--------|------|-----------|
| `human_decision` | A genuine unresolved decision requiring a person | `BLOCKED` | `NEEDS_HUMAN` | `needs-human` label and `<!-- dispatch-pr-fix-blocked -->` comment rendering the question, options, and evidence |
| `no_progress` | Bounded retry or no-progress exhaustion | `PARKED` | `NORMAL` | Diagnostic `<!-- dispatch-pr-fix-parked -->` comment; no `needs-human` label |
| `infra_failure` | Infrastructure or authentication failure | `PARKED` | `NORMAL` | Diagnostic parked comment; fail closed, not blindly retried |
| `security_failure` | Security failure | `PARKED` | `NORMAL` | Diagnostic parked comment; fail closed, not blindly retried |
| external wait | Worker is waiting on a prerequisite outside Dispatch | `WAITING_EXTERNAL` | Existing lane | No human escalation or attempt charge; retry after cooldown |

The structured outcome is stored on `PrFixQueueItem` and `PrFixHistory`; human decisions may also include `decisionDetail`. A `tasks/report` request may provide `blockReason` and `decision` (`question`, `options`, `evidence`). A bare `outcome: "blocked"` without `blockReason` means `no_progress`, not `human_decision`. An `outcome` supplied on a brand-new `NORMAL`-lane enqueue is advisory and only takes effect if/when the item parks (a fresh item starts `QUEUED`).

## Budgets and recovery

`fixAttempts` counts dispatchable worker executions. Hand-out reclamation (`handoutReclaims`) and `PR_FIX_HANDOUT_TIMEOUT_MS` wall time are separate budgets: a stale hand-out that never reached a worker does not consume an execution attempt. Stale or already-known feedback also consumes no execution budget. No new numeric thresholds are introduced.

An `outcome: "waiting-external"` report (or `WAITING_EXTERNAL` mark with the issued generation) parks work temporarily without implying prerequisite readiness. Queue listings exclude it by default; `include_blocked=true` includes pending external waits as read-only entries with the latest wait note and retry deadline, and does not make them claimable or signal readiness. The bounded `PR_FIX_EXTERNAL_WAIT_COOLDOWN_MS` setting defaults to six hours (accepted range: one minute to seven days). When due, queue discovery conditionally reissues it as a new generation; the next worker rechecks the prerequisite. Under current behavior, this does not increment `fixAttempts` or enforce its cap. (The [recovery design](pr-fix-recovery-policy.md) proposes that a wait interrupted by *new feedback* instead opens a charged fresh attempt.) Repeated report/mark for the same waiting generation is idempotent and does not extend the cooldown. Late marks cannot change the generation.

Under current behavior, automatic enqueue/evidence does not release `BLOCKED` or `PARKED`. An operator explicitly requeues either status, or a maintainer marks the item back to `QUEUED`; requeue releases the parked/blocked state. `FIXED` retains its existing #940 and new-evidence reopen paths. A proposed, not-yet-implemented extension may reactivate *budget-available operational* `PARKED` items on fresh evidence; human `BLOCKED`, fail-closed parks, and cap-exhausted parks stay operator-only. The freshness model, that reactivation policy, and the `WAITING_EXTERNAL` dependency contract are specified in [PR-fix recovery on fresh evidence](pr-fix-recovery-policy.md).

## Safety and reporting

Automatic give-up caps (including attempt, reclaim, refused-`FIXED`, post-dispatch reopen, and failed-report caps) park as `PARKED`/`no_progress`. Infrastructure/authentication and security failures also park, never becoming human design work or being blindly retried. Writes are generation-guarded: a late or stale worker generation cannot overwrite a newer outcome.

Surfaced metrics distinguish `workerExecutions` (`fixAttempts`) from `enqueueRows` (enqueue history-row count). Enqueue, feedback, and sync/history rows are not worker executions.

This policy does not claim the exact freshness root cause of PR #1021. Courier #263, which concerns skipping already-consumed pending heads during discovery/deduplication, is a separate scope and is not implemented by this outcome model.
