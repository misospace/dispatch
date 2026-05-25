// ─── Next-Action Contract for Resumable Agent Work ──────────────────────────
//
// Issue: misospace/dispatch#167
// Date: 2026-05-21
//
// This module defines the `nextAction` contract that Dispatch returns alongside
// checkpoint data so cron workers and harnesses can resume work without
// re-infering state from scratch.
//
// Design principles:
// - Agent-agnostic: no hardcoded agent names or workflow assumptions.
// - Coarse-grained: each action represents one bounded step, not a full task.
// - Explicit: the contract maps known checkpoints to deterministic next actions.

// ─── Next Action Values ─────────────────────────────────────────────────────
// These are the actionable steps an agent can take after resuming from a
// checkpoint. Each value corresponds to a single bounded operation.

export type NextActionValue =
  | "prepare_repo"        // Clone/fetch the repo and ensure it's available locally
  | "create_branch"       // Create a new branch for the fix
  | "inspect_issue"       // Read the issue body, comments, and acceptance criteria
  | "continue_changes"    // Apply or continue code changes on an existing branch
  | "run_validation"      // Run tests, lint, typecheck, or other validation
  | "open_pr"             // Open a pull request for the current work
  | "check_pr_status"     // Check PR CI status, review state, and merge readiness
  | "address_pr_feedback" // Apply requested changes from reviews or check failures
  | "finish_or_block";    // Mark issue complete or report that further progress is blocked

export const VALID_NEXT_ACTIONS: NextActionValue[] = [
  "prepare_repo",
  "create_branch",
  "inspect_issue",
  "continue_changes",
  "run_validation",
  "open_pr",
  "check_pr_status",
  "address_pr_feedback",
  "finish_or_block",
];

export function isValidNextAction(value: string): value is NextActionValue {
  return VALID_NEXT_ACTIONS.includes(value as NextActionValue);
}

// ─── Checkpoint Values ──────────────────────────────────────────────────────
// Checkpoints represent where an agent left off in its workflow. They are
// generic and do not assume any specific agent or repo.

export type CheckpointValue =
  | "issue_claimed"       // Issue claimed, no branch created yet
  | "branch_created"      // Branch exists, no changes made yet
  | "changes_made"        // Changes committed locally, PR not opened
  | "pr_opened"           // PR is open, awaiting checks/review
  | "feedback_received"   // PR has review comments or check failures
  | "work_complete";      // All acceptance criteria met, ready to finish

export const VALID_CHECKPOINTS: CheckpointValue[] = [
  "issue_claimed",
  "branch_created",
  "changes_made",
  "pr_opened",
  "feedback_received",
  "work_complete",
];

export function isValidCheckpoint(value: string): value is CheckpointValue {
  return VALID_CHECKPOINTS.includes(value as CheckpointValue);
}

// ─── Checkpoint-to-NextAction Mapping ───────────────────────────────────────
// Each checkpoint deterministically maps to the next bounded step.
// This mapping is the core of the contract — agents use it to know what to do
// next without re-reasoning about state.

export function resolveNextAction(checkpoint: CheckpointValue): NextActionValue {
  switch (checkpoint) {
    case "issue_claimed":
      return "inspect_issue";
    case "branch_created":
      return "continue_changes";
    case "changes_made":
      return "open_pr";
    case "pr_opened":
      return "check_pr_status";
    case "feedback_received":
      return "address_pr_feedback";
    case "work_complete":
      return "finish_or_block";
  }
}

// ─── Resume Context ─────────────────────────────────────────────────────────
// This is the shape returned by Dispatch when an agent queries for active work
// or resumes from a checkpoint. It replaces ad-hoc inference from labels/PRs.

export interface ResumeContext {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  agentName: string;
  checkpoint: CheckpointValue;
  branch?: string;
  prUrl?: string;
  nextAction: NextActionValue;
  leaseId?: string;
}

// ─── Resume Context Builder ─────────────────────────────────────────────────
// Constructs a ResumeContext from raw checkpoint data. Validates inputs and
// computes the deterministic next action.

export interface RawResumeInput {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  agentName: string;
  checkpoint: string;
  branch?: string;
  prUrl?: string;
}

export function buildResumeContext(input: RawResumeInput): ResumeContext {
  if (!isValidCheckpoint(input.checkpoint)) {
    throw new Error(`Unknown checkpoint: "${input.checkpoint}". Valid values: ${VALID_CHECKPOINTS.join(", ")}`);
  }

  const nextAction = resolveNextAction(input.checkpoint as CheckpointValue);

  return {
    issueId: input.issueId,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    agentName: input.agentName,
    checkpoint: input.checkpoint as CheckpointValue,
    branch: input.branch,
    prUrl: input.prUrl,
    nextAction,
  };
}

// ─── Active Work Response ───────────────────────────────────────────────────
// Shape returned by GET /api/agents/{agentName}/active-work when there is
// resumable work to continue.

export interface ActiveWorkResponse {
  hasActiveWork: true;
  context: ResumeContext;
}

export interface NoActiveWorkResponse {
  hasActiveWork: false;
}

export type ActiveWorkResult = ActiveWorkResponse | NoActiveWorkResponse;
