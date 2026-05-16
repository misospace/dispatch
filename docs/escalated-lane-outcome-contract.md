# Escalated-Lane Outcome Contract

> **Issue:** [misospace/mission-control#66](https://github.com/misospace/mission-control/issues/66)
> **Date:** 2026-05-16

This document defines the operational contract for escalated-lane outcomes and audit parent decomposition in Mission Control. It enables agents to report non-code outcomes (design comments, follow-up issues, decompositions) beyond simple PR creation.

## Overview

The Escalated lane handles work requiring higher-judgment model support — architecture decisions, security reviews, API boundary design, RFC evaluation, and broad audit parent decomposition. Unlike the NORMAL lane where agents primarily open or update PRs, escalated-lane work may produce several different outcome types. The specific model used for escalated work may vary (e.g., GPT-5.5, Claude Opus, GLM-5.1) depending on configuration; the lane concept is provider-neutral.

Mission Control must understand these outcomes so agents can rely on it as the assignment layer.

---

## Supported Outcomes

| Outcome Constant | Human Label | Description |
|------------------|-------------|-------------|
| `PR_OPENED` | PR opened | Agent opened a new PR in response to the issue |
| `PR_UPDATED` | PR updated | Agent pushed changes to an existing PR |
| `FOLLOW_UP_CREATED` | Follow-up issues created | Agent created concrete sub-issues from a broad parent |
| `DESIGN_COMMENT_POSTED` | Design/RFC comment posted | Agent posted a design document, RFC, or architectural review as a GitHub comment |
| `DECOMPOSED_SKIPPED` | Decomposed/skipped | The issue is a broad audit/umbrella parent that has been decomposed into concrete follow-up issues; the parent itself has no remaining direct work |
| `STUCK` | Stuck | Agent encountered a clear, unresolvable blocker and reported it with context |

---

## Reporting Outcomes via Agent Run

Agents report outcomes by including an `outcome` field in the `POST /api/agent-runs` request body:

```http
POST /api/agent-runs
Authorization: Bearer <TOKEN>
Content-Type: application/json

{
  "agentName": "saffron",
  "runType": "heartbeat",
  "status": "completed",
  "startedAt": "2026-05-16T10:00:00.000Z",
  "finishedAt": "2026-05-16T10:05:00.000Z",
  "summary": "Posted design review for auth boundary issue",
  "outcome": "DESIGN_COMMENT_POSTED",
  "touchedIssueUrls": [
    "https://github.com/misospace/miso-chat/issues/473"
  ]
}
```

### Validation

- If `outcome` is provided, it **must** be one of the six valid constants.
- Invalid values return HTTP 400 with a list of valid options.
- `outcome` is optional — NORMAL-lane agents may omit it.
- No hardcoded agent names or repo names in validation logic.

---

## Audit Parent Decomposition

### Problem

Broad audit/umbrella issues (e.g., "Security audit decomposition", "Cross-service design review") are not directly actionable. They need to be decomposed into concrete follow-up issues before agents can work on them. Once decomposed, the parent issue should be excluded from the assignment queue without being closed — child work continues independently.

### Decomposition Endpoint

```http
POST /api/issues/actions/decompose
Authorization: Bearer <TOKEN>
Content-Type: application/json

{
  "repo": "misospace/mission-control",
  "issueNumber": 66,
  "decomposed": true,
  "followUpUrls": [
    "https://github.com/misospace/mission-control/issues/100",
    "https://github.com/misospace/mission-control/issues/101"
  ],
  "note": "Decomposed into two concrete auth boundary review tasks"
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | string | Yes | Owner/repo format (e.g., `"misospace/mission-control"`) |
| `issueNumber` | number | Yes | GitHub issue number |
| `decomposed` | boolean | Yes | `true` to mark as decomposed, `false` to reactivate |
| `followUpUrls` | string[] | No | URLs of concrete follow-up issues created from this parent |
| `note` | string | No | Human-readable note about the decomposition |

### Response

```json
{
  "success": true,
  "issueId": "clx123...",
  "decomposed": true,
  "decomposedAt": "2026-05-16T10:05:00.000Z",
  "followUpUrls": [
    "https://github.com/misospace/mission-control/issues/100",
    "https://github.com/misospace/mission-control/issues/101"
  ]
}
```

### Audit Trail

Every decomposition action is logged in the `AuditLog` model:
- `action`: `"issue_decomposed"` or `"issue_reactivated"`
- `notes`: Includes the decomposition note and follow-up URLs
- Actor is always `"agent"` for automated decompositions

---

## Queue Behavior with Decomposed Parents

### Default Behavior

By default, decomposed issues **are included** in the queue. This allows operators to see all issues, including those that have been decomposed.

### Excluding Decomposed Parents

The queue endpoint supports an `exclude_decomposed=true` query parameter:

```
GET /api/agents/saffron/queue?lane=escalated&exclude_decomposed=true
```

This filters out issues where `decomposed` is `true`, so agents only see actionable work.

### Filtering Issues by Decomposed Status

The general issues endpoint supports a `decomposed` query parameter:

```
GET /api/issues?decomposed=true   # Show only decomposed issues
GET /api/issues?decomposed=false  # Show only non-decomposed issues
```

Default behavior (no parameter): returns all issues regardless of decomposed status.

---

## Linking Follow-Up Issues to Parents

When an agent creates concrete follow-up issues from a broad parent:

1. Report the outcome as `FOLLOW_UP_CREATED` via `POST /api/agent-runs`.
2. Call `POST /api/issues/actions/decompose` with `followUpUrls` containing the URLs of the new issues.
3. The parent issue stores these URLs in its `followUpUrls` array for traceability.

This creates a bidirectional link:
- The queue can exclude decomposed parents (no duplicate assignments).
- Operators can see all follow-up work from a single parent issue.
- The `AuditLog` records the full chain of actions.

---

## Stuck Reporting

When an agent encounters a clear, unresolvable blocker:

```json
{
  "agentName": "saffron",
  "runType": "heartbeat",
  "status": "completed",
  "startedAt": "2026-05-16T10:00:00.000Z",
  "finishedAt": "2026-05-16T10:05:00.000Z",
  "outcome": "STUCK",
  "summary": "Cannot resolve cross-service auth boundary without access to service X's config schema",
  "errorMessage": "Blocked: missing access to service configuration",
  "notes": "Need operator to grant read access to miso-gateway config repo"
}
```

The `STUCK` outcome signals that the agent needs human intervention. The `summary` and `notes` fields provide context for operators to resolve the blocker.

---

## Source of Truth Rules

| Rule | Detail |
|------|--------|
| GitHub is authoritative | Issues and PRs on GitHub are the single source of truth. Mission Control's Postgres is a cache. |
| Decomposed state is local | The `decomposed` flag lives only in Mission Control's database. It does not create or modify GitHub labels. Operators may optionally add a `status/decomposed` label on GitHub for visibility, but it is not required. |
| No auto-close | Decomposed issues are **not** closed on GitHub. They remain open with their child work continuing independently. |

---

## Security Constraints

| Constraint | Detail |
|------------|--------|
| Auth required | Both `POST /api/agent-runs` and `POST /api/issues/actions/decompose` require a valid `MISSION_CONTROL_AGENT_TOKEN`. |
| No hardcoded names | Outcome validation, lane filtering, and decomposed exclusion apply uniformly across all agents and repositories. |

---

## API Reference Summary

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/agent-runs` | POST | Bearer token | Submit agent run with optional escalated-lane outcome |
| `/api/issues/actions/decompose` | POST | Bearer token | Mark audit parent as decomposed/reactivated |
| `/api/agents/<name>/queue?exclude_decomposed=true` | GET | None | Get queue excluding decomposed audit parents |
| `/api/issues?decomposed=true` | GET | None | Filter issues by decomposed status |

---

## History

- **2026-05-16** — Created to support Escalated lane non-code outcomes and audit decomposition (Issue #66).
