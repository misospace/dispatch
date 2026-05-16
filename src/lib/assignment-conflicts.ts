/**
 * Assignment Conflict Resolution Module
 * =======================================
 *
 * Policy: Define when agents may claim issues and how conflicts are resolved.
 *
 * ## Claim Rules
 *
 * 1. **Agent labels**: An agent (e.g., `agent/saffron`) may claim an issue by
 *    adding their `agent/<name>` label. This signals intent to work on the issue.
 *
 * 2. **No conflict**: If no `agent/*` label exists, any authenticated agent may
 *    claim the issue. The claim adds the agent label and, by default, moves the
 *    issue to `status/in-progress`.
 *
 * 3. **Agent conflict**: If an `agent/*` label already exists for a different
 *    agent, the claim is refused with HTTP 409 (Conflict). The requesting agent
 *    must wait for the current assignee to unclaim or release the issue.
 *
 * 4. **Force-claim**: An agent may override an existing `agent/*` label by
 *    passing `force=true`. This removes the old agent label and adds the new one.
 *    Force-claim is restricted to agents with admin privileges (identified by the
 *    `ADMIN_PREFIX` prefix in their name, e.g., `admin/system`). Non-admin agents
 *    attempting force-claim receive HTTP 403 (Forbidden).
 *
 * ## Owner Label Rules
 *
 * 5. **Owner labels**: An `owner/<name>` label indicates human ownership or
 *    oversight of an issue (e.g., a maintainer or project lead). These are set
 *    manually by humans, not by agents.
 *
 * 6. **Owner + agent conflict**: If an `owner/*` label exists on the issue, any
 *    agent may still claim it normally — owner labels do not block agent claims.
 *    Owner labels serve as informational markers for human oversight, not as
 *    assignment locks.
 *
 * 7. **Owner + agent conflict with force-claim**: Force-claim is permitted even
 *    when `owner/*` labels exist. The owner label is preserved during force-claim.
 *
 * ## Status Interaction
 *
 * 8. **Status labels**: When claiming a fresh issue (no existing status label),
 *    the claim automatically adds `status/in-progress`. If the issue already has
 *    a status label, it is preserved and not overwritten.
 *
 * 9. **Done issues**: Issues with `status/done` cannot be claimed.
 *
 * 10. **Closed issues**: Issues with state "closed" cannot be claimed.
 *
 * ## Unclaim Rules
 *
 * 11. An agent may unclaim an issue they own by removing their `agent/*` label.
 *     If the issue has no other status label, unclaiming also removes
 *     `status/in-progress` and the issue reverts to `status/backlog`.
 *
 * ## General Constraints
 *
 * 12. **No hardcoded names**: All agent and owner names are derived from labels
 *     at runtime. No specific agent or owner names are hardcoded in the policy.
 *
 * 13. **Audit trail**: Every claim, unclaim, and force-claim is logged via the
 *     audit log with before/after label snapshots.
 */

import { AGENT_PREFIX, OWNER_PREFIX } from "@/types";

/**
 * Result of a conflict analysis on an issue's labels.
 */
export interface ConflictAnalysis {
  /** Existing agent label(s) on the issue */
  existingAgents: string[];
  /** Existing owner label(s) on the issue */
  existingOwners: string[];
  /** Whether assigning this new agent label would replace existing ones */
  hasAgentConflict: boolean;
  /** Whether assigning this new owner label would replace existing ones */
  hasOwnerConflict: boolean;
  /** All non-assignment labels (status, priority, type, project, etc.) */
  preservedLabels: string[];
}

/**
 * Analyze an issue's labels for assignment conflicts.
 * Returns a structured analysis of what agent/owner labels exist and which would be replaced.
 */
export function analyzeAssignmentConflict(labels: string[]): ConflictAnalysis {
  const existingAgents: string[] = [];
  const existingOwners: string[] = [];
  const preservedLabels: string[] = [];

  for (const label of labels) {
    if (label.startsWith(AGENT_PREFIX)) {
      existingAgents.push(label);
    } else if (label.startsWith(OWNER_PREFIX)) {
      existingOwners.push(label);
    } else {
      preservedLabels.push(label);
    }
  }

  return {
    existingAgents,
    existingOwners,
    hasAgentConflict: existingAgents.length > 0,
    hasOwnerConflict: existingOwners.length > 0,
    preservedLabels,
  };
}

/**
 * Build the new label set after assigning an agent or owner.
 * Removes all conflicting labels of the same type and adds the new one.
 * Non-conflicting labels are preserved.
 *
 * @param currentLabels - The issue's current labels
 * @param action - The assignment action type
 * @param value - The new label to add (e.g., "agent/worker" or "owner/alice")
 * @returns The updated label set
 */
export function buildNewLabels(
  currentLabels: string[],
  action: "assign_agent" | "assign_owner",
  value: string,
): string[] {
  const isConflict = action === "assign_agent" ? isAgentLabel : isOwnerLabel;

  // Remove all conflicting labels of the same type
  const filtered = currentLabels.filter((l) => !isConflict(l));

  // Add the new label
  return [...filtered, value];
}

/**
 * Build the new label set after unassigning an agent or owner.
 * Removes all labels of the corresponding type.
 *
 * @param currentLabels - The issue's current labels
 * @param action - The unassignment action type
 * @returns The updated label set
 */
export function buildUnassignedLabels(
  currentLabels: string[],
  action: "unassign_agent" | "unassign_owner",
): string[] {
  const isConflict = action === "unassign_agent" ? isAgentLabel : isOwnerLabel;
  return currentLabels.filter((l) => !isConflict(l));
}

/**
 * Check if a label is an agent label.
 */
export function isAgentLabel(label: string): boolean {
  return label.startsWith(AGENT_PREFIX);
}

/**
 * Check if a label is an owner label.
 */
export function isOwnerLabel(label: string): boolean {
  return label.startsWith(OWNER_PREFIX);
}

/**
 * Get all agent labels from a label set.
 */
export function getAgentLabels(labels: string[]): string[] {
  return labels.filter(isAgentLabel);
}

/**
 * Get all owner labels from a label set.
 */
export function getOwnerLabels(labels: string[]): string[] {
  return labels.filter(isOwnerLabel);
}

// ---------------------------------------------------------------------------
// Claim conflict resolution (policy enforcement)
// ---------------------------------------------------------------------------

/** Result of conflict resolution for a claim attempt. */
export interface ConflictResult {
  /** The type of conflict detected, or "none" if the claim is permitted. */
  conflict: "agent" | "closed" | "done" | "none";
  /** Human-readable reason for refusal, or null if permitted. */
  reason: string | null;
}

/**
 * Resolve assignment conflict for a claim attempt.
 *
 * Checks the issue's current labels and state against the policy rules:
 * - Closed issues are always blocked.
 * - Done issues are always blocked.
 * - Another agent's label blocks unless force=true (admin-only).
 * - Owner labels do NOT block normal claims, but force-claim is allowed.
 *
 * @param labels - Current labels on the issue.
 * @param state - Issue state ("open" | "closed").
 * @param agentName - Name of the agent attempting to claim.
 * @param force - Whether the agent is requesting a force-claim.
 * @param isAdmin - Whether the requesting agent has admin privileges.
 */
export function resolveClaimConflict(
  labels: string[],
  state: string,
  agentName: string,
  force: boolean | undefined,
  isAdmin: boolean,
): ConflictResult {
  // Closed issues are always blocked
  if (state === "closed") {
    return { conflict: "closed", reason: "Cannot claim a closed issue" };
  }

  // Done issues are always blocked
  const hasDone = labels.includes("status/done");
  if (hasDone) {
    return { conflict: "done", reason: "Cannot claim a done issue" };
  }

  // Check for existing agent label conflict
  const currentAgent = getAgentFromLabels(labels);
  const requestingAgentLabel = `${AGENT_PREFIX}${agentName}`;

  if (currentAgent && currentAgent !== requestingAgentLabel) {
    if (force) {
      // Force-claim: only allowed for admin agents
      if (!isAdmin) {
        return {
          conflict: "agent",
          reason: `Force-claim denied: ${currentAgent.replace(AGENT_PREFIX, "")} already assigned. Only admin agents may force-claim.`,
        };
      }
      // Admin force-claim is allowed — no conflict
      return { conflict: "none", reason: null };
    } else {
      return {
        conflict: "agent",
        reason: `Issue is already assigned to ${currentAgent.replace(AGENT_PREFIX, "")}. Use force=true to override.`,
      };
    }
  }

  // Owner labels do not block claims (they are informational)
  // Force-claim is also allowed when owner labels exist
  return { conflict: "none", reason: null };
}

/**
 * Get the agent label from a label set (returns the single agent/ prefix).
 */
export function getAgentFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    if (label.startsWith(AGENT_PREFIX)) {
      return label;
    }
  }
  return null;
}
