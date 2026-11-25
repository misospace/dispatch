# Rebase-only intake (#1532)

The mechanical rebase lane (#1327) hands one bounded rebase at a time to a
local worker. The pool allowlist (`DISPATCH_REBASE_AGENTS`) lists the agent
names that receive that work. It does not prove that the polling client can
run a rebase.

Intake is the handshake between Dispatch and a worker client. The client
declares what it can do. Dispatch answers with an acknowledgment that says
what it granted. Contract version 1 defines one work scope, `rebase-only`,
and one client capability, `rebase-executor` version 1.

A capability is a client-side execution contract. A declaration means "this
client implements that contract". It is proof, not a request.

> **Issue:** [misospace/dispatch#1532](https://github.com/misospace/dispatch/issues/1532)
> **Date:** 2026-11-03

## Request parameters

`GET /api/agents/{agentName}/next-task` accepts three intake parameters.

| Parameter | Accepted value | Meaning |
|---|---|---|
| `work_scope` | `rebase-only` | The poll serves only mechanical rebase work. |
| `work_scope_version` | `1` | The version of the `work_scope` shape. |
| `capabilities` | `rebase-executor:1` | The client implements the mechanical rebase execution contract. |

The rules for the parameters:

- A client sends `work_scope` only together with `work_scope_version`.
- A repeated `work_scope` or `work_scope_version` parameter is refused. Two values cannot both be the scope.
- A scope value is at most 64 characters long.
- `capabilities` is a comma-separated list of `<name>:<version>` tokens. A name is lowercase kebab-case and starts with a letter. A version is a positive integer.
- A client can send `capabilities` more than once. Dispatch joins the values with a comma before it reads them.
- An empty `capabilities` value means the client declared nothing. An empty element inside a declaration is ignored too, so a client that appends the parameter unconditionally is not refused for a token it never sent.
- The declaration is bounded. It is at most 512 characters long and holds at most 16 tokens.

The scope version is separate from the contract version. A scope version pins the shape of one scope. The contract version pins the whole contract.

## Rejections

Every rejection returns HTTP 400. The response body is `{"error": "<message>"}`. Dispatch parses the intake parameters before it reads any queue, so a rejected request touches no queue row.

| Rejection | HTTP 400 message |
|---|---|
| An unknown work scope | `Unsupported work_scope "<value>"; supported: rebase-only` |
| A scope without a version | `work_scope requires work_scope_version` |
| A version without a scope | `work_scope_version requires work_scope` |
| An unsupported scope version | `Unsupported work_scope_version "<value>"; supported: 1` |
| A repeated scope parameter | `Repeated work_scope` or `Repeated work_scope_version` |
| A scope value over the size limit | `work_scope exceeds the size limit (64 characters)` or `work_scope_version exceeds the size limit (64 characters)` |
| A malformed capability token | `Malformed capabilities entry "<token>"` |
| A capability name declared twice | `Contradictory capability declaration for "<name>"` |
| A declaration over the size limit | `capabilities declaration exceeds the size limit` |
| `rebase-only` without the capability | `rebase-only intake requires the rebase-executor:1 capability declaration` |
| `rebase-only` with an unsupported capability version | `rebase-only intake requires a supported rebase-executor capability (v1); requested v<version> is unsupported` |

A rejected declaration is never read as "no contract declared". Reading it that way would widen the queue for a client that asked for a narrower one.

## Capability negotiation

Dispatch answers every declared capability with a verdict.

- `rebase-executor` version 1 is granted.
- `rebase-executor` at any other version is not granted. The reason is `unsupported-version`.
- `pr-ownership-evidence` version 1 is granted (#1569).
- `rebase-model-executor` version 1 is granted (#1674). It extends the mechanical lane with the model-assisted execution contract below; it never replaces `rebase-executor:1`.
- Any known name at any other version is not granted. The reason is `unsupported-version`.
- Any other name is not granted. The reason is `unknown-capability`. An unknown name is not an error. A newer client can declare a capability that this server does not know yet.

A capability that is not granted never unlocks rebase work and never widens the queue.

## The model-assisted rebase capability (#1674)

> **Issue:** [misospace/dispatch#1674](https://github.com/misospace/dispatch/issues/1674)
>
> **Status: Dispatch side implemented.** Model execution also requires a
> *compatible peer* that declares `rebase-model-executor:1` and honors the
> per-hand-out `rebaseModel` grant; see
> [Enablement: compatible peers](#enablement-compatible-peers-and-valid-grants).
> Peer readiness is a deployment choice, not a release-order dependency.

`rebase-model-executor:1` is the advertised client-side execution contract of a
model-assisted rebase worker (Courier's configured-model rebase executor,
misospace/courier#732). It is negotiated — never inferred from a lane name, an
agent name, or a model field in a run event. A client declares it ALONGSIDE
`rebase-executor:1`:

```
capabilities=rebase-executor:1,pr-ownership-evidence:1,rebase-model-executor:1
```

The contract it claims: the mechanical rules stay the fast path; a conflict
outside them is resolved by the lane's ONE configured coordinator model with
ONE bounded model-assisted attempt per episode, no delegation, and no silent
substitution of another provider; publication authority is unchanged (the
existing approved branch, `--force-with-lease`, the repo's own checks).

Three gates authorize model execution, and ALL must pass:

1. The negotiation: the poll declared `rebase-model-executor` at exactly version 1 and Dispatch granted it.
2. The operator pool: the agent name is in `DISPATCH_REBASE_MODEL_AGENTS` — the operator-declared list of workers whose lane is configured for the one coordinator model, concurrency one (the shared rebase-lane admission), no delegation. Fail closed like `DISPATCH_REBASE_AGENTS`: unset or empty admits nobody; a bare `*` is the explicit opt-in.
3. The parent classification at issuance: inside the REBASE admission
   transaction, Dispatch reads the linked issue with `SELECT ... FOR SHARE`
   (`issue.findFirstLocked`), so the decision is serialized against a
   concurrent parent reclassification. Only `NOT_ESCALATED` authorizes the
   model wall and the `rebaseModel` transport block. `ESCALATED` and
   `UNKNOWN` (including a missing or failed locked read — fail closed) withhold
   both. A model-REQUIRED item defers in that case; an initially-mechanical
   item still takes the deterministic REBASE exception, but with the
   mechanical wall only. This is the same ordering guarantee the #1503 lane
   fence uses: a parent flip either commits before the locked read (it sees the
   frontier lane) or blocks on the share lock until the hand-out commits.

### What changes for an authorized poll

A REBASE hand-out to an authorized poll carries two things a
deterministic-only consumer never sees:

- The MODEL-ASSIST instruction wall replaces the mechanical refusal wall in
  `reasons`. The mechanical wall says "do NOT resolve it yourself"; the model
  wall authorizes the one configured coordinator instead. The persisted queue
  row is not modified — the wall is composed per hand-out.
- A versioned transport block on the task:

```json
{
  "rebaseModel": {
    "capability": "rebase-model-executor",
    "version": 1,
    "semanticConflict": {
      "base": "main",
      "files": ["src/enrich_flux.go"],
      "reason": "two-sided code edit outside the mechanical rules"
    }
  }
}
```

`semanticConflict` is the item's bounded semantic-conflict context (base ref,
conflicted paths, bounded reason — the shape of the mechanical attempt's
structured refusal). It is `null` until one is persisted on the row (the
durable episode accounting). The context is transport evidence, never an
authorization.

### What never changes

- A deterministic-only consumer (no model grant, or outside the model pool)
  keeps receiving ordinary mechanical REBASE items with the mechanical wall,
  byte-identical to the pre-#1674 shape, and no `rebaseModel` field.
- A MODEL-REQUIRED item — a REBASE row that carries a semantic-conflict
  context — is never offered to a consumer that fails either gate. The
  candidate defers (stays QUEUED for an authorized poll) with a distinct
  operator-visible count: `N model-required rebase candidates deferred: this
  poll is not authorized for model-assisted rebase (rebase-model-executor:1 +
  DISPATCH_REBASE_MODEL_AGENTS)`. Nothing pretends a configured model ran.
- Provider/head/branch authorization and ownership evidence are untouched. The
  parent issue classification is now read at issuance under a share lock (see
  the third authorization gate above); that read can only WITHHOLD the model
  path — the deterministic REBASE exception keeps working on `ESCALATED` and
  `UNKNOWN`. Model work rides the SAME serialized concurrency-1 rebase lane
  admission as mechanical work; it is not a second lane and not a bypass of
  frontier exclusivity.

## The acknowledgment

A client that declared a scope or a capability receives an `intake` field on the task. A client that declared nothing receives no `intake` field, so an ordinary consumer sees the same response as before.

```json
{
  "intake": {
    "version": 1,
    "scope": "rebase-only",
    "scopeEnforced": true,
    "capabilities": [
      { "name": "rebase-executor", "requested": 1, "granted": true }
    ]
  }
}
```

The fields are:

| Field | Meaning |
|---|---|
| `version` | The intake contract version. It is `1`. |
| `scope` | The honored work scope. It is `"rebase-only"` or `null`. |
| `scopeEnforced` | `true` when Dispatch applied the requested scope. In version 1 it is always `true`. A scope that Dispatch cannot enforce is refused with HTTP 400. |
| `capabilities` | One verdict per declared capability. |

A verdict holds `name`, `requested`, and `granted`. A verdict that is not granted also holds `reason`. The reason is `unsupported-version` or `unknown-capability`.

## The two scopes

### The ordinary scope

A poll without `work_scope` keeps the ordinary queue. Two things changed for it. A REBASE hand-out now needs the `rebase-executor:1` declaration, so a client that declares nothing no longer receives rebase work. A client that declares a capability receives the `intake` field. Every other part of the response is unchanged.

### The rebase-only scope

A poll with `work_scope=rebase-only` serves only queued items whose dispatched lane is `REBASE`.

- It never serves ordinary PR-fix work.
- It never materializes linked-PR work.
- It never serves issue implementation work.

The scope does not depend on the request's lane. A rebase item is mechanical work, not issue-classified work, so the scope sees every queued rebase item whatever lane the request names.

When no eligible item exists, the response is an idle task with the reason `No rebase work available (rebase-only intake)`. When the lane holds an eligible item that this poll did not hand out, the reason names the count: `No rebase work available (rebase-only intake; 1 rebase candidate deferred)`. A deferred candidate is not "no work".

A rebase-only poll from an agent outside the rebase worker pool returns an idle task with the reason `Rebase-only intake refused: agent <name> is not in the rebase worker pool (DISPATCH_REBASE_AGENTS)`.

## The three REBASE hand-out preconditions

A REBASE hand-out is the issuance of one queue item to one agent. It needs all three of these:

1. The agent name is in the rebase worker pool. The pool is the operator-declared list in `DISPATCH_REBASE_AGENTS`.
2. The polling client declared `rebase-executor:1` in that same request.
3. The serialized concurrency-1 admission succeeds. The lane holds one live hand-out at a time.

The capability gate defers the candidate. The item stays QUEUED for a capable poll. The gate never hands the work out and never touches ordinary fix work. An ordinary poll that deferred a rebase candidate names the count and the missing declaration in its idle reason, so an operator sees that the rebase lane stopped dispatching.

The rebase worker pool is fail-closed. An unset or empty `DISPATCH_REBASE_AGENTS` value admits nobody, so no agent is eligible for a REBASE hand-out and the lane stops dispatching. A bare `*` value is the explicit unrestricted opt-in.

## Mixed versions

| Deployment | Behavior |
|---|---|
| New Dispatch with an old Courier | The old client never declares `rebase-executor:1`, so it never receives a REBASE hand-out, even when its agent name is in the allowlist. Its ordinary queue keeps working. The old client's exact declaration bytes (`rebase-executor:1,pr-ownership-evidence:1`) stay fully granted, and its hand-outs carry no `rebaseModel` field. |
| New Courier with an old Dispatch | The old server ignores `work_scope` and answers with ordinary work and no `intake` acknowledgment. The client must treat the missing acknowledgment as "this server does not support the contract". The client must not execute the ordinary task it received. The client must not poll again in a loop. |
| New Courier declaring `rebase-model-executor:1` with an old Dispatch (pre-#1674) | The old server answers the model verdict `granted: false, reason: "unknown-capability"` and fails no request. The client must treat the not-granted verdict as "model-assisted rebase is unavailable here" and behave as deterministic-only. |
| New Dispatch with a Courier declaring `rebase-model-executor:2` | The verdict is `granted: false, reason: "unsupported-version"`. The poll succeeds; model-required work defers for it. |
| New Dispatch with a model-configured Courier that does not gate on the grant | Dispatch withholds the model wall and the `rebaseModel` block on mechanical offers (including frontier parents), but a resolver created from local deployment config can still run its configured model. Such a client is not a compatible peer for this contract: pair it with the model pool only after it validates the grant. |

The rebase lane stays disabled until both peers support the contract.

## The decline protocol

A client can receive a REBASE hand-out that it cannot execute. It declines the hand-out with the `capacity-exhausted` report.

The report carries the `prFixItem` token that Dispatch issued with the hand-out. The token holds `id`, `generation`, and `handoutToken`. The report also carries a `capacity` identifier that names the incapable executor.

```bash
curl -s -X POST -H "Authorization: Bearer $WORKER_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskType":"followup-pr","outcome":"capacity-exhausted","repoFullName":"org/repo","pullRequestNumber":42,"capacity":"provider/model-a","prFixItem":{"id":"prfix-42","generation":1,"handoutToken":"<the token from the task>"}}' \
  "$DISPATCH_URL/api/agents/$AGENT_NAME/tasks/report"
```

The release is fenced to that exact receipt and that exact generation.

- Only the reporting agent's receipt, hand-out record, and ack are removed.
- Other agents' live hand-outs and the dispatch stamps survive.
- The item stays QUEUED at the same generation.
- No retry budget is spent.

The capacity cooldown is bounded by `DISPATCH_CAPACITY_COOLDOWN_MS`. The default is 15 minutes. The cooldown covers the exhausted capacity on that item only, so the item returns to the pool for a compatible consumer.

These workarounds are forbidden:

- Never fabricate completion.
- Never reset a generation.
- Never clear another writer's hand-out.
- Never create a new attempt to work around an incompatibility.

## Bounded recovery for an older peer

A REBASE hand-out that was issued before the upgrade stays valid. The report path is unchanged by this feature, so an old client can still report its outcome.

If the old client cannot execute the work, the operator paths stay available.

- The dead-owner recovery ladder (#1419) reclaims a hand-out whose ack shows no liveness evidence past `PR_FIX_ACK_LIVENESS_MS`. The default is 24 hours.
- An operator can requeue the item with `POST /api/pr-fix-queue/requeue`. That route needs the maintainer tier.

## Frontier exclusivity (#1503)

The escalation-lane exclusivity gate keeps escalation-classified issue work away from a declared-normal consumer.

#1569 made the gate bidirectional: a declared-escalation consumer is also refused work whose linked issue is authoritatively NORMAL, and an UNVERIFIABLE classification now refuses BOTH declared lanes (the unfiltered #1046 poll stays unrestricted on the lane arm). Linked-PR materialization derives the row's lane from the issue's tri-state classification and defers on UNKNOWN instead of falling back to NORMAL. Ownership evidence (original claimant vs hand-out recipient) is specced in [pr-fix-ownership-contract.md](pr-fix-ownership-contract.md).

A REBASE item is the declared mechanical exception to that gate. A conflicted PR is rebase work, not issue-classified implementation work. Its task carries the mechanical instruction wall instead of the issue's implementation semantics. The wall says: rebase onto the base, resolve conflicts mechanically only, push with `--force-with-lease`, and stop for a human on a semantic conflict.

The exception never routes escalation-classified issue work to the local rebase lane.

## Enablement: compatible peers and valid grants

Dispatch ships its half of the contract in this change. Whether model-assisted
rebase actually runs is a property of the **peer deployment**, and it is stated
in capability terms rather than in release-order or issue-state terms.

A peer is compatible with this contract when it:

- declares `rebase-model-executor:1` alongside `rebase-executor:1`, and
- treats a hand-out without an affirmative `rebaseModel` grant at version 1 as
  mechanical work: it does not create a model resolver and does not call a
  model, regardless of local configuration, and
- uses the transported `semanticConflict` context only as evidence, never as
  authorization.

A model-enabled peer that creates its resolver from local deployment
configuration alone is **not** a compatible peer for this contract: Dispatch
withholds the model wall and the `rebaseModel` block on mechanical and
frontier-owned offers, but it cannot disable a resolver the client built
anyway. Operators pair a model worker pool with a peer that validates the
grant; that check is local to the deployment, not a cross-repository gate.

Named compatibility facts:

- Old Dispatch + new Courier: the server answers `granted: false,
  reason: "unknown-capability"`; the client behaves deterministically. No
  request fails and no queue widens.
- New Dispatch + old Courier: the old client's exact declaration bytes stay
  fully granted and its hand-outs keep the mechanical wall with no
  `rebaseModel` field.
- New Dispatch + new Courier: the three authorization gates above decide, and
  an authorized semantic case is transported with the model wall and the
  bounded context.

Feature availability therefore depends on **both peers supporting the
negotiated contract**, never on another repository's PR, issue, release, or
deployment completing.

## Enablement steps

These steps enable one rebase agent. This document changes no production configuration.

1. The Courier peer must implement the contract. It sends `capabilities=rebase-executor:1` on every poll. It sends `work_scope=rebase-only&work_scope_version=1` on the polls of the dedicated rebase agent.
2. The operator names the worker pool. Set `DISPATCH_REBASE_AGENTS=courier-rebase`. The value holds comma or whitespace separated agent names. The names are case-insensitive. An unset or empty value admits nobody.
3. The agent runs with a Courier lane profile that uses the coordinator `litellm/qwen3.8-27b` and concurrency 1. This profile is a Courier setting. Dispatch does not read it.
4. The agent polls with the `capabilities` declaration. A poll without it receives no rebase work.

Model-assisted rebase (#1674) adds two more steps:

5. The Courier peer implements both the model-assist contract
   (misospace/courier#732) and the grant gate: it declares
   `rebase-model-executor:1` on rebase polls, and it creates its model resolver
   only when the hand-out carries an affirmative `rebaseModel` grant. Old or
   un-gated peers are simply deterministic-only; see
   [Enablement: compatible peers](#enablement-compatible-peers-and-valid-grants).
6. The operator names the model worker pool. Set `DISPATCH_REBASE_MODEL_AGENTS=courier-rebase` (the worker whose lane is configured for the one coordinator). Until this variable names an agent, model-required items defer for every poll and the lane stays deterministic-only. Enable it only for a peer from step 5.

## Examples

### Ordinary scope

Request:

```
GET /api/agents/courier/next-task?capabilities=rebase-executor:1
```

Response:

```json
{
  "type": "implement",
  "shouldRun": true,
  "agentName": "courier",
  "lane": "default",
  "issue": {
    "repoFullName": "org/repo",
    "number": 42,
    "title": "Fix the flaky test",
    "url": "https://github.com/org/repo/issues/42"
  },
  "instructions": "Claim or work the assigned issue. Open or update exactly one PR, then stop. Do not merge, groom unrelated issues, or claim another issue.",
  "stopAfter": "One PR is open or updated for the issue. Push remaining work to a follow-up issue.",
  "forbiddenActions": [
    "Merging any pull request",
    "Grooming unrelated issues",
    "Claiming another issue while this one is open"
  ],
  "intake": {
    "version": 1,
    "scope": null,
    "scopeEnforced": true,
    "capabilities": [
      { "name": "rebase-executor", "requested": 1, "granted": true }
    ]
  }
}
```

The `intake` field rides on the task because the client declared a capability. A client that declares nothing gets the same task without the `intake` field.

### Rebase-only scope

Request:

```
GET /api/agents/courier-rebase/next-task?work_scope=rebase-only&work_scope_version=1&capabilities=rebase-executor:1
```

Response:

```json
{
  "type": "followup-pr",
  "shouldRun": true,
  "agentName": "courier-rebase",
  "lane": "NORMAL",
  "pullRequest": {
    "repoFullName": "org/repo",
    "number": 42,
    "url": "https://github.com/org/repo/pull/42"
  },
  "prFixItem": {
    "id": "prfix-42",
    "generation": 1,
    "handoutToken": "<opaque per-hand-out token>",
    "fixType": "REBASE"
  },
  "reasons": [
    "Mechanical rebase: PR dirty against base (#1327)",
    "<the mechanical instruction wall>"
  ],
  "instructions": "Fix the existing pull request. Update it with the requested changes, then stop. Do not merge, open new PRs, or claim another issue.",
  "stopAfter": "The queued PR has been updated with the requested fixes. Push remaining work to a follow-up.",
  "forbiddenActions": [
    "Merging any pull request",
    "Opening a new pull request",
    "Claiming another issue while this PR is queued"
  ],
  "intake": {
    "version": 1,
    "scope": "rebase-only",
    "scopeEnforced": true,
    "capabilities": [
      { "name": "rebase-executor", "requested": 1, "granted": true }
    ]
  }
}
```

`prFixItem.fixType` names the dispatched lane. It is `REBASE` for a rebase task. The task's `reasons` carry the mechanical instruction wall.
