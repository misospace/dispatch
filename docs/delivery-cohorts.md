# Delivery cohorts (#1184)

`GET /api/delivery-cohorts` answers the question the per-issue lifecycle
timeline (#1203, [issue-lifecycle-events.md](./issue-lifecycle-events.md)) and
the work-attempt chain (#1183, [work-attempt-chain.md](./work-attempt-chain.md))
cannot: *how do groups of work items compare across full claim-to-merge
cycles*. It derives one `DeliverySample` per work item from the same read
projections those contracts use (the durable `IssueLifecycleEvent` stream plus
the #1183 attempt chain: `AgentRun` execution evidence and PR-fix rounds),
then aggregates them into cohort statistics. The route
(`src/app/api/delivery-cohorts/route.ts`) only performs bounded reads; all
math lives in the pure `src/lib/delivery-cohorts.ts` module
(`deriveDeliverySample`, `aggregateDeliveryCohorts`, `COHORT_DEFINITIONS`).
It requires maintainer-tier credentials (OIDC session, basic auth, or a
maintainer bearer token; worker-tier bearer tokens are rejected with `403`
because the path is not on the worker allowlist); errors are `401` / `403` /
`400` as JSON `{ "error": "..." }`. The read-only page at `/delivery`
(desktop and mobile nav: **Delivery**) renders this contract.

## Parameters and defaults

| Param | Meaning |
|---|---|
| `days` | Window in days, integer `1..365`, default `30`; window is `now - days .. now`. |
| `since` / `until` | Explicit ISO-datetime window boundaries; `until` requires `since`. |
| `repo` | Optional `owner/name` filter (case-insensitive). |
| `groupBy` | `cohort` (default), `model`, `worker`, `runtimeRevision`, `reasoningEffort`, `repository`, `taskType` — one per `CohortGroupDimension`. |
| `includeSamples` | `"1"` (default) / `"0"`; `samples` is omitted when `"0"`. |
| `limit` | Cap on returned samples, default `200`, max `500`. |

## Inclusion and honest stats

- **Window basis**: a sample is included when its first observed claim falls
  inside `since..until`, or when the claim is **unknown** and its done or
  merge evidence falls inside the window — dropping the latter would silently
  bias completion rates downward.
- **Duration percentiles (p50/p90) cover completed items only** (delivery
  `merged` or `closed-unmerged`) with non-null durations. Open and
  unknown-delivery items are excluded from percentiles, **never treated as
  zero**, but stay in `sampleCount`, the completion-rate denominator and the
  `openAges` statistics.
- **Mixed-settings rule**: cohort keys and mixed flags are derived across
  **all** of an item's attempts; a lifecycle spanning more than one value on a
  settings dimension is `mixed` and is **never attributed to the setting
  active at merge time**.
- Merge evidence is only authoritative `pr_merged` lifecycle events — never a
  worker's success report. A merge preceding the first observed claim yields a
  negative `claimToMergeMs` — reported, not hidden.
- Setting changes are observed **per attempt**: an attempt whose runs restart
  under a different runtime/model keeps its first observed value, so an
  intra-attempt config change is not detected (the mixed rule works at
  attempt granularity).

## Response (`dispatch.delivery-cohorts/v1`)

```
{
  schema, definitions,                // COHORT_DEFINITIONS, verbatim
  window: { since, until },           // ISO datetimes
  groupBy, repo,                      // echoed (repo null or the applied filter)
  totals: CohortStats,                // group key "all", over every sample
  cohorts: CohortStats[],             // one per distinct group key
  samples?: DeliverySample[],         // omitted when includeSamples=0; capped by limit
  sampleCount,                        // total samples before the sample cap
  truncated,                          // any bounded read hit its cap (see notes)
  notes                               // machine-emitted caveats, always rendered
}
```

`definitions` is the `COHORT_DEFINITIONS` record from
`src/lib/delivery-cohorts.ts`, verbatim: `units` (milliseconds); `percentile`
(nearest-rank — the value at index `ceil(p/100*n)-1` of the ascending known
values, null when no known values); `window` (`windowSinceMs..windowUntilMs`);
`claimToDone` (completed merged/closed-unmerged samples with non-null
`claimToDoneMs`; open/unknown-delivery items excluded, never zero);
`claimToMerge` (merged samples with non-null `claimToMergeMs`);
`completionRate` (`(merged + closed-unmerged) / sampleCount`; open and
unknown-delivery items stay in the denominator); `firstPass` (`true` when
delivered without fix rounds or failed attempts; `null` when no execution
evidence or still open); `throughput` (`merged count / window days`, 0 when
the window is degenerate); `denominators` (`sampleCount` is the total,
`delivery` counts are per-type, duration stats are filtered subsets);
`workerTime` (sum of samples' `workerTimeMs`, each the **union** of execution
intervals — overlapping runs not double-counted, null with no run evidence);
and `settings` (the mixed-settings rule above).

`CohortStats`: `key`, `sampleCount`, `delivery`
(`{ merged, "closed-unmerged", open, unknown }`), `completionRate` (0..1,
null only for an empty group), `claimToDone` / `claimToMerge`
(`DurationStats | null` — `{ samples, min, max, mean, p50, p90 }` in ms;
null when no known values), `workerTimeMs` (ms, null when no run evidence),
`firstPass` (`{ true, false, null }` counts), `mergedThroughputPerDay`,
`openAges` (`{ count, medianOpenMs, oldestOpenMs }` — open/unknown-delivery
items with a claim anchor), `fixRounds` (`{ total, itemsWithFixes }`),
`waiting` (`{ activeExecutionMs, unclassifiedMs }` — execution vs. the
remainder of claim→done; `activeExecutionMs` is null when no run evidence
exists, never reported as zero) and
`confounders` (`{ mixedSettings, missingMetadata, distinctRuntimeRevisions[],
distinctModels[], distinctWorkers[] }`); a group with more than one model or
revision is flagged so a row can never be read as single-setting evidence.

`DeliverySample`: `issueId` (`"owner/repo#number"`), `repoFullName`,
`issueNumber`, `delivery` (`merged` | `closed-unmerged` | `open` |
`unknown`), `firstClaimAt` / `firstMergedAt` / `doneAt` (ISO or null),
`doneAtProvenance` (`observed` / `backfilled` / `unknown`, or null — the only
milestone carrying provenance), `claimToDoneMs` / `claimToMergeMs` (ms or
null), `workerTimeMs` / `unclassifiedMs` (ms or null), `firstPass`
(`true`/`false`/`null`), `executionAttempts` / `fixRounds` /
`failedAttempts` (counts), `cohortKeys` (all seven group dimensions),
`mixedSettings`, `settings` (single value per dimension, null when mixed /
unknown), `missing` (`claim`/`done`/`merge`/`attempts`/`metadata`),
`excludedFromDurations` (open / unknown-delivery) and `ageMs` (open items).
