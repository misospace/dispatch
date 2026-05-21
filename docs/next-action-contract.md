# Next-Action Contract for Resumable Agent Work

> **Issue:** [misospace/dispatch#167](https://github.com/misospace/dispatch/issues/167)
> **Date:** 2026-05-21

This document defines the `nextAction` contract that Dispatch returns alongside checkpoint data for resumable agent work. It replaces ad-hoc procedural logic in prompts with a deterministic mapping from checkpoints to bounded next steps.

## Summary

Instead of requiring agents to infer their next step from labels, PR state, and branch existence, Dispatch returns a coarse-grained `nextAction` field that tells the agent exactly what bounded operation to perform next.

## Example Response

```json
{
  "issueId": "...",
  "repoFullName": "misospace/dispatch",
  "issueNumber": 123,
  "agentName": "worker",
  "checkpoint": "pr_opened",
  "branch": "fix/issue-123-example",
  "prUrl": "https://github.com/misospace/dispatch/pull/456",
  "nextAction": "check_pr_status"
}
```

## Next Action Values

| Value | Description |
|-------|-------------|
| `prepare_repo` | Clone/fetch the repo and ensure it's available locally |
| `create_branch` | Create a new branch for the fix |
| `inspect_issue` | Read the issue body, comments, and acceptance criteria |
| `continue_changes` | Apply or continue code changes on an existing branch |
| `run_validation` | Run tests, lint, typecheck, or other validation |
| `open_pr` | Open a pull request for the current work |
| `check_pr_status` | Check PR CI status, review state, and merge readiness |
| `address_pr_feedback` | Apply requested changes from reviews or check failures |
| `finish_or_block` | Mark issue complete or report that further progress is blocked |

## Checkpoint Values

Checkpoints represent where an agent left off in its workflow:

| Value | Description |
|-------|-------------|
| `issue_claimed` | Issue claimed, no branch created yet |
| `branch_created` | Branch exists, no changes made yet |
| `changes_made` | Changes committed locally, PR not opened |
| `pr_opened` | PR is open, awaiting checks/review |
| `feedback_received` | PR has review comments or check failures |
| `work_complete` | All acceptance criteria met, ready to finish |

## Checkpoint-to-NextAction Mapping

| Checkpoint | Next Action |
|------------|-------------|
| `issue_claimed` | → `inspect_issue` |
| `branch_created` | → `continue_changes` |
| `changes_made` | → `open_pr` |
| `pr_opened` | → `check_pr_status` |
| `feedback_received` | → `address_pr_feedback` |
| `work_complete` | → `finish_or_block` |

## Workflow Chain

```
issue_claimed ──→ inspect_issue
branch_created ──→ continue_changes
changes_made ──→ open_pr ──→ pr_opened ──→ check_pr_status
                                                ↓
feedback_received ←── address_pr_feedback ←── (loop for each feedback cycle)
work_complete ──→ finish_or_block
```

## Usage by Cron Workers

Cron workers and harnesses should:

1. Query active work via the appropriate Dispatch API endpoint.
2. If `hasActiveWork` is true, read the `nextAction` field.
3. Perform **exactly** the bounded step indicated by `nextAction`.
4. On completion, update the checkpoint and report back to Dispatch.
5. Stop — do not infer additional state or chain multiple actions.

## Usage for New Work (No Checkpoint)

When an agent starts fresh (no prior checkpoint), it should follow this sequence:

1. `prepare_repo` — ensure the repo is available
2. `create_branch` — branch naming: `fix/issue-{number}-{short-description}`
3. `inspect_issue` — read issue body, comments, acceptance criteria
4. `continue_changes` — implement the fix
5. `run_validation` — lint, typecheck, tests
6. `open_pr` — create PR with `Fixes #{number}` or `Refs #{number}`
7. `check_pr_status` — verify CI passes and no review requests
8. `address_pr_feedback` — if feedback received, loop back to step 4
9. `finish_or_block` — mark issue done or report blocker

## Design Principles

- **Agent-agnostic:** No hardcoded agent names or workflow assumptions. The contract applies uniformly to all agents and harnesses.
- **Coarse-grained:** Each action represents one bounded step, not a full task. This prevents agents from over-committing in a single run.
- **Explicit:** The mapping is deterministic — given a checkpoint, the next action is always the same. No inference required.
- **Extensible:** New checkpoints and actions can be added without breaking existing agents, as long as the validation layer rejects unknown values.

## API Integration

The `nextAction` contract integrates with:

- **GET /api/agents/{agentName}/active-work** — returns `ResumeContext` with `nextAction`
- **GET /api/agents/{agentName}/queue?lane=normal** — PR-fix items return `nextAction` alongside ranked issue work
- **POST /api/issues/actions** — can include checkpoint updates as part of state transitions

## Source Code

Implementation: `src/lib/next-action.ts`
Tests: `src/lib/next-action.test.ts` (23 tests)

## History

- **2026-05-21** — Created to define the next-action contract for resumable agent work (Issue #167). Includes types, constants, deterministic mapping, validation, and comprehensive tests.
