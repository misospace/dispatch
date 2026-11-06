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
- Any other name is not granted. The reason is `unknown-capability`. An unknown name is not an error. A newer client can declare a capability that this server does not know yet.

A capability that is not granted never unlocks rebase work and never widens the queue.

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
| New Dispatch with an old Courier | The old client never declares `rebase-executor:1`, so it never receives a REBASE hand-out, even when its agent name is in the allowlist. Its ordinary queue keeps working. |
| New Courier with an old Dispatch | The old server ignores `work_scope` and answers with ordinary work and no `intake` acknowledgment. The client must treat the missing acknowledgment as "this server does not support the contract". The client must not execute the ordinary task it received. The client must not poll again in a loop. |

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

## Enablement steps

These steps enable one rebase agent. This document changes no production configuration.

1. The Courier peer must implement the contract. It sends `capabilities=rebase-executor:1` on every poll. It sends `work_scope=rebase-only&work_scope_version=1` on the polls of the dedicated rebase agent.
2. The operator names the worker pool. Set `DISPATCH_REBASE_AGENTS=courier-rebase`. The value holds comma or whitespace separated agent names. The names are case-insensitive. An unset or empty value admits nobody.
3. The agent runs with a Courier lane profile that uses the coordinator `litellm/qwen3.8-27b` and concurrency 1. This profile is a Courier setting. Dispatch does not read it.
4. The agent polls with the `capabilities` declaration. A poll without it receives no rebase work.

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
