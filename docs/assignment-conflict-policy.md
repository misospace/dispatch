# Assignment Conflict Policy

## Overview

This document defines the rules governing how agents claim issues through Mission Control's assignment system.
It applies to all `agent/<name>` and `owner/<name>` labels on synced GitHub issues.

> **No specific agent or owner names are hardcoded.** All rules use generic prefixes (`agent/`, `owner/`)
> and apply uniformly regardless of the actual label values.

---

## 1. When an Agent May Claim an Issue

An agent may claim an issue by having an `agent/<name>` label assigned via the
`POST /api/issues/actions` endpoint with `action: "assign_agent"`.

An agent **may** claim an issue when:

- The issue is open (not closed).
- The issue has no existing `agent/<name>` label, **or** the agent explicitly requests a force-claim.
- The issue is reachable through the agent queue endpoint (`GET /api/agents/<name>/queue`) or
  manually assigned by an authorized caller.

Agents discover claimable issues via:

1. **Agent queue** — `GET /api/agents/<name>/queue` returns issues ranked by priority, status, and agent-match.
2. **Direct assignment** — An external caller (human operator, automation pipeline) POSTs to the assign endpoint.

---

## 2. Conflict Resolution: Another `agent/*` Label Exists

When assigning an `agent/<name>` label to an issue that already has one or more `agent/<other>` labels:

| Scenario | Behavior |
|----------|----------|
| No `force_claim` flag | The **existing agent label(s) are replaced** by the new one. Only one agent label may exist at a time. |
| `force_claim: true` | The existing agent label is **still replaced**. Force-claim does not create duplicate agent labels; it bypasses any additional soft-checks that might block the assignment (see §4). |

**Rules:**

- At most **one** `agent/<name>` label may exist on an issue at any time.
- All existing `agent/*` labels are removed before adding the new one.
- Non-agent labels (status, priority, type, owner, project) are preserved.
- The assignment is logged in the audit trail with `beforeLabels` and `afterLabels`.

---

## 3. Conflict Resolution: `owner/*` Labels Exist

Agent and owner assignments are **independent**:

| Action | Effect on owner labels |
|--------|----------------------|
| `assign_agent` | Owner labels are **untouched**. Both agent and owner may coexist. |
| `assign_owner` | Agent labels are **untouched**. Both owner and agent may coexist. |

At most **one** `owner/<name>` label may exist on an issue at any time (same replacement semantics as agent).

---

## 4. Force-Claim

### What is it?

Force-claim allows an assignment to proceed even when soft conflict checks would normally block it.
It is a boolean flag (`force_claim: true`) passed in the request body.

### When does it apply?

Force-claim applies when the assign endpoint encounters any additional blocking condition beyond
the basic label-replacement logic, such as:

- The issue is already assigned to a different agent and an admin wants to reassign.
- An external policy check (future) would reject the assignment.

### Who may force-claim?

Force-claim is available to any caller that has access to the assign endpoint with the `force_claim` flag set.
In future iterations, this may be gated by authentication or role-based access control.

### Current implementation

At present, the basic conflict resolution (replace existing agent/owner label) always succeeds regardless of force-claim.
The force-claim flag is accepted and logged for audit purposes and to support future blocking checks.

---

## 5. Endpoint Compliance

### `POST /api/issues/actions` (assign)

- Accepts `action: "assign_agent"` or `action: "assign_owner"`.
- Validates that `value` starts with the expected prefix (`agent/` or `owner/`).
- Replaces all conflicting labels of the same type.
- Preserves non-conflicting labels.
- Supports optional `force_claim: boolean` in request body (accepted but does not change current behavior).
- Writes audit log on success and failure.

### `POST /api/issues/unassign` (unassign)

- Accepts `action: "unassign_agent"` or `action: "unassign_owner"`.
- Removes **all** labels of the corresponding type.
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
| `action` | The action type (`assign_agent`, `assign_owner`, `unassign_agent`, `unassign_owner`) |
| `beforeLabels` | Labels before the change |
| `afterLabels` | Labels after the change |
| `success` | Whether the operation succeeded |
| `errorMessage` | Error details if failed |

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
| §1 Issue state validation | ✅ Implemented | `POST /api/issues/actions` rejects assignments to closed issues (returns 400) |
| §2 Agent conflict replacement | ✅ Implemented | Existing agent labels replaced; force-claim accepted but doesn't change behavior |
| §3 Owner/agent independence | ✅ Implemented | Owner and agent labels are independent; each type replaced independently |
| §4 Force-claim acknowledgment | ✅ Implemented | Flag accepted and logged in audit trail notes; no additional blocking applied |
| §5 Endpoint compliance | ✅ Implemented | Both assign and unassign endpoints follow policy |
| §6 Audit trail | ✅ Implemented | Conflict details and force_claim status recorded in audit log `notes` field |
