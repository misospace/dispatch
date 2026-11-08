import type { PrFixType } from "@/types";
import type { IntakeAck } from "@/lib/rebase-intake";
import type { PrFixOwnershipEvidence } from "@/lib/pr-fix-ownership";

export interface IssueRef {
  id?: string;
  repoFullName: string;
  number: number;
  title: string;
  url: string;
}

export interface OptionalIssueRef {
  repoFullName: string;
  number: number;
  title?: string;
  url?: string;
}

export interface PullRequestRef {
  repoFullName: string;
  number: number;
  url?: string;
}

/**
 * Dispatch-owned identity of the PR-fix queue item backing a followup-pr
 * task (#1044). `id` is stable for the persistent PrFixQueueItem; `generation`
 * starts at 1 and changes only when Dispatch creates a fresh dispatchable
 * attempt. Consumers treat the pair as opaque work identity and must not
 * derive queue policy from the number.
 */
export interface PrFixItemIdentity {
  id: string;
  generation: number;
  /**
   * #1256: per-hand-out receipt token minted for THIS hand-out (rotates on
   * every issuance). Workers echo it back on reports; a `capacity-exhausted`
   * settlement is only authorized with it, releasing exactly the hand-out it
   * was issued with. Other outcomes ignore it, so pre-token workers are
   * unaffected.
   */
  handoutToken?: string;
  /**
   * The queue item's PrFixType (#1327). A REBASE item names the mechanical
   * rebase lane: rebase onto the base, reconcile conflicts mechanically,
   * push --force-with-lease, and bail to a human on any semantic conflict.
   * The task's `reasons` carry the full contract; this field lets callers
   * branch without parsing prose.
   */
  fixType?: PrFixType;
}

export interface IdleTask {
  type: "idle";
  shouldRun: false;
  reason: string;
  /**
   * #1532: the versioned intake acknowledgment. Present only when the
   * polling client declared an intake contract (a scope or a capability) —
   * an ordinary consumer's task stays byte-identical to the pre-#1532 shape.
   */
  intake?: IntakeAck;
}

export interface ImplementTask {
  type: "implement";
  shouldRun: true;
  agentName: string;
  lane?: string;
  issue: IssueRef;
  instructions: string;
  stopAfter: string;
  forbiddenActions: string[];
  /** #1532: the versioned intake acknowledgment (see `IdleTask.intake`). */
  intake?: IntakeAck;
}

export interface FollowupPrTask {
  type: "followup-pr";
  shouldRun: true;
  agentName: string;
  lane?: string;
  /**
   * #1569: the versioned OWNING-side evidence — the row's authoritative
   * owning lane and its ORIGINAL CLAIMANT, separate from `agentName` (the
   * receiving consumer of THIS hand-out) and from `author` (the PR pusher).
   * A new hand-out recipient never becomes the claimant.
   *
   * Provenance: captured at ingestion/materialization from a live Lease,
   * a single `agent/*` label, a single `owner/*` label, or (no linked
   * issue) the PR author; an operator stamp overrides on recovery.
 * `provenance` names which. Missing-value behavior: a row with no
 * resolvable claimant carries provenance "missing" | "ambiguous" |
 * "legacy". The ownership gate refuses such a row in every mode. The
 * block rides on a granted hand-out only, so a shipped task always names
 * a claimant. The queue listing shows the null claimant of a row that
 * still needs recovery.
   *
   * Present only when the polling client was granted the
   * `pr-ownership-evidence:1` intake capability (#1532 negotiation);
   * an un-negotiated consumer's task stays byte-identical.
   */
  ownership?: PrFixOwnershipEvidence;
  issue?: OptionalIssueRef;
  pullRequest: PullRequestRef;
  prFixItem?: PrFixItemIdentity;
  reasons: string[];
  instructions: string;
  stopAfter: string;
  forbiddenActions: string[];
  /** #1532: the versioned intake acknowledgment (see `IdleTask.intake`). */
  intake?: IntakeAck;
}

export type AgentTask = IdleTask | ImplementTask | FollowupPrTask;

const IMPLEMENT_INSTRUCTIONS =
  "Claim or work the assigned issue. Open or update exactly one PR, then stop. Do not merge, groom unrelated issues, or claim another issue.";

const IMPLEMENT_STOP_AFTER =
  "One PR is open or updated for the issue. Push remaining work to a follow-up issue.";

const FOLLOWUP_PR_INSTRUCTIONS =
  "Fix the existing pull request. Update it with the requested changes, then stop. Do not merge, open new PRs, or claim another issue.";

const FOLLOWUP_PR_STOP_AFTER =
  "The queued PR has been updated with the requested fixes. Push remaining work to a follow-up.";

const IMPLEMENT_FORBIDDEN = [
  "Merging any pull request",
  "Grooming unrelated issues",
  "Claiming another issue while this one is open",
];

const FOLLOWUP_PR_FORBIDDEN = [
  "Merging any pull request",
  "Opening a new pull request",
  "Claiming another issue while this PR is queued",
];

export function createIdleTask(reason: string, options: { intake?: IntakeAck } = {}): IdleTask {
  return {
    type: "idle",
    shouldRun: false,
    reason,
    ...(options.intake ? { intake: options.intake } : {}),
  };
}

export interface ImplementTaskInput {
  agentName: string;
  lane?: string;
  issue: IssueRef;
  instructions?: string;
  stopAfter?: string;
  forbiddenActions?: string[];
  /** #1532: the versioned intake acknowledgment (see `IdleTask.intake`). */
  intake?: IntakeAck;
}

export function createImplementTask(input: ImplementTaskInput): ImplementTask {
  return {
    type: "implement",
    shouldRun: true,
    agentName: input.agentName,
    lane: input.lane,
    issue: input.issue,
    instructions: input.instructions ?? IMPLEMENT_INSTRUCTIONS,
    stopAfter: input.stopAfter ?? IMPLEMENT_STOP_AFTER,
    forbiddenActions: input.forbiddenActions ? [...input.forbiddenActions] : [...IMPLEMENT_FORBIDDEN],
    ...(input.intake ? { intake: input.intake } : {}),
  };
}

export interface FollowupPrTaskInput {
  agentName: string;
  lane?: string;
  /** #1569: versioned owning-side evidence (see `FollowupPrTask.ownership`). */
  ownership?: PrFixOwnershipEvidence;
  issue?: OptionalIssueRef;
  pullRequest: PullRequestRef;
  prFixItem?: PrFixItemIdentity;
  reasons: string[];
  instructions?: string;
  stopAfter?: string;
  forbiddenActions?: string[];
  /** #1532: the versioned intake acknowledgment (see `IdleTask.intake`). */
  intake?: IntakeAck;
}

export function createFollowupPrTask(input: FollowupPrTaskInput): FollowupPrTask {
  return {
    type: "followup-pr",
    shouldRun: true,
    agentName: input.agentName,
    lane: input.lane,
    issue: input.issue,
    pullRequest: input.pullRequest,
    prFixItem: input.prFixItem,
    reasons: input.reasons,
    instructions: input.instructions ?? FOLLOWUP_PR_INSTRUCTIONS,
    stopAfter: input.stopAfter ?? FOLLOWUP_PR_STOP_AFTER,
    forbiddenActions: input.forbiddenActions ? [...input.forbiddenActions] : [...FOLLOWUP_PR_FORBIDDEN],
    ...(input.ownership ? { ownership: input.ownership } : {}),
    ...(input.intake ? { intake: input.intake } : {}),
  };
}

