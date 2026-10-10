/**
 * already_done report close (dispatch#1143).
 *
 * A worker that concludes an issue's ask is already satisfied reports the
 * `already_done` outcome on `tasks/report` with a per-criterion, revision-pinned
 * evidence proposal. That assertion is NOT close authorization: Dispatch builds
 * its own evidence catalog from the trusted repo/issue identity and a live
 * GitHub read (default-branch head SHA, issue body/labels/state, comments),
 * reads the files the worker cites at that pinned SHA, and runs the SAME close
 * policy the hosted groomer applies (`evaluateClosePolicy`) against the
 * synthesized catalog. Only a grounded close lands; the reopen/regression veto
 * and pinned-head freshness come from that shared policy, so this path cannot
 * drift into a weaker second close policy.
 *
 * The worker's free-form `evidence` string and any confidence claim are never
 * read for authorization — they are recorded for audit only.
 */

import {
  addEvidenceSources,
  collectGroomingEvidenceSnapshot,
  type EvidenceSnapshotInput,
  type GroomingEvidenceSnapshot,
} from "@/lib/groomer/evidence-snapshot";
import { closeIssue, fetchIssue, fetchIssueComments } from "@/lib/github-issues";
import { fetchRepositoryFileText } from "@/lib/github-code-search";
import { transitionIssueStatus } from "@/lib/issue-status";
import { buildEvidenceCatalog, repositoryEvidenceId } from "@/lib/groomer/plan-evidence";
import {
  collectPinnedReadContent,
  isExplicitRegressionReport,
  reopenRegressionReasons,
  type PinnedRead,
} from "@/lib/groomer/close-grounding";
import { isAutomationAuthor } from "@/lib/groomer/context";
import {
  GROOMING_PLAN_SCHEMA_VERSION,
  type CloseCriterionEvidence,
  type GroomingPlan,
} from "@/lib/groomer/plan";
import { evaluateClosePolicy } from "@/lib/groomer/mutation-validator";

/** One acceptance criterion the worker grounds in a pinned repository excerpt. */
export interface ReportCloseCriterion {
  criterion: string;
  /** Repo-relative file path (no line anchors). */
  path: string;
  /** Verbatim excerpt of the file at the pinned head. */
  excerpt: string;
}

export interface ReportCloseInput {
  repoFullName: string;
  issueNumber: number;
  criteria: ReportCloseCriterion[];
  /** Optional free-form worker summary; recorded for audit only, never authorization. */
  evidence?: string;
}

export interface ReportCloseEvaluation {
  eligible: boolean;
  /** Field-path prefixed policy reasons the close may not be applied; empty when eligible. */
  reasons: string[];
  repoFullName: string;
  issueNumber: number;
  issueKey: string;
  headSha: string | null;
  defaultBranch: string | null;
  evidenceDigest: string | null;
  /** Live GitHub issue state ("open" | "closed" | "unknown"). */
  issueState: string;
  /** Sorted live labels. */
  liveLabels: string[];
  /** The criteria that were grounded (all of them when eligible). */
  criteria: Array<{ criterion: string; path: string }>;
}

/** How many recent comments are read for the reopen/regression veto. */
export const REPORT_CLOSE_COMMENT_WINDOW = 50;

export interface ReportCloseDeps {
  collectSnapshot?: (input: EvidenceSnapshotInput) => Promise<GroomingEvidenceSnapshot>;
  fetchComments?: (repoFullName: string, issueNumber: number) => Promise<EvidenceSnapshotInput["comments"]>;
  /** Fresh issue state re-read immediately before the GitHub close. */
  fetchIssueState?: (
    repoFullName: string,
    issueNumber: number,
  ) => Promise<{ state: string; stateReason?: string | null }>;
  readFile?: (repoFullName: string, path: string, ref: string) => Promise<string>;
  closeIssue?: (repoFullName: string, issueNumber: number) => Promise<void>;
  transitionStatus?: (
    repoFullName: string,
    issueNumber: number,
    currentLabels: string[],
    targetStatus: string,
  ) => Promise<string[]>;
  now?: () => Date;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function defaultFetchComments(
  repoFullName: string,
  issueNumber: number,
): Promise<EvidenceSnapshotInput["comments"]> {
  const comments = await fetchIssueComments(repoFullName, issueNumber, REPORT_CLOSE_COMMENT_WINDOW, "desc");
  return comments.map((comment) => ({
    id: comment.id ?? null,
    author: comment.user?.login ?? "",
    createdAt: comment.created_at ?? "",
    body: comment.body ?? "",
    authorAssociation: comment.author_association ?? null,
  }));
}

async function defaultFetchIssueState(
  repoFullName: string,
  issueNumber: number,
): Promise<{ state: string; stateReason?: string | null }> {
  const issue = await fetchIssue(repoFullName, issueNumber);
  return { state: issue.state, stateReason: issue.state_reason };
}

/**
 * Re-read the live issue and its recent comments immediately before the GitHub
 * close and re-run the reopen/regression veto (#1113). This is the apply-time
 * freshness re-check the hosted groomer performs between planning and writing;
 * here the snapshot and the close are one request apart, so this closes the
 * remaining window. Fails closed: any read that cannot be performed is a
 * refusal reason, never a silent pass. Returns [] when the close may proceed.
 */
export async function recheckCloseFreshness(
  input: Pick<ReportCloseInput, "repoFullName" | "issueNumber">,
  deps: ReportCloseDeps = {},
): Promise<string[]> {
  const fetchIssueState = deps.fetchIssueState ?? defaultFetchIssueState;
  const fetchComments = deps.fetchComments ?? defaultFetchComments;

  let state: { state: string; stateReason?: string | null };
  try {
    state = await fetchIssueState(input.repoFullName, input.issueNumber);
  } catch (err) {
    return [
      `issue: the issue state could not be re-read immediately before the close (${errorMessage(err)}); failing closed`,
    ];
  }

  const reasons: string[] = [];
  if (state.state !== "open") {
    reasons.push(`issue: the issue is ${state.state}, not open at close time`);
  }

  let regressionReports: string[] = [];
  try {
    const comments = await fetchComments(input.repoFullName, input.issueNumber);
    regressionReports = comments
      .filter((comment) => !isAutomationAuthor(comment.author) && isExplicitRegressionReport(comment.body))
      .slice(0, 5)
      .map((comment) => `comment:${comment.id ?? "?"} by ${comment.author}`);
  } catch (err) {
    return [
      `comments: recent comments could not be re-read immediately before the close (${errorMessage(err)}); failing closed`,
    ];
  }

  reasons.push(
    ...reopenRegressionReasons({
      reopened: state.stateReason === "reopened",
      historyKnown: state.stateReason !== undefined,
      regressionReports,
    }),
  );
  return reasons;
}

/**
 * Build the server-derived, revision-pinned catalog and evaluate the shared
 * close policy against the worker's proposed criteria. Read-only: it never
 * closes anything. Fails closed — every read that cannot be performed becomes a
 * refusal reason rather than a silent pass.
 */
export async function evaluateReportClose(
  input: ReportCloseInput,
  deps: ReportCloseDeps = {},
): Promise<ReportCloseEvaluation> {
  const collectSnapshot = deps.collectSnapshot ?? collectGroomingEvidenceSnapshot;
  const fetchComments = deps.fetchComments ?? defaultFetchComments;
  const readFile = deps.readFile ?? fetchRepositoryFileText;

  const reasons: string[] = [];
  const issueKey = `${input.repoFullName}#${input.issueNumber}`;

  const comments = await fetchComments(input.repoFullName, input.issueNumber);
  const snapshot = await collectSnapshot({
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    comments,
  });

  if (snapshot.issue.state === "unknown") {
    reasons.push("issue: the live issue could not be read, so the close cannot be grounded");
  }
  const headSha = snapshot.headSha;
  if (!headSha) {
    reasons.push(
      "head: the default-branch head SHA could not be resolved, so no repository evidence can be pinned",
    );
  }

  // The cited paths enter the catalog as reads at the pinned head. A path that
  // is not actually readable at that head keeps its (pinned) catalog entry but
  // has no pinned content, so its criterion is refused below — fail closed.
  const paths = [...new Set(input.criteria.map((criterion) => criterion.path))];
  const withSources = addEvidenceSources(snapshot, paths, "read");

  const reads: PinnedRead[] = [];
  if (headSha) {
    for (const path of paths) {
      try {
        const content = await readFile(input.repoFullName, path, headSha);
        if (content) reads.push({ path, ref: headSha, content });
      } catch {
        // Unreadable path (404, directory, transient): leave it unread so the
        // grounding check refuses the criterion that cites it.
      }
    }
  }
  const pinnedContent = collectPinnedReadContent(headSha, reads);
  const catalog = buildEvidenceCatalog(withSources, pinnedContent);

  const evidenceRefs = [...new Set(input.criteria.map((criterion) => repositoryEvidenceId(criterion.path)))];
  const criteria: CloseCriterionEvidence[] = input.criteria.map((criterion) => ({
    criterion: criterion.criterion,
    evidenceRef: repositoryEvidenceId(criterion.path),
    excerpt: criterion.excerpt,
  }));

  // A synthetic already_done plan exists ONLY to drive the shared policy. Its
  // verdict/confidence/uncertainty fields are server-set constants; nothing here
  // comes from the worker, whose only input is the proposed criteria.
  const plan: GroomingPlan = {
    schemaVersion: GROOMING_PLAN_SCHEMA_VERSION,
    verdict: {
      actionability: "already_done",
      workType: "implementation",
      confidence: "high",
      lane: { id: "backlog", confidence: "high", reason: "already_done report" },
      summary: "worker reported already_done",
      rationale:
        "close authorization is derived from the server-built, revision-pinned evidence catalog, not the worker's assertion",
      evidenceRefs,
      uncertainties: [],
    },
    implementationBrief: null,
    mutations: {
      labelsToAdd: [],
      labelsToRemove: [],
      proposedTitle: null,
      proposedBody: null,
      githubComment: null,
      close: {
        reason: "already_done",
        rationale: "worker reported the issue already satisfied",
        evidenceRefs,
        criteria,
      },
      status: "status/done",
    },
    decomposition: { required: false, reason: null, childBriefs: [] },
    relatedWork: [],
    evidence: { ...catalog.binding },
    readiness: {
      ready: false,
      admission: null,
      lane: null,
      evidenceDigest: catalog.binding.evidenceDigest,
      reasons: [],
    },
    citations: [],
  };

  reasons.push(...evaluateClosePolicy(plan, catalog));
  if (snapshot.issue.state !== "open") {
    reasons.push(
      `issue: the issue is ${snapshot.issue.state}, not open; an already_done close only closes an open issue`,
    );
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    issueKey,
    headSha,
    defaultBranch: snapshot.defaultBranch,
    evidenceDigest: catalog.binding.evidenceDigest,
    issueState: snapshot.issue.state,
    liveLabels: snapshot.issue.labels,
    criteria: input.criteria.map((criterion) => ({ criterion: criterion.criterion, path: criterion.path })),
  };
}

/** The Prisma slice the close applies: the issue mirror and the audit log. */
export interface ReportCloseClient {
  issue: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface ApplyReportCloseInput {
  evaluation: ReportCloseEvaluation;
  actor: string;
  issueId: string | null;
  client: ReportCloseClient;
  evidence?: string;
  deps?: ReportCloseDeps;
}

export interface ApplyReportCloseResult {
  closed: boolean;
  labelsAfter: string[];
  warning?: string;
}

/**
 * Apply a close the evaluation found eligible. The GitHub close is the one
 * write that must land; the status label, the Prisma mirror and the audit row
 * are applied best-effort afterwards so a partial failure is surfaced as a
 * warning rather than leaving the issue open with a half-recorded close.
 */
export async function applyReportClose(input: ApplyReportCloseInput): Promise<ApplyReportCloseResult> {
  const { evaluation } = input;
  if (!evaluation.eligible) {
    throw new Error("applyReportClose called with a non-eligible evaluation");
  }
  const deps = input.deps ?? {};
  const doClose = deps.closeIssue ?? closeIssue;
  const doTransition = deps.transitionStatus ?? transitionIssueStatus;
  const now = deps.now ?? (() => new Date());

  // The highest-impact write. A failure here propagates: the issue is not
  // closed, so the caller records a failed close instead of a false success.
  await doClose(evaluation.repoFullName, evaluation.issueNumber);

  let warning: string | undefined;
  const addWarning = (message: string) => {
    warning = warning ? `${warning}; ${message}` : message;
  };

  let labelsAfter: string[];
  try {
    labelsAfter = await doTransition(
      evaluation.repoFullName,
      evaluation.issueNumber,
      evaluation.liveLabels,
      "status/done",
    );
  } catch (err) {
    addWarning(`the status/done label write failed: ${errorMessage(err)}`);
    labelsAfter = [
      ...evaluation.liveLabels.filter((label) => !label.startsWith("status/")),
      "status/done",
    ];
  }

  if (input.issueId) {
    try {
      await input.client.issue.update({
        where: { id: input.issueId },
        data: { state: "closed", closedAt: now(), labels: labelsAfter },
      });
    } catch (err) {
      addWarning(`the issue mirror update failed: ${errorMessage(err)}`);
    }
  }

  try {
    await input.client.auditLog.create({
      data: {
        actor: input.actor,
        action: "already_done",
        repoFullName: evaluation.repoFullName,
        issueNumber: evaluation.issueNumber,
        issueId: input.issueId,
        beforeLabels: evaluation.liveLabels,
        afterLabels: labelsAfter,
        success: true,
        notes: JSON.stringify({
          evidenceDigest: evaluation.evidenceDigest,
          headSha: evaluation.headSha,
          defaultBranch: evaluation.defaultBranch,
          criteria: evaluation.criteria,
          evidence: input.evidence ?? null,
        }),
      },
    });
  } catch (err) {
    addWarning(`the audit log write failed: ${errorMessage(err)}`);
  }

  return { closed: true, labelsAfter, ...(warning ? { warning } : {}) };
}

export interface ResolveAlreadyDoneInput {
  repoFullName: string;
  issueNumber: number;
  criteria: ReportCloseCriterion[];
  evidence?: string;
  actor: string;
  issueId: string | null;
  client: ReportCloseClient;
  deps?: ReportCloseDeps;
}

export interface ResolveAlreadyDoneResult {
  matched: boolean;
  action: "closed" | "refused" | "failed" | "skipped";
  reason: string;
  reasons: string[];
  repoFullName: string;
  issueNumber: number;
  headSha: string | null;
  evidenceDigest: string | null;
  criteria: Array<{ criterion: string; path: string }>;
}

/**
 * Resolve an `already_done` report: evaluate the shared close policy against a
 * server-built catalog and, only when it is satisfied, close the issue. Never
 * throws — every failure becomes a structured result the route can persist for
 * an idempotent replay, so a partial GitHub success is never re-executed.
 */
export async function resolveAlreadyDoneFromAgentReport(
  input: ResolveAlreadyDoneInput,
): Promise<ResolveAlreadyDoneResult> {
  const empty = {
    matched: true,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    headSha: null,
    evidenceDigest: null,
    criteria: [] as Array<{ criterion: string; path: string }>,
  };

  let evaluation: ReportCloseEvaluation;
  try {
    evaluation = await evaluateReportClose(
      {
        repoFullName: input.repoFullName,
        issueNumber: input.issueNumber,
        criteria: input.criteria,
        evidence: input.evidence,
      },
      input.deps,
    );
  } catch (err) {
    return { ...empty, action: "failed", reason: `close evaluation failed: ${errorMessage(err)}`, reasons: [] };
  }

  const base = {
    matched: true,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    headSha: evaluation.headSha,
    evidenceDigest: evaluation.evidenceDigest,
    criteria: evaluation.criteria,
  };

  if (!evaluation.eligible) {
    return {
      ...base,
      action: "refused",
      reason: `close policy not satisfied: ${evaluation.reasons.join("; ")}`,
      reasons: evaluation.reasons,
    };
  }

  // Apply-time freshness re-check: re-read the issue and recent comments
  // immediately before the close and re-run the reopen/regression veto, so a
  // reopen or a new regression report in the snapshot-to-close window still
  // withholds the close (dispatch#1143).
  const freshness = await recheckCloseFreshness(
    { repoFullName: input.repoFullName, issueNumber: input.issueNumber },
    input.deps,
  );
  if (freshness.length > 0) {
    return {
      ...base,
      action: "refused",
      reason: `close re-check failed immediately before closing: ${freshness.join("; ")}`,
      reasons: freshness,
    };
  }

  try {
    const applied = await applyReportClose({
      evaluation,
      actor: input.actor,
      issueId: input.issueId,
      client: input.client,
      evidence: input.evidence,
      deps: input.deps,
    });
    return {
      ...base,
      action: "closed",
      reason: applied.warning
        ? `issue closed after the close policy was satisfied (warning: ${applied.warning})`
        : "issue closed after the close policy was satisfied",
      reasons: [],
    };
  } catch (err) {
    return { ...base, action: "failed", reason: `the GitHub close failed: ${errorMessage(err)}`, reasons: [] };
  }
}
