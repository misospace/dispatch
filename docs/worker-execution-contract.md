# Worker Execution Contract

> **Issue:** [misospace/mission-control#65](https://github.com/misospace/mission-control/issues/65)
> **Date:** 2026-05-16

This document defines the generic execution contract for any agent worker consuming work from Mission Control queues. It supersedes ad-hoc behavior and ensures consistency across all workers regardless of identity or repository.

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

Before selecting any work from the assignment queue, the worker **must** check the PR review-fix queue:

1. Query the PR fix queue for the next available item in the worker's lane (e.g., `normal`).
2. If an item is returned:
   - Verify the PR is still open and authored by the expected bot account.
   - Verify the head owner matches the trusted owner (`misospace` or `joryirving`).
   - Fetch origin, checkout the queued branch, pull/rebase as appropriate.
   - Read PR comments, reviews, and check failures to determine the requested fix.
   - Apply the smallest possible change that satisfies the feedback.
   - Validate locally (lint, typecheck, tests).
   - Commit, push to the **same** branch, comment on the PR with what changed and validation results.
   - Mark the queue item `fixed` with a note.
   - End the run — do not process additional items.
3. If no item is returned (queue is clear), proceed to normal issue selection.

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
- `GET /api/agents/<name>/queue?lane=escalated` (also accepts `lane=gpt` as a deprecated alias)

BACKLOG issues are excluded from the normal agent queue by default.

---

## Linking

This contract is referenced from:
- [AGENTS.md](../AGENTS.md) — OpenClaw Agent Workflow Contract section
- [OpenClaw Agent — Mission Control Phase 1 Workflow Contract](./openclaw-agent-mc-workflow.md) — linked as the detailed worker execution reference

---

## History

- **2026-05-16** — Created to document generic worker execution contract and PR completion gates (Issue #65). Consolidates existing normal-worker behavior into a reusable, agent-agnostic specification.
