# Assignment Conflict Policy

## Overview

This document defines the rules governing how agents claim issues through Mission Control's assignment system.
It applies to all `agent/<name>` and `owner/<name>` labels on synced GitHub issues.

> **No specific agent or owner names are hardcoded.** All rules use generic prefixes (`agent/`, `owner/`)
> and apply uniformly regardless of the actual label values.

---

## 1. When an Agent May Claim an Issue

An agent may claim an issue by having an `agent/<name>` label assigned via one of two endpoints:

- **Agent queue claim** — `POST /api/issues/claim` — used when an agent retrieves work from its queue and claims it directly.
- **Direct assignment** — `POST /api/issues/actions` with `action: "assign_agent"` — used by external callers (human operators, automation pipelines).

An agent **may** claim an issue when:

- The issue is open (not closed).
- The issue has no existing `agent/<name>` label, **or** the agent explicitly requests a force-claim.
- The issue is reachable through the agent queue endpoint (`GET /api/agents/<name>/queue`) or
  manually assigned by an authorized caller.

Agents discover claimable issues via:

1. **Agent queue** — `GET /api/agents/<name>/queue` returns issues ranked by priority, status, and agent-match.
2. **Direct assignment** — An external caller (human operator, automation pipeline) POSTs to the assign endpoint (`/api/issues/actions`).

---

## 2. Conflict Resolution: Another `agent/*` Label Exists

When assigning an `agent/<name>` label to an issue that already has one or more `agent/<other>` labels:

| Scenario | Behavior |
|----------|----------|
| No `force` flag (claim) / no `force_claim` flag (actions) | The **existing agent label(s) are replaced** by the new one. Only one agent label may exist at a time. A 409 Conflict response is returned from `/api/issues/claim`. |
| `force: true` (claim) / `force_claim: true` (actions) | The existing agent label is **still replaced**. Force-claim does not create duplicate agent labels; it bypasses the 409 error and removes the stale label before assigning. |

**Rules:**

- At most **one** `agent/<name>` label may exist on an issue at any time.
- All existing `agent/*` labels are removed before adding the new one.
- Non-agent labels (status, priority, type, owner, project) are preserved.
- The assignment is logged in the audit trail with `beforeLabels` and `afterLabels`.

**Conflict analysis is performed by the shared module** (`src/lib/assignment-conflicts.ts`) which:

1. Scans existing labels for `agent/` and `owner/` prefixes.
2. Returns structured conflict data (`existingAgents`, `existingOwners`, `hasAgentConflict`, `hasOwnerConflict`).
3. Builds new label sets that replace conflicting labels while preserving all others.

---

## 3. Conflict Resolution: `owner/*` Labels Exist

Agent and owner assignments are **independent**:

| Action | Effect on owner labels |
|--------|----------------------|
| `assign_agent` (claim or actions) | Owner labels are **untouched**. Both agent and owner may coexist. |
| `assign_owner` | Agent labels are **untouched**. Both owner and agent may coexist. |

At most **one** `owner/<name>` label may exist on an issue at any time (same replacement semantics as agent).

When both agent and owner labels exist, the conflict analysis reports both, but only agent conflicts block a claim. Owner labels are preserved during agent assignment and vice versa.

---

## 4. Force-Claim

### What is it?

Force-claim allows an assignment to proceed even when soft conflict checks would normally block it.
It is a boolean flag:

| Endpoint | Flag name |
|----------|-----------|
| `POST /api/issues/claim` | `force: true` |
| `POST /api/issues/actions` | `force_claim: true` |

### When does it apply?

Force-claim applies when the assign endpoint encounters an existing agent label conflict:

- The issue is already assigned to a different agent and an admin wants to reassign.
- An external policy check (future) would reject the assignment.

### Who may force-claim?

Force-claim is available to any caller that has access to the claim or actions endpoint with the flag set.
In future iterations, this may be gated by authentication or role-based access control.

### Current implementation

At present, the basic conflict resolution (replace existing agent/owner label) always succeeds regardless of force-claim.
The flag is accepted and logged in the audit trail for transparency and to support future blocking checks.

---

## 5. Endpoint Compliance

### `POST /api/issues/claim` (agent claim endpoint)

- Used by agents claiming work from their queue.
- Validates that the issue is open and not done.
- Checks for existing agent labels using the shared conflict analysis module.
- Returns **409 Conflict** if another agent is assigned and `force` is not `true`.
- Uses `buildNewLabels` from the shared module to construct the updated label set.
- Removes the stale agent label (via `removeIssueLabel`) before adding the new one during force-claim.
- Optionally moves issue to `status/in-progress` unless `force: false`.
- Writes audit log with conflict analysis details in the `notes` field.

### `POST /api/issues/actions` (assign endpoint)

- Used by external callers for direct assignment.
- Accepts `action: "assign_agent"` or `action: "assign_owner"`.
- Validates that `value` starts with the expected prefix (`agent/` or `owner/`).
- Replaces all conflicting labels of the same type using the shared module.
- Preserves non-conflicting labels.
- Supports optional `force_claim: boolean` in request body (accepted but does not change current behavior).
- Writes audit log on success and failure, with conflict details in the `notes` field.

### `POST /api/issues/unassign` (unassign)

- Accepts `action: "unassign_agent"` or `action: "unassign_owner"`.
- Removes **all** labels of the corresponding type using the shared module.
- Returns an error if no labels of that type exist.

### `GET /api/agents/<name>/queue` (agent queue)

- Returns issues actionable for the given agent, ranked by priority and status.
- Issues with an existing `agent/<other>` label are **not** excluded from the queue — they remain
  visible so agents can see what others are working on.
- The queue is a **discovery** mechanism, not an enforcement of exclusive assignment.

---

## 6. Audit Trail

All assignment and unassignment actions are logged with:

| Field | Description |
|-------|-------------|
| `actor` | Who performed the action (e.g., `"user"`, `"agent"`) |
| `action` | The action type (`assign_agent`, `assign_owner`, `unassign_agent`, `unassign_owner`, `claim_issue`, `unclaim_issue`) |
| `beforeLabels` | Labels before the change |
| `afterLabels` | Labels after the change |
| `success` | Whether the operation succeeded |
| `errorMessage` | Error details if failed |
| `notes` | Optional conflict analysis details (existing agents/owners, force-claim flag) |

---

## 7. Future Considerations

- **Exclusive assignment enforcement**: Currently, the agent queue does not exclude issues already assigned to other agents.
  This may change if exclusive ownership becomes a requirement.
- **Role-based force-claim**: Restrict force-claim to admin or operator roles.
- **Soft conflict warnings**: Return warnings (not errors) when an issue has conflicting assignments, allowing the caller to decide whether to proceed.

---

## Implementation Status

| Section | Status | Notes |
|---------|--------|-------|
| §1 Issue state validation | ✅ Implemented | Both `/api/issues/claim` and `/api/issues/actions` reject assignments to closed issues (returns 400) |
| §2 Agent conflict replacement | ✅ Implemented | Existing agent labels replaced via shared module; 409 error from claim route without force |
| §3 Owner/agent independence | ✅ Implemented | Owner and agent labels are independent; each type replaced independently via shared module |
| §4 Force-claim acknowledgment | ✅ Implemented | Flag accepted and logged in audit trail notes; no additional blocking applied |
| §5 Endpoint compliance | ✅ Implemented | All four endpoints (claim, actions, unassign, queue) follow policy using shared conflict module |
| §6 Audit trail | ✅ Implemented | Conflict details and force-claim status recorded in audit log `notes` field |
