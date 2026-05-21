# Worker Execution Contract

> **Issue:** [misospace/dispatch#65](https://github.com/misospace/dispatch/issues/65)
> **Date:** 2026-05-16

This document defines the generic execution contract for any agent worker consuming work from Dispatch queues. It supersedes ad-hoc behavior and ensures consistency across all workers regardless of identity or repository.

## Table of Contents

- [One Item Per Run](#one-item-per-run)
- [PR Fix Queue Precedence](#pr-fix-queue-precedence)
- [Duplicate PR Avoidance](#duplicate-pr-avoidance)
- [Existing PR Update Behavior](#existing-pr-update-branch-work)
- [New Issue Work — Branch Naming](#new-issue-work-branch-naming)
- [Hard Completion Gate](#hard-completion-gate)
- [Failure Response Format](#failure-response-format)
- [Queue Consumption Rules](#queue-consumption-rules)

---

## One Item Per Run

A worker must handle **exactly one** queue item per execution:

- Either one PR fix from the PR review-fix queue, or
- One issue from the normal (or Escalated) assignment queue.

Workers must not batch multiple issues or PR fixes into a single run.

---

## PR Fix Queue Precedence

Before selecting any work from the assignment queue, the worker **must** check the PR review-fix queue via Dispatch APIs:

1. Query `GET /api/agents/{agentName}/queue?lane=normal` — PR-fix items are returned first in the response array (before ranked issue work).
   - Alternatively, query `GET /api/pr-fix-queue/queued?lane=normal` directly for PR-fix items only.
2. For each item with `type: "pr-review-fix"`:
   - Verify the PR is still open and authored by the expected bot account.
   - Verify the head owner matches the trusted owner (`misospace` or `joryirving`).
   - Fetch origin, checkout the queued branch, pull/rebase as appropriate.
   - Read the item's `feedback[]` array to determine the requested fix (from PR comments, reviews, and check failures).
   - Apply the smallest possible change that satisfies the feedback.
   - Validate locally (lint, typecheck, tests).
   - Commit, push to the **same** branch, comment on the PR with what changed and validation results.
   - Mark the queue item `fixed` via `POST /api/pr-fix-queue/mark`:
     ```bash
     curl -s -X POST "DISPATCH_URL/api/pr-fix-queue/mark" \
       -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"repo":"org/repo","pr":42,"status":"fixed","note":"Pushed fix + validation passed"}'
     ```
   - End the run — do not process additional items.
3. If no PR-fix items remain, proceed to normal issue selection from the agent queue.

Issue queue responses exclude claimed issues by default. Any issue with an `agent/*` label is treated as claimed and is omitted from `GET /api/agents/{agentName}/queue?lane=normal` unless the request includes `includeClaimed=true` for manual recovery or dashboard views.

> **Never open a new PR for a queued PR fix.** The worker only pushes to the existing branch.

---

## Duplicate PR Avoidance

Before starting work on any issue, the worker **must** check whether an open PR already exists:

1. Search for open PRs matching the issue number (e.g., `gh pr list --state open --search "{number}"`).
2. If an open PR exists:
   - Do **not** open a duplicate PR.
   - Checkout that PR's branch.
   - Evaluate whether additional work is needed (failed checks, review requests, merge blockers).
   - If work is needed: apply the smallest fix, validate, commit if needed, push to the same branch, verify with `gh pr view`, and end.
   - If no work is needed: move the issue card to In Progress and end.

---

## Existing PR Update Behavior

When updating an existing PR (from the duplicate-check step above):

1. Checkout the PR's branch directly (by PR number or head ref).
2. Apply changes on top of the existing branch — do not create a new branch.
3. Validate locally before pushing.
4. Push to the same branch (`git push origin <branch>`).
5. Verify with `gh pr view` that the PR reflects the changes.
6. End with the PR URL.

---

## New Issue Work — Branch Naming

When no open PR exists for an issue, create a new branch using this convention:

```
fix/issue-{number}-{short-description}
```

Examples:
- `fix/issue-65-worker-contract`
- `fix/issue-144-version-drift`

Rules:
- Use the GitHub issue number.
- Short description: kebab-case, ≤ 3 words, capturing the essence of the fix.
- Prefix with `fix/` to distinguish from feature or other branches.

---

## Hard Completion Gate

A local commit is **not** completion. After any commit, the worker **must** complete the following sequence in order:

| Step | Action | Failure Behavior |
|------|--------|------------------|
| 1 | `git push` to origin | If push fails → end with `Stuck: {reason}.` |
| 2 | `gh pr create` (new work) or verify existing PR (update work) | If create fails → end with `Stuck: {reason}.` |
| 3 | `gh pr view` to verify the PR URL and state | If view fails → end with `Stuck: {reason}.` |
| 4 | Final response containing the verified PR URL | — |

The worker must not end until step 4 is complete. If any step in the sequence cannot be performed (network failure, auth error, API rate limit), the worker ends immediately with:

```
Stuck: {reason}.
```

Where `{reason}` describes what failed and why (e.g., `push rejected due to protected branch`, `gh pr create failed: already exists`).

---

## Failure Response Format

When a worker cannot complete its task, it must end with exactly this format:

```
Stuck: {reason}.
```

Where `{reason}` is a brief, specific description of the failure (one sentence). Examples:

- `Stuck: git push rejected — branch protected and force-push not allowed.`
- `Stuck: gh pr create failed — API rate limit exceeded, retry after 120s.`
- `Stuck: unable to fetch origin — network unreachable.`

Do not include stack traces, tokens, or debug output in the final response.

---

## Queue Consumption Rules

### PR Fix Queue

PR review-fix items take precedence over all issue work. Workers must check for pending PR-fix items before consuming from the issue queue.

PR-fix items are returned via:
- `GET /api/agents/{agentName}/queue?lane=normal` — PR-fix items prepended to response array
- `GET /api/pr-fix-queue/queued?lane=normal` — PR-fix items only

Mark completion via `POST /api/pr-fix-queue/mark`:
```bash
curl -s -X POST "DISPATCH_URL/api/pr-fix-queue/mark" \
  -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"org/repo","pr":42,"status":"fixed"}'
```

Valid statuses: `FIXED`, `BLOCKED`, `STALE`, `IGNORED`.

### Normal Lane

The normal lane contains concrete, scoped, testable work items:
- Bounded frontend/backend fixes
- Documentation updates
- Tests and CI/lint improvements
- Release/version drift fixes
- Dependency updates
- Concrete follow-up issues with clear acceptance criteria

Workers consume one item per run from the normal lane's queue endpoint.

### Escalated Lane

The Escalated lane contains work requiring higher-judgment model support:
- Architecture, security, or API boundary design
- Database/schema migration strategy
- Distributed/cross-service design decisions
- Ambiguous product behavior resolution
- Broad refactor planning
- RFC/design/alternatives evaluation
- Audit parent decomposition

Workers consume one item per run from the Escalated lane's queue endpoint.

### Lane Selection

Workers receive their lane via the queue endpoint's `lane` query parameter:
- `GET /api/agents/<name>/queue?lane=normal`
- `GET /api/agents/<name>/queue?lane=escalated` (also accepts `lane=gpt` as a **deprecated compatibility alias** — do not use in new docs)

BACKLOG issues are excluded from the normal agent queue by default.

### Renovate Issue Exclusion

Renovate-created issues (dependency dashboards, update PRs, etc.) are **visible in Dispatch** but **excluded from agent queues by default**. This prevents agents from consuming cycles on dependency bookkeeping instead of normal issue work.

Detection heuristics (author detection is not available since the Issue model does not store author):
- Title contains `Dependency Dashboard`
- Title starts with `Update dependency`, `Update image`, or similar Renovate patterns
- Labels: `renovate`, `dependencies`, `automated`

To explicitly include Renovate issues in queue results, pass `includeRenovate=true`:
```bash
GET /api/agents/<name>/queue?lane=normal&includeRenovate=true
```

Renovate exclusion applies to issue queue items only, not PR review-fix queue items. Issues excluded as Renovate remain visible on the Board and Projects pages.

---

## Linking

This contract is referenced from:
- [AGENTS.md](../AGENTS.md) — OpenClaw Agent Workflow Contract section
- [OpenClaw Agent — Dispatch Phase 1 Workflow Contract](./openclaw-agent-mc-workflow.md) — historical pre-cutover reference (marked as archived)

---

## History

- **2026-05-16** — Created to document generic worker execution contract and PR completion gates (Issue #65). Consolidates existing normal-worker behavior into a reusable, agent-agnostic specification.
- **2026-05-19** — Added Renovate issue exclusion section: Renovate issues are visible in Dispatch but excluded from agent queues by default; `includeRenovate=true` opt-in available (Issue #129).
- **2026-05-19** — Added five-column workflow with Ready status (Issue #140): Backlog → Ready → In Progress → In Review → Done. Agents pick from Ready by default; Backlog excluded unless explicitly requested.
- **2026-05-20** — Marked `lane=gpt` as deprecated compatibility alias in canonical docs; linked openclaw-agent-mc-workflow.md as historical (Issue #117).
