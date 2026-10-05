/**
 * Builders for candidate model outputs, so a fixture states only what makes
 * its candidate interesting. Each returns a plain GroomingPlanDraft-shaped
 * object: exactly what the LLM call hands the validator.
 */
import type {
  Actionability,
  ChildBrief,
  CloseRecommendation,
  Confidence,
  GroomingPlanDraft,
  ImplementationBrief,
  RelatedWorkCandidate,
  Uncertainty,
  Verification,
} from "../plan";

interface CommonOptions {
  summary: string;
  rationale?: string;
  evidence: string[];
  confidence?: Confidence;
  lane?: string;
  uncertainties?: Uncertainty[];
  labelsToAdd?: string[];
  labelsToRemove?: string[];
  proposedTitle?: string | null;
  proposedBody?: string | null;
  githubComment?: string | null;
  relatedWork?: RelatedWorkCandidate[];
}

export interface BriefOptions {
  problem?: string;
  verified: { statement: string; evidence: string[] };
  paths?: Array<[ref: string, change: "modify" | "reference"]>;
  filesToCreate?: string[];
  inScope?: string[];
  outOfScope?: string[];
  criteria?: Array<[criterion: string, verification: Verification]>;
  dependencies?: ImplementationBrief["dependencies"];
  tests?: string[];
}

export function brief(o: BriefOptions): ImplementationBrief {
  return {
    problem: o.problem ?? o.verified.statement,
    verifiedCurrentBehavior: { statement: o.verified.statement, evidenceRefs: o.verified.evidence },
    relevantPaths: (o.paths ?? []).map(([ref, change]) => ({ ref, change })),
    filesToCreate: o.filesToCreate ?? [],
    invariants: [],
    inScope: o.inScope ?? ["the change described in the problem"],
    outOfScope: o.outOfScope ?? [],
    dependencies: o.dependencies ?? [],
    acceptanceCriteria: (o.criteria ?? [["a regression test covers the fix", "automated_test"]]).map(
      ([criterion, verification]) => ({ criterion, verification }),
    ),
    tests: o.tests ?? [],
  };
}

function base(
  actionability: Actionability,
  workType: "implementation" | "design",
  o: CommonOptions,
  laneDefault: string,
): GroomingPlanDraft {
  return {
    verdict: {
      actionability,
      workType,
      confidence: o.confidence ?? "high",
      lane: { id: o.lane ?? laneDefault, confidence: o.confidence ?? "high", reason: o.summary.slice(0, 120) },
      summary: o.summary,
      rationale: o.rationale ?? o.summary,
      evidenceRefs: o.evidence,
      uncertainties: o.uncertainties ?? [],
    },
    implementationBrief: null,
    mutations: {
      labelsToAdd: o.labelsToAdd ?? [],
      labelsToRemove: o.labelsToRemove ?? [],
      proposedTitle: o.proposedTitle ?? null,
      proposedBody: o.proposedBody ?? null,
      githubComment: o.githubComment ?? null,
      close: null,
    },
    decomposition: { required: false, reason: null, childBriefs: [] },
    relatedWork: o.relatedWork ?? [],
  };
}

/** A ready implementation verdict with a brief. */
export function readyImplementation(o: CommonOptions & { brief: BriefOptions; decomposition?: ChildBrief[] }): GroomingPlanDraft {
  const draft = base("ready", "implementation", o, "local");
  draft.implementationBrief = brief(o.brief);
  if (o.decomposition) {
    draft.decomposition = { required: true, reason: "the issue spans several independent areas", childBriefs: o.decomposition };
  }
  return draft;
}

/** A ready design verdict: routes to the escalation lane, no implementation brief. */
export function readyDesign(o: CommonOptions): GroomingPlanDraft {
  return base("ready", "design", o, "frontier");
}

/** A not-ready verdict that parks the issue. */
export function parked(
  actionability: "needs_info" | "blocked" | "backlog",
  o: CommonOptions & {
    workType?: "implementation" | "design";
    brief?: BriefOptions;
    decomposition?: ChildBrief[];
    close?: CloseRecommendation;
  },
): GroomingPlanDraft {
  const draft = base(actionability, o.workType ?? "implementation", o, "backlog");
  if (o.brief) draft.implementationBrief = brief(o.brief);
  if (o.decomposition) {
    draft.decomposition = { required: true, reason: "the issue spans several independent areas", childBriefs: o.decomposition };
  }
  if (o.close) draft.mutations.close = o.close;
  return draft;
}

/**
 * An already_done verdict with its close recommendation. `criteria` grounds
 * each acceptance criterion: [criterion, repo evidence id, verbatim excerpt].
 */
export function alreadyDone(
  o: CommonOptions & { closeEvidence: string[]; criteria?: Array<[criterion: string, evidenceRef: string, excerpt: string]> },
): GroomingPlanDraft {
  const draft = base("already_done", "implementation", o, "backlog");
  draft.mutations.close = {
    reason: "already_done",
    rationale: o.rationale ?? o.summary,
    evidenceRefs: o.closeEvidence,
    criteria: (o.criteria ?? []).map(([criterion, evidenceRef, excerpt]) => ({ criterion, evidenceRef, excerpt })),
  };
  return draft;
}

/** Child briefs for decomposition fixtures. */
export function children(titles: string[]): ChildBrief[] {
  return titles.map((title) => ({
    title,
    problem: `${title}, as its own bounded change.`,
    designDecision: null,
    verifiedCurrentBehavior: null,
    relevantPaths: [],
    inScope: [title.toLowerCase()],
    outOfScope: [],
    dependencies: [],
    acceptanceCriteria: [`${title} works end to end`],
    tests: [],
  }));
}
