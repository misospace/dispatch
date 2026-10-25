# Dispatch standalone observability — optional deploy assets (#1255)

This directory holds **optional** assets for alerting on and visualizing the
signals Dispatch already exports. Everything here is deploy-tooling: the
upstream semantics live in [docs/observability.md](../docs/observability.md),
the metric contract in
[docs/observability-packaging.md](../docs/observability-packaging.md), and the
portable alert definitions + evaluator in
[`src/lib/observability-alerts.ts`](../src/lib/observability-alerts.ts).
Nothing in this directory is required to run Dispatch.

## What is core vs optional

| Piece | Where | Required? |
|---|---|---|
| Signal catalogue + snapshot API | `GET /api/observability` (#1252) | Shipped |
| Metrics exposition | `GET /api/metrics` (opt-in: `DISPATCH_METRICS_ENABLED=true`) | Shipped, off by default |
| Portable alert definitions + evaluator | `src/lib/observability-alerts.ts` (+ replayable fixtures in tests) | Shipped |
| Prometheus/VictoriaMetrics rule rendering | `observability/prometheus-rules.yaml` | Optional asset |
| Grafana dashboard | `observability/grafana-dashboard.json` | Optional asset |
| OTel push transport | documented option only | Not packaged |
| Notification routing (Alertmanager, pager, …) | deployment-owned | Not packaged |

## Quick start (Prometheus + Grafana)

1. Enable the exporter on your Dispatch instance:

   ```env
   DISPATCH_METRICS_ENABLED=true
   ```

   If a cron/k8s CronJob drives the sync instead of the in-process scheduler,
   also declare the topology so the sync-freshness alerts can fire:

   ```env
   DISPATCH_SYNC_PIPELINE=external
   DISPATCH_SYNC_INTERVAL_MS=900000
   ```

   `auto` (the default) means "the in-process scheduler decides" — armed when
   it is ticking, off when the sync job is disabled, unknown otherwise; sync
   history is never evidence (one manual sync is not a pipeline). `external`
   states it outright (set `DISPATCH_SYNC_INTERVAL_MS` to your driver's
   cadence — the interval defines the freshness window the alerts judge, and
   it defaults to 15m when unset, so a slower driver pages falsely); `off` is
   an explicit opt-out.

2. Scrape it (maintainer-tier bearer token; the endpoint is read-only):

   ```yaml
   scrape_configs:
     - job_name: dispatch
       metrics_path: /api/metrics
       scheme: https
       authorization:
         type: Bearer
         credentials: <DISPATCH_AGENT_TOKEN>
       static_configs:
         - targets: ["dispatch.example.internal:3000"]
   ```

   VictoriaMetrics/vmagent scrape the same exposition unchanged. The job must
   be named `dispatch` (or adjust the `A2`/`A3` rule selectors:
   `up{job="dispatch"}` and A2's `absent()` selector), and the job should have
   exactly one target — the A2/A4 conjunctions match label-insensitively, so
   multiple targets under one job could mix states across instances.

3. Install the rules — copy `prometheus-rules.yaml` into your `rule_files`
   path (Prometheus) or feed it to `vmalert`. Alert names are the catalogue
   ids `A1…A13` (A6 is deliberately absent — see the header of the rules
   file). Tune the `3600`-second thresholds in A8/A9 to taste.

4. Import `grafana-dashboard.json` (Grafana → Dashboards → Import) and pick
   your Prometheus datasource at the `datasource` variable.

## Backend / evaluator matrix

| Composition | State source | Rules | Dashboard | Notes |
|---|---|---|---|---|
| Prometheus + Grafana | `/api/metrics` pull | `prometheus-rules.yaml` | `grafana-dashboard.json` | The packaged reference composition |
| VictoriaMetrics (vmalert + vmui) | same pull | same rules file | import the same JSON | Drop-in compatible |
| Any backend, no rules engine | `/api/metrics` or `GET /api/observability` JSON | evaluate `evaluateObservabilityAlerts()` from `src/lib/observability-alerts.ts` yourself | build your own | The evaluator is pure and replayable; fixtures double as documentation |
| OTel push | not packaged | — | — | Documented option in docs/observability.md §7; remains a deferred decision |

## Security boundaries

- `/api/metrics` is **read-only** and **maintainer-tier authenticated**; it
  cannot requeue, claim, release, or touch credentials, and the response
  carries no repository, issue, agent, or error-string dimensions by
  construction (docs/observability.md §9).
- Dashboards and rules cannot escalate privilege or release claims: they
  observe. Any "release" action remains a separate, authenticated, audited
  Dispatch API call made by a human or the operator's own tooling.
- The exporter is disabled unless `DISPATCH_METRICS_ENABLED` is exactly
  `"true"`; a 404 answers while disabled.

## What alerts — and what must not

Healthy idle is not a page: an empty queue, an empty PR-fix listing, and
quiet windows are zero-valued gauges, never alerts. The alertable predicates
and their gating (fresh-sync guard for A4, age-tied A7, absent-series A2) are
defined in docs/observability.md §6 and enforced by the fixture matrix in
`src/lib/observability-alerts.test.ts`. A6 ("assigned without execution") is
disabled by design and absent from the packaged rules.
