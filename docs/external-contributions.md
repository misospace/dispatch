# External contribution requests (#1537, #1538, #1539, parent #1349)

Dispatch can persist a request to contribute work to an external repository and
submit it — once, exactly — to Courier's HTTP admission API. Dispatch then
tracks the Courier run's lifecycle with the read-only status API (#1538).
Dispatch stays **optional**: nothing in this feature touches ordinary issue
scheduling, the agent queue, or the PR-fix queue. A missing or broken Courier
configuration disables submission, tracking, or both, and each gap names
itself.

## Boundaries

- **No upstream mutation from Dispatch.** A supplied `upstreamIssue` (a URL or
  `owner/repo#N` string) is stored verbatim and passed to Courier. Dispatch
  never claims, labels, assigns, comments on, or closes an upstream issue
  because of it.
- **Courier owns contribution policy.** Fork approval, publication authority,
  branch identity, and PR creation are all Courier-side. Dispatch only relays
  the admission request and records what Courier answered. Identity returned by
  Courier is **not** proof of successful execution or publication.
- **Credentials stay server-side.** The admission token is read from
  `DISPATCH_COURIER_ADMISSION_TOKEN`, attached only to the operator-configured
  endpoint, and never logged, stored, or returned. Lifecycle reads use a
  SECOND, read-only credential, `DISPATCH_COURIER_READ_TOKEN` (the counterpart
  of Courier's `contributeAPI.readKeySecret`). Courier admits no read with the
  admission token and submits no admission with the read token, so tracking can
  be handed read-only authority. Every diagnostic is token-redacted
  (`redactSecret`) before it can reach a log line, the ledger, the audit log,
  or a response.
- **No client-selected destination.** The endpoint comes from
  `DISPATCH_COURIER_ADMISSION_URL`; the fetch runs with `redirect: "error"` so a
  redirect can never carry the credential to another URL. The namespace must be
  on the operator-approved `DISPATCH_COURIER_ADMISSION_NAMESPACES` list.
  Tracking derives its status URL from the same configured surface plus the
  stored run identity — nothing else.
- **No privileged toggles from the browser.** `fresh`/`debug` are Courier
  operator choices and are never part of the payload Dispatch builds.

## Wire contract (Courier #708 + #836, at Courier v0.1.26)

`internal/source/adhoc/server.go` accepts `POST /v1/contributions` for
admission. The `AdmissionRequest` carries `namespace`, `lane`, `baseRepo`,
`baseRef`, `workRepo`, `goal`, optional `upstreamIssue`, and `idempotencyKey`.
Responses contain `run`, `namespace`, `workItemId`, and `resumed` — 201 for
creation, 200 for resume.

Lifecycle reads (Courier #836) use `GET /v1/contributions/<run>?namespace=<ns>`
on the same surface, authenticated with the read-only bearer token. The 200
body is a fixed-shape allowlist: `run`, `namespace`, `lane`, `baseRepo`,
`workRepo`, `phase`, `ciParked`, `observedAt`, optional
`publication{branch,headRepo,headSha,pr}`, optional `cause{category,outcome}`,
and optional lifecycle timestamps. The shipped contract does NOT echo
`workItemId` (it is caller-supplied text; Courier's #819 keeps it out). The
`/v1` path prefix is the contract version: Dispatch refuses a 2xx body that
fails this shape instead of guessing it into state.

## API

`POST /api/external-contributions` — maintainer tier (OIDC/basic sessions, or a
maintainer bearer; worker-tier tokens are refused by the tier table).

Request body:

```json
{
  "namespace": "team-alpha",
  "lane": "contribution",
  "baseRepo": "acme/widgets",
  "baseRef": "main",
  "workRepo": "acme/widgets-fork",
  "goal": "Add a widget",
  "upstreamIssue": "https://github.com/acme/widgets/issues/12",
  "idempotencyKey": "optional-stable-key"
}
```

`idempotencyKey` is generated server-side when omitted. The response (201
created / 200 resumed-or-replayed) carries `id`, `idempotencyKey`, `status`,
`run`, `namespace`, `workItemId`, `resumed`, `baseRepo`, `baseRef`, `workRepo`,
`lane`, `goal`, `attempts`, and `lastError`.

Delivery statuses recorded on the `ExternalContributionRequest` ledger row:

| Status | Meaning | Retry |
|---|---|---|
| `pending` | Persisted, not yet submitted | Next submission claims the attempt, bounded |
| `in_flight` | One admission attempt is actively being delivered, under a bounded lease (`inFlightUntil`) | Never stolen while the lease is live; other callers get the row back as `in_flight` without a network call |
| `accepted` | Courier returned an identity (201 or 200-resume) | Never re-admitted; replays return the stored identity |
| `rejected` | Explicit Courier refusal (any 4xx, mirrored in the response status) | Terminal — a new contribution needs a new request |
| `uncertain` | Timeout, network failure, refused redirect, 5xx, or a malformed 2xx body — delivery outcome unknown | Retried with the ORIGINAL key, bounded by `MAX_DELIVERY_ATTEMPTS` (5) |

The response status reports what the submission did:

| Status | When |
|---|---|
| 201 | Courier created the admission |
| 200 | Courier resumed the admission, the row was already accepted, or another attempt holds the row as `in_flight` |
| 400 | The request body is invalid, the namespace is not approved, or Courier refused the request. A refusal keeps the status code from Courier. |
| 409 | The payload conflicts with the request identity that the key already holds, or Courier rejected that identity before |
| 502 | The delivery outcome is unknown. The next submission retries with the same idempotency key. |
| 504 | Courier sent no answer in time. The delivery outcome is unknown. |
| 503 | The admission endpoint, the credential, or the approved namespace list is not configured. The same status applies when the attempt budget is spent and no attempt is live. |

A submission that finds a live attempt answers 200 with `status: "in_flight"`.
The caller polls the same idempotency key. It must not create a new request,
because the running delivery can still succeed.

## Concurrency invariant

Dispatch never intentionally has two live Courier admission HTTP requests for
the same `ExternalContributionRequest` — across processes and Dispatch
instances. An `attemptCount` alone cannot express "an attempt is active" (a
caller reading the already-incremented count would fence successfully and
double-submit), so attempt ownership is durable state:

1. **Atomic claim.** A caller acquires an attempt through ONE conditional
   `updateMany` — atomic at the database, so it holds across instances. The
   claim matches only rows that are `pending` or `uncertain`, or `in_flight`
   with an **expired** lease, and only while `attemptCount <
   MAX_DELIVERY_ATTEMPTS`. Winning it flips the row to `in_flight`, increments
   `attemptCount`, stamps `lastAttemptAt`, and writes a fresh random
   `attemptToken`.
2. **Live lease is never stolen.** A caller that reads (or races on) a row
   whose lease is still live loses the claim and receives the row as
   `in_flight` — no attempt increment, no Courier call, no key or payload
   change. In-memory mutexes are not involved; the database is the
   coordinator.
3. **Bounded lease.** The lease expires `inFlightLeaseMs` after attempt start:
   the configured Courier admission timeout
   (`DISPATCH_COURIER_ADMISSION_TIMEOUT_MS`, default 30s) plus a fixed
   `IN_FLIGHT_LEASE_MARGIN_MS` (5s) so it outlives any response the timeout can
   produce, with margin for inter-instance clock skew (each instance judges
   expiry against its own wall clock; a premature steal is still safe — it
   consumes one bounded retry with the SAME key, which Courier dedupes).
4. **Crash recovery.** If Dispatch dies after claiming an attempt but before
   recording the outcome, the row stays `in_flight` until the lease expires;
   the next submission then recovers it with the SAME idempotency key,
   consuming the next bounded attempt and never creating a second ledger row.
   Recovery needs no background worker or scheduler.
5. **Token-guarded settlement.** An attempt's result applies only while its
   `attemptToken` still owns an `in_flight` row. A recovered newer attempt
   rewrites the token, so a delayed response from a stale attempt (e.g. one
   whose request was retried after recovery) can never overwrite the newer
   attempt's result — it is dropped and the caller reports the row's current
   truth.
6. **A live attempt outranks the attempt budget.** The budget limits how many
   attempts can start. It does not cancel an attempt that is already running.
   While the final attempt holds an unexpired lease, a submission with the
   same key receives the row as `in_flight`. It never receives
   `retry_exhausted`, because the running delivery can still succeed, and
   `retry_exhausted` asks the caller to abandon the identity. The budget still
   bounds the work: a row with an expired lease at the limit reports
   `retry_exhausted`, and no sixth delivery starts.

## Exactly-once rules

1. The row (key + canonical fields + payload digest) is persisted **before**
   the first network call; the Courier call is always rebuilt from the
   persisted row.
2. One idempotency key is one contribution identity: repeated clicks,
   concurrent requests (unique-key race + atomic in-flight claim), restarts,
   and lost success responses all resolve to the same row and the same key.
3. A changed payload under an existing key is a 409.
4. A deliberate new contribution is a separate explicit submission with its own
   (new) identity.

## Lifecycle tracking (#1538)

Submission proves admission. It proves nothing about execution or publication.
Tracking reads Courier's own recorded state and attaches each observation to
the run identity stored on the request row.

### Configuration

| Variable | Meaning |
|---|---|
| `DISPATCH_COURIER_READ_TOKEN` | Read-only bearer credential for status reads. Unset = tracking unavailable; submission keeps working. |
| `DISPATCH_COURIER_TRACKING_STALE_MS` | Age after which non-final evidence is reported `stale` (default 900000 = 15m, clamped 30s–24h). |

The status URL is derived from `DISPATCH_COURIER_ADMISSION_URL` plus the stored
run identity. There is no other destination and no lookup by anything other
than the `run` + `namespace` the admission returned.

### API

All three surfaces are maintainer tier only (absent from the worker allowlist).

- `GET /api/external-contributions` — stored-evidence listing (newest first,
  `?limit=`, max 200). Pure ledger read; works while Courier is unreachable.
- `GET /api/external-contributions/[id]` — one request's stored record and its
  last trustworthy observation. Pure ledger read.
- `POST /api/external-contributions/[id]/refresh` — one bounded status read for
  an accepted request. Only accepted requests are trackable (409 otherwise).

The `tracking` object on every projection:

```json
{
  "state": "published",
  "stale": false,
  "phase": "AwaitingReview",
  "ciParked": false,
  "cause": null,
  "publication": { "pr": "https://github.com/acme/widgets/pull/42", "branch": "courier/…", "headRepo": "bot/widgets", "headSha": "ab12…" },
  "observedAt": "…",
  "phaseEnteredAt": "…",
  "finishedAt": null,
  "checkedAt": "…",
  "lastError": null
}
```

Refresh response statuses:

| Status | When |
|---|---|
| 200 | Observation recorded, a 404 recorded as `expired`, the cooldown window held (`refreshed: false`, `cooldownRemainingMs`), or a newer refresh superseded this read (`refreshed: false`, `superseded: true`) |
| 404 | No such request |
| 409 | The request was never accepted — there is no run identity to track |
| 502 | Identity mismatch refused the observation; nothing was recorded but the diagnostic |
| 503 | Tracking not configured (names the missing piece), or Courier refused / could not answer |
| 504 | Courier sent no answer in time |

### Tracking states

`tracking.state` is derived only from VERIFIED observations (see identity
binding below):

| State | Set when |
|---|---|
| `admitted` | Courier accepted the request; no fresher observation yet, or the run is `Pending`/phase-unstamped |
| `executing` | Phase `Claimed`, `Running`, or `Verifying` (`ciParked` distinguishes a durable CI park) |
| `published` | Courier's own projection recorded a PR (`publication.pr`). A phase name alone never produces this state |
| `completed` | Terminal success (`Done`/`AlreadyDone`) with no PR evidence |
| `failed` | Terminal failure (`Failed`, `NeedsHuman`, `BlockedExternal`), with the bounded `cause{category,outcome}` when Courier recorded one |
| `unavailable` | A refresh failed (refusal, 5xx, timeout, incompatible shape) before any state was ever observed |
| `expired` | A 404 for a run Dispatch admitted, with no final evidence persisted. Explicit lost-run state — never completion |

Rules:

- **Identity binding.** A 200 response must echo the stored `run`,
  `namespace`, `lane`, `baseRepo`, and `workRepo`. Any mismatch refuses the
  whole observation: no phase, no publication, only a field-named diagnostic.
- **Unknown keeps the last state.** The projection value `unknown`, the
  recorded endings `AwaitingReview` (without PR evidence) and `HandedOff`,
  and any unrecognized phase derive nothing new (the CRD enum can gain
  phases; `AwaitingReview` without a recorded PR cannot be asserted as
  published, and `HandedOff` declares neither success nor failure — the
  verbatim `phase` field names the real ending). The one exception is
  `unavailable`: it recorded no evidence, so the first trustworthy
  observation replaces it.
- **Retention is explicit loss.** A 404 is ambiguous by design on the Courier
  side (missing, foreign, or reaped). For a run we admitted it means the
  evidence is gone. Final evidence already persisted (a PR, a success, a
  failure) survives the reaper because we recorded it while readable; the 404
  then only notes the loss. Nothing final yet becomes `expired`.
- **Publication is durable.** Once recorded, a partial later projection never
  erases an earlier publication field.
- **Cause is durable.** The bounded `cause{category,outcome}` is recorded
  once at a run's ending; a later projection without a `cause` block never
  erases it.
- **Refresh is bounded and duplicate-prevented.** One read per row per
  `TRACKING_REFRESH_COOLDOWN_MS` (15s — Courier paces frontends at 15–30s).
  The window is claimed by one conditional `updateMany`, so it holds across
  Dispatch instances; losers get the stored evidence with 200
  `refreshed: false`. The claim timestamp also owns the settlement: an answer
  that arrives after a newer claim took the window is dropped (`superseded`),
  so a slow stale read can never regress the recorded evidence. A refresh
  never re-submits the contribution — every request it makes is a GET. A
  `503 Retry-After` is surfaced to the caller.
- **Missing capability, named.** No read token configured answers 503 with the
  missing piece and leaves submission untouched.

## Operator UI (#1539)

`/contributions` is the browser surface over the four routes above — the
`POST /api/external-contributions` submission route plus the three
stored-evidence routes. It is a
consumer of the existing API and shared projection (`external-contribution-
view.ts`) — it introduces no new write path, no new authority, and no second
state machine. The nav entry ("Contributions") is present on every instance;
an unconfigured surface still renders, naming its gaps.

- **Configuration panel.** Shows what is configured — endpoint PRESENCE,
  approved namespaces, and credential PRESENCE — resolved server-side by
  `projectCourierSurface()`. Credential values have no path into the client
  tree, and neither does the admission endpoint URL itself: it is credential-
  bearing transport configuration (userinfo or token-like query parameters are
  legal in a URL), so the panel renders `configured` / `not configured`, never
  the string. When submission or tracking is disabled, the panel renders the
  same named capability gap the API answers with (503 reasons), never a generic
  failure. The submission form is disabled until the surface is configured.
- **Submission.** One namespace per submission, selectable ONLY from the
  operator-approved `DISPATCH_COURIER_ADMISSION_NAMESPACES` list (the form
  offers no free-text destination and the server re-checks). The form holds
  one client-generated `idempotencyKey` per form session: an in-flight or
  uncertain answer keeps the key so re-submitting retries the SAME identity
  (and says so), while a settled identity (Courier rejection, payload
  conflict, exhausted budget) is rotated so the next edit is a deliberately
  new contribution. The durable half of that identity lives in the LEDGER,
  not the browser: an unsettled (`pending` / `uncertain`) row offers
  **Retry delivery**, which rebuilds the canonical POST from the row's own
  stored fields and replays its recorded key — so a page reload between an
  uncertain delivery and a retry still re-offers the SAME request, never a
  forked identity (the server's payload-digest guard 409s any body that fails
  to match the stored fields). This mirrors the exactly-once rules above; the
  ledger and the atomic claim still decide — the browser only avoids forking
  an identity the caller did not mean to abandon.
- **Queue and detail.** The stored-request listing and one-request detail read
  the ledger routes, which never call Courier; they work while Courier is
  offline. A row shows the delivery status, the derived lifecycle state (plus
  a `stale` marker), and the verbatim Courier phase in detail.
- **Bounded refresh.** Accepted requests offer "Refresh tracking", which calls
  only `POST /api/external-contributions/[id]/refresh` — a GET-shaped settle,
  never a re-submission. A cooldown answer says how long until Courier may be
  asked again; failures render the named reason and leave the stored evidence
  on screen.
- **Honesty rules carried through to the pixels.** A PR link renders only when
  `tracking.publication.pr` exists — an absent PR is never a broken link or a
  placeholder — and only when the recorded value parses as an absolute http(s)
  URL; any other value stays on screen as plain text, never as an href
  (Courier's provenance is not scheme safety). The same http(s)-only gate
  applies to the upstream-issue link. Absence of a lifecycle observation
  renders as `unobserved` (unknown), never as any completion-flavoured state.
  Nothing here creates, merges, or re-derives a PR, and nothing writes
  Kubernetes or GitHub state.

## Non-goals

Fork discovery/creation, PR publication logic, automatic execution retries
after a terminal Courier failure, and production enablement (the feature is
off until an operator configures it). Status polling is NOT a non-goal since
#1538 — see above. A browser UI is NOT a non-goal since #1539 — see
"Operator UI" above.
