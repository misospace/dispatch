export interface IssueRef {
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

export interface IdleTask {
  type: "idle";
  shouldRun: false;
  reason: string;
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
}

export interface FollowupPrTask {
  type: "followup-pr";
  shouldRun: true;
  agentName: string;
  lane?: string;
  issue?: OptionalIssueRef;
  pullRequest: PullRequestRef;
  reasons: string[];
  instructions: string;
  stopAfter: string;
  forbiddenActions: string[];
}

export interface GroomTask {
  type: "groom";
  shouldRun: true;
  agentName: string;
  issue?: IssueRef;
  instructions: string;
  stopAfter: string;
  forbiddenActions: string[];
}

export type AgentTask = IdleTask | ImplementTask | FollowupPrTask | GroomTask;

const IMPLEMENT_INSTRUCTIONS =
  "Claim or work the assigned issue. Open or update exactly one PR, then stop. Do not merge, groom unrelated issues, or claim another issue.";

const IMPLEMENT_STOP_AFTER =
  "One PR is open or updated for the issue. Push remaining work to a follow-up issue.";

const FOLLOWUP_PR_INSTRUCTIONS =
  "Fix the existing pull request. Update it with the requested changes, then stop. Do not merge, open new PRs, or claim another issue.";

const FOLLOWUP_PR_STOP_AFTER =
  "The queued PR has been updated with the requested fixes. Push remaining work to a follow-up.";

const GROOM_INSTRUCTIONS =
  "Enrich the issue with labels, lane classification, and status assignment. Close completed work. Do not implement or open PRs.";

const GROOM_STOP_AFTER =
  "The issue has been enriched with labels, lane, and status. Close if completed.";

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

const GROOM_FORBIDDEN = [
  "Writing implementation code",
  "Opening pull requests",
  "Modifying production configuration",
];

export function createIdleTask(reason: string): IdleTask {
  return {
    type: "idle",
    shouldRun: false,
    reason,
  };
}

export interface ImplementTaskInput {
  agentName: string;
  lane?: string;
  issue: IssueRef;
  instructions?: string;
  stopAfter?: string;
  forbiddenActions?: string[];
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
  };
}

export interface FollowupPrTaskInput {
  agentName: string;
  lane?: string;
  issue?: OptionalIssueRef;
  pullRequest: PullRequestRef;
  reasons: string[];
  instructions?: string;
  stopAfter?: string;
  forbiddenActions?: string[];
}

export function createFollowupPrTask(input: FollowupPrTaskInput): FollowupPrTask {
  return {
    type: "followup-pr",
    shouldRun: true,
    agentName: input.agentName,
    lane: input.lane,
    issue: input.issue,
    pullRequest: input.pullRequest,
    reasons: input.reasons,
    instructions: input.instructions ?? FOLLOWUP_PR_INSTRUCTIONS,
    stopAfter: input.stopAfter ?? FOLLOWUP_PR_STOP_AFTER,
    forbiddenActions: input.forbiddenActions ? [...input.forbiddenActions] : [...FOLLOWUP_PR_FORBIDDEN],
  };
}

export interface GroomTaskInput {
  agentName: string;
  issue?: IssueRef;
  instructions?: string;
  stopAfter?: string;
  forbiddenActions?: string[];
}

export function createGroomTask(input: GroomTaskInput): GroomTask {
  return {
    type: "groom",
    shouldRun: true,
    agentName: input.agentName,
    issue: input.issue,
    instructions: input.instructions ?? GROOM_INSTRUCTIONS,
    stopAfter: input.stopAfter ?? GROOM_STOP_AFTER,
    forbiddenActions: input.forbiddenActions ? [...input.forbiddenActions] : [...GROOM_FORBIDDEN],
  };
}
