import { AGENT_PREFIX, OWNER_PREFIX, isAgentLabel, isOwnerLabel } from "@/types";

export { isAgentLabel, isOwnerLabel };

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
 *
 * Pass `assigningAgentLabel` (e.g. `agent/foreman-coder`) to make a re-claim by the
 * SAME agent conflict-free. Without it, an agent re-claiming an issue it already
 * holds counts as a conflict with itself and the claim route 409s
 * ("already assigned to foreman-coder"). That is not hypothetical: an issue left
 * as status/ready while still carrying its own agent label — an unclaim that only
 * reset the status, a groom, a manual edit — sits at the head of the queue and is
 * rejected on every tick, forever. Two p0s stalled 20 days that way, and because
 * `claim_one` skips a failing candidate to avoid starving the lane, nothing
 * surfaced it.
 */
export function analyzeAssignmentConflict(
  labels: string[],
  assigningAgentLabel?: string,
): ConflictAnalysis {
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
    // A label identical to the one being assigned is not a conflict — re-claiming
    // your own issue is idempotent, not a collision with another agent.
    hasAgentConflict: assigningAgentLabel
      ? existingAgents.some((l) => l !== assigningAgentLabel)
      : existingAgents.length > 0,
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
