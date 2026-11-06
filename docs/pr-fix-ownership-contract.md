# PR-fix ownership evidence contract (#1569)

## Problem

PR-fix repair work must keep its owning lane and its original claimant, separately from the consumer that receives any given hand-out.

A fresh hand-out recipient never becomes the original claimant. A lane re-classification (for example by a groomer) never transfers existing PR ownership. Dispatch records and exposes this evidence.

Dispatch does not map claimants to lanes or tiers itself. It keeps no client-specific identity list. It never infers identity from prefixes and never special-cases individual names.

## Storage

Each `PrFixQueueItem` gains:

- `claimant` — an identity string.
- `claimantSource` — the provenance of that string.

The `author` column stays as the PR author login. It is a distinct boundary from the claimant.

The `agentHandouts` field stays per-generation receiving consumers. It is another distinct boundary.

## Provenance values and resolution order

At ingestion or materialization, claimant provenance resolves in this order:

1. `lease` — a live, unexpired `Lease` on the linked issue.
2. `agent-label` — exactly one distinct `agent/<name>` label.
3. `owner-label` — exactly one distinct `owner/<name>` label.
4. `pr-author` — no linked issue; uses the PR author login.

Only the recovery endpoint can stamp `operator`.

Failure states:

- `ambiguous` — authoritative sources disagree. Never resolved by preference. Parks for recovery.
- `missing` — no source resolved.
- `legacy` — the row predates this contract, so `claimantSource` is NULL. Treated like missing.

A recorded claimant is never overwritten, refreshed, or cleared by re-ingestion. Operator stamps win and are audited in `PrFixHistory`.

## Enforcement at issuance (next-task)

The ownership gate applies to every automatic hand-out: normal, escalation, unfiltered operator poll, and REBASE alike.

Unresolved ownership never authorizes an automatic hand-out. Refusal is logged with the provenance.

Before refusing, the gate makes one lazy re-resolution attempt from the authoritative records (Lease, labels, PR author) and backfills conditionally, only when `claimant` is NULL. That is the bulk recovery path for legacy rows.

Mode env `DISPATCH_PR_FIX_OWNERSHIP_MODE`:

- `enforce` — default. Gate active and backfill enabled.
- `audit` — log-only migration window.
- `off` — also disables issuance backfill.

## Recovery paths for an unresolved row

1. Re-ingestion while unresolved.
2. Operator requeue (re-resolves).
3. `POST /api/pr-fix-queue/claimant` with `{ repo, pr, claimant }` — maintainer-only; stamps provenance `operator`.

## Lane isolation at issuance

Lane isolation is bidirectional and extends #1503:

- Declared-NORMAL consumers cannot take escalation-authoritative work.
- Declared-ESCALATED consumers cannot take work that is authoritatively NORMAL.
- An unverifiable classification refuses both declared lanes.

The #1046 unfiltered poll stays unrestricted for the lane arm, but not for the ownership arm.

Linked-PR materialization derives the row lane from the linked issue's tri-state classification. `UNKNOWN` defers materialization instead of falling back to NORMAL.

## Evidence payload

The followup-pr task gains an `ownership` object only when the poll declared and was granted the intake capability `pr-ownership-evidence:1`. Negotiation is versioned per #1532, via `?capabilities=pr-ownership-evidence:1`.

Shape:

```json
{
  "contract": 1,
  "owningLane": "...",
  "originalClaimant": "...",
  "provenance": "...",
  "prAuthor": "..."
}
```

`originalClaimant` is null when ownership is unresolved. `prAuthor` is included when available.

Mixed-version behavior: an un-negotiated peer gets the byte-identical legacy task. The ack lists the capability as granted or unsupported, so a new client can refuse unsupported servers safely.

Queue listings carry `claimant`, `claimantSource`, and `ownership` additively.

### Reading the provenance

- `originalClaimant` is the authority. A row that carries a claimant dispatches, whatever its `provenance` says.
- `provenance: "legacy"` means the row predates this contract (no recorded source). It does not by itself mean "unowned": a claimant-bearing row with no recorded source still reports `legacy` and still dispatches.
- `missing` / `ambiguous` are the recorded failure states, and both refuse automatic hand-out in `enforce`.
- In `audit` and `off` modes a negotiated poll can receive `originalClaimant: null`. A capability grant is not a promise of a claimant.
- `owningLane` is the ROW's lane, not the dispatched lane. A `REBASE` hand-out ships `owningLane` from the row (often `NORMAL`) alongside `prFixItem.fixType: "REBASE"`. Bind identity to the row, never to the execution lane.

## Write rules

- A claimant is written at row creation, and afterwards only by a write pinned on `claimant IS NULL` (re-ingestion backfill, issuance backfill, operator requeue). The pin is the invariant: a claimant an operator stamped, or a backfill that committed first, can never be transferred or cleared by a later writer.
- Re-ingestion and requeue write only a RESOLVED value. An unresolved observation leaves an existing row untouched instead of rewriting a failure state every cycle.
- A failed claimant-fact read records nothing at all. The row stays unresolved (`claimantSource` NULL, reported as `legacy`), and a later observation or recovery re-resolves it — a transient database error is never stored as provenance.
- A refused hand-out disturbs nothing on the row: no dispatch stamp, no evidence-watermark change, no hand-out record.

## Companion rollout note

A consuming client enforces its own claimant-to-lane bindings using this evidence. Dispatch deliberately does not.

## Definitions

- **Claimant** — the identity that owns the PR-fix work, recorded in `PrFixQueueItem.claimant` with provenance in `claimantSource`.
- **Author** — the PR author login (`author`), a distinct boundary from the claimant.
- **Hand-out recipient** — a per-generation receiving consumer recorded in `agentHandouts`; never becomes the original claimant.