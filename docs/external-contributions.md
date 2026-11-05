# External contribution requests (#1537, parent #1349)

Dispatch can persist a request to contribute work to an external repository and
submit it — once, exactly — to Courier's HTTP admission API. Dispatch stays
**optional**: nothing in this feature touches ordinary issue scheduling, the
agent queue, or the PR-fix queue, and a missing or broken Courier configuration
only disables submission itself.

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
  endpoint, and never logged, stored, or returned. Every diagnostic is
  token-redacted (`redactSecret`) before it can reach a log line, the ledger,
  the audit log, or a response.
- **No client-selected destination.** The endpoint comes from
  `DISPATCH_COURIER_ADMISSION_URL`; the fetch runs with `redirect: "error"` so a
  redirect can never carry the credential to another URL. The namespace must be
  on the operator-approved `DISPATCH_COURIER_ADMISSION_NAMESPACES` list.
- **No privileged toggles from the browser.** `fresh`/`debug` are Courier
  operator choices and are never part of the payload Dispatch builds.

## Wire contract (Courier #708, at v0.1.18)

`internal/source/adhoc/server.go` accepts `POST /v1/contributions` only. The
`AdmissionRequest` carries `namespace`, `lane`, `baseRepo`, `baseRef`,
`workRepo`, `goal`, optional `upstreamIssue`, and `idempotencyKey`. Responses
contain `run`, `namespace`, `workItemId`, and `resumed` — 201 for creation, 200
for resume.

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
`run`, `namespace`, `workItemId`, `resumed`, `attempts`, and `lastError`.

Delivery statuses recorded on the `ExternalContributionRequest` ledger row:

| Status | Meaning | Retry |
|---|---|---|
| `pending` | Persisted, not yet submitted | Next submission claims the attempt, bounded |
| `in_flight` | One admission attempt is actively being delivered, under a bounded lease (`inFlightUntil`) | Never stolen while the lease is live; other callers get the row back as `in_flight` without a network call |
| `accepted` | Courier returned an identity (201 or 200-resume) | Never re-admitted; replays return the stored identity |
| `rejected` | Explicit Courier refusal (any 4xx, mirrored in the response status) | Terminal — a new contribution needs a new request |
| `uncertain` | Timeout, network failure, refused redirect, 5xx, or a malformed 2xx body — delivery outcome unknown | Retried with the ORIGINAL key, bounded by `MAX_DELIVERY_ATTEMPTS` (5) |

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

## Non-goals

Status polling, a browser UI, fork discovery/creation, PR publication logic,
automatic execution retries after a terminal Courier failure, and production
enablement (the feature is off until an operator configures it).
