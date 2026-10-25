# Dispatch observability packaging (#1255)

How the signal catalogue of [observability.md](./observability.md) is packaged
into an operational dashboard/alert setup, and how to install it. This
document is the **implementation and installation** side; the upstream
semantics (what each signal means, what may alert) stay in observability.md
and are enforced there and in code — they do not depend on any backend choice
made here.

## What is packaged

| Piece | Location | Status |
|---|---|---|
| Snapshot API (`GET /api/observability`) | `src/app/api/observability/route.ts` | Shipped (#1252), always on |
| Metrics exposition (`GET /api/metrics`, Prometheus text 0.0.4) | `src/app/api/metrics/route.ts` | Shipped (#1255), **opt-in**, disabled by default |
| Portable alert definitions + pure evaluator | `src/lib/observability-alerts.ts` | Shipped (#1255) |
| Replayable rule fixtures (acceptance matrix) | `src/lib/observability-alerts.test.ts` | Shipped (#1255) |
| Prometheus/VictoriaMetrics rules | `observability/prometheus-rules.yaml` | Optional asset |
| Grafana dashboard | `observability/grafana-dashboard.json` | Optional asset |
| OTel push transport | — | Documented option (observability.md §7), not packaged |
| Notification routing | — | Deployment-owned; no Alertmanager is assumed or required |

Installation steps live in [observability/README.md](../observability/README.md).

## Enabling the exporter

```env
DISPATCH_METRICS_ENABLED=true
```

Parsing is strict (`=== "true"`, mirroring `DISPATCH_SCHEDULER_ENABLED`) and
fail-closed: the endpoint answers 404 while disabled, before any auth check,
so the surface does not exist unless the operator asks for it.

Authentication is the same maintainer tier as `GET /api/observability`
(bearer `DISPATCH_AGENT_TOKEN`, Basic, or OIDC — `src/lib/auth.ts`); worker
tokens are rejected with 403. The route is read-only: it runs the same
find-only collector as the snapshot API and never writes, requeues, or
releases anything.

Scrape cost note: the collector reads the full `Lease`/`AgentWork` tables per
request (row-bounded by agent×issue uniqueness and the orphan sweep), the same
profile as `GET /api/observability`. A scrape interval of 30s or more is
plenty for every alert in the catalogue; there is no need to scrape
aggressively.

Example scrape config:

```yaml
scrape_configs:
  - job_name: dispatch
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials: <DISPATCH_AGENT_TOKEN>
    static_configs:
      - targets: ["dispatch.example.internal:3000"]
```

## Metric family contract

`exportObservabilityMetrics` (`src/lib/observability-export.ts`) renders the
snapshot deterministically; `observabilityMetricFamilies()` is the declared
family list and `src/lib/observability-assets.test.ts` fails if the optional
assets reference anything outside it. Mapping notes against the §4 catalogue:

- Every series is a **gauge**. Windowed values carry a fixed `window` label
  (`900`/`3600` for failures, `1800`/`3600` for activity) and are recomputed
  at scrape time — **as-of-scrape gauges**: evaluate them directly, never via
  `rate()`/`increase()`/`delta()` (§4.1). The assets test enforces the ban.
- Two labels per catalogue dimension are split into separate families to keep
  label sets honest: `dispatch_issues{status}` / `dispatch_issues_lane{lane}`
  and `dispatch_pr_fix_items{status}` / `dispatch_pr_fix_items_lane{lane}`.
- Some catalogue dimensions are deliberately dropped where the snapshot does
  not derive them: the per-`lane` splits of `open_claimable` /
  `dependency_blocked` / `issue_assigned` / `oldest_queued` (aggregate-only in
  the #1252 snapshot), and the `run_type` split of the started/reported/
  failure windowed gauges (already allowlisted to task types upstream, so the
  split carries no extra information at the scrape).
- The §4 histograms (`dispatch_issue_age_seconds`,
  `dispatch_agent_work_heartbeat_age_seconds`,
  `dispatch_pr_fix_handout_age_seconds`,
  `dispatch_pr_fix_fix_attempts`) are approximated by the bounded gauges the
  snapshot actually derives (oldest-item ages); no fake buckets are emitted.
- `dispatch_agent_run_failures_in_window` renders the catalogue's historical
  `dispatch_agent_run_failures_total` row as a windowed gauge (same rule as
  every windowed count under §4.1).
- **Absent series is load-bearing**: `dispatch_sync_last_success_timestamp_seconds`
  does not exist until the first sync completes — the A2 firing case — and
  null ages omit their series instead of exporting zero. `dispatch_sync_stale`
  is likewise absent while the pipeline is opted out — sync job disabled
  (`DISPATCH_SYNC_INTERVAL_MS=0`) **or** scheduler unarmed
  (`DISPATCH_SCHEDULER_ENABLED` off with the interval left at its default, the
  default deployment) — mirroring the evaluator's A2/A4 `not_evaluable`
  guards: an opted-out pipeline is unknown, never exported as healthy.
- Families with no samples emit nothing; the empty-Dispatch document still
  carries every always-present family with zero values, so a completely idle
  Dispatch **renders** (zeros, not gaps) in any consumer.
- Privacy holds by construction (§9): only allowlisted enum labels appear;
  repository names, issue/PR numbers, agent identities, task ids, and error
  strings have no place in the output type.

## The portable evaluator

`evaluateObservabilityAlerts(snapshot, options)` evaluates the §6 catalogue
(`A1…A13`) against one snapshot and returns a state per row:
`firing | pending | ok | disabled | not_evaluable`, plus `predicateHolds` and
the `since` timestamp.

- **`for` windows** are honoured through the `prior` map (alert id → since):
  thread the previous result's `since` values to turn `pending` into
  `firing` after the catalogue's duration. The evaluator itself is stateless
  and pure, so fixtures replay deterministically and any backend, cron job,
  or script can drive it.
- **`not_evaluable` is explicit**: an unarmed scheduler, a disabled sync job,
  or admission `off` makes the dependent rows unevaluable rather than silently
  healthy. A disabled pipeline is an operator opt-out, never a page.
- **Disabled rows never fire.** A6 is disabled by design: its aggregate stays
  nonzero under healthy assignment churn (§8.7). Its age-tied evidence
  (`assignmentObservation.agedPastThreshold`) is reported for humans, and the
  packaged rules omit the row entirely.
- **Healthy idle is never a page** — the fixture matrix covers the §6
  "normal inactivity" cases end to end.

### Fixture coverage (acceptance)

`src/lib/observability-alerts.test.ts` replays, without a database:

1. aged stranded claim (A5 fires; A6 evidence visible but never armed)
2. overlapping rapidly resolved assignments — no alert (§8.7)
3. prolonged unacked hand-out (A7 arms; fresh churn stays silent, §8.5)
4. zero-actionable queue — healthy idle renders, nothing armed
5. first sync missing (A2 fires from the absent series; A4 suppressed)
6. failed sync (A13 fires; the stale-sync guard suppresses A4, §8.3)
7. real execution outage (A4 under its full conjunction; single-leg
   suppression; groomer/heartbeat emissions cannot mask or disarm it, §4.3)
8. audit failures in a constant-size rolling window (A12 holds at every
   evaluation where a `delta()` would read zero, §4.1)
9. stopped telemetry (A1 fires; A4 suppressed while the scheduler is unhealthy)

`src/lib/observability-assets.test.ts` keeps the optional assets honest:
every `dispatch_*` token in `prometheus-rules.yaml` and
`grafana-dashboard.json` must be an exported family, no rate-style function
may appear, armed rows must equal the enabled catalogue rows with matching
severities and `for` windows, and the idle snapshot must evaluate with
nothing armed.

## Boundaries

- **No privilege escalation, no autonomous release.** Both read endpoints are
  maintainer-tier and read-only; dashboards and rules observe and page, they
  cannot claim, requeue, release ownership, or mutate GitHub state.
- **Cache, not forge.** Signals describe Dispatch's Postgres cache of GitHub
  and can lag between syncs; alerts that require a human to act on the forge
  carry that caveat in observability.md §2/§9.
- **Backend-independent core.** The snapshot API, the exposition, and the
  evaluator carry no Grafana, Alertmanager, Courier, worker-credential, or
  home-ops assumption. Swapping the dashboard product or removing alerting
  entirely changes nothing upstream.
