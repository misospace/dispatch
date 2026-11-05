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
| `pending` | Persisted, not yet submitted (or submission in flight) | Next submission retries, bounded |
| `accepted` | Courier returned an identity (201 or 200-resume) | Never re-admitted; replays return the stored identity |
| `rejected` | Explicit Courier refusal (any 4xx, mirrored in the response status) | Terminal — a new contribution needs a new request |
| `uncertain` | Timeout, network failure, refused redirect, 5xx, or a malformed 2xx body — delivery outcome unknown | Retried with the ORIGINAL key, bounded by `MAX_DELIVERY_ATTEMPTS` (5) |

## Exactly-once rules

1. The row (key + canonical fields + payload digest) is persisted **before**
   the first network call; the Courier call is always rebuilt from the
   persisted row.
2. One idempotency key is one contribution identity: repeated clicks,
   concurrent requests (unique-key race + attempt-count fence), restarts, and
   lost success responses all resolve to the same row and the same key.
3. A changed payload under an existing key is a 409.
4. A deliberate new contribution is a separate explicit submission with its own
   (new) identity.

## Non-goals

Status polling, a browser UI, fork discovery/creation, PR publication logic,
automatic execution retries after a terminal Courier failure, and production
enablement (the feature is off until an operator configures it).
