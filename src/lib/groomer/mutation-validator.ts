/**
 * Apply-time validation of a GroomingPlan (dispatch#1063).
 *
 * A plan is analysis of one evidence snapshot. Between capturing that
 * snapshot and writing to GitHub, a human, a webhook, a merge or another
 * agent can change the issue or the default branch. Immediately before the
 * first mutation, the groomer re-reads live state and checks that the
 * evidence the plan was built on still holds. If any precondition changed or
 * cannot be verified, the run applies zero grooming mutations.
 *
 * This module only reads. It never writes to GitHub or the database, so a
 * dry run uses exactly the same checks as write mode.
 */

import type { CommitComparison } from "@/lib/github-code-search";
import { isAutomationAuthor } from "./context";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import {
  deriveEvidenceReliance,
  deriveEvidenceScope,
  hasNegativeSearchResult,
  intersectEvidencePaths,
  recheckNegativeSearches,
  savedNegativeSearchQueries,
  type ExplorationToolCallLike,
  type NegativeSearchRecheckProbe,
} from "./freshness";
import { evaluateReadiness, type ChildBrief, type GroomingPlan } from "./plan";
import type { EvidenceCatalog } from "./plan-evidence";
import { evaluateCloseGrounding } from "./close-grounding";
import { sanitizeModelText } from "./sanitize";

// ─── Preconditions ────────────────────────────────────────────────────────────

/**
 * - issue: the live issue (title, body, labels, state) still matches the
 *   snapshot, and is still open.
 * - comments: no human comment arrived after the evidence window opened.
 * - head: the default branch and its head still match the pinned SHA, or the
 *   head moved without touching any repository evidence the plan relies on.
 */
export const PRECONDITION_NAMES = ["issue", "comments", "head"] as const;
export type PreconditionName = (typeof PRECONDITION_NAMES)[number];

/**
 * - passed: verified unchanged.
 * - changed: live state differs from the evidence; the plan is stale.
 * - unverifiable: live state could not be read or compared; fails closed.
 * - skipped: nothing to check (the snapshot had no pin to compare against).
 */
export type PreconditionStatus = "passed" | "changed" | "unverifiable" | "skipped";

export interface PreconditionCheck {
  name: PreconditionName;
  status: PreconditionStatus;
  detail: string;
}

export interface LiveIssueState {
  title: string;
  body: string | null;
  labels: string[];
  state: string;
}

export interface LiveComment {
  id: number | null;
  author: string;
  createdAt: string;
  body: string;
  url: string | null;
}

export interface PreconditionResult {
  /** True only when every check passed or was skipped. */
  ok: boolean;
  checks: PreconditionCheck[];
  /** `<name>: <detail>` for every changed/unverifiable check, in check order. */
  failures: string[];
  /** The live issue as re-read, when it could be read. */
  live: LiveIssueState | null;
  liveHeadSha: string | null;
  /** Most recent comments, newest first, as re-read (for comment dedupe). */
  recentComments: LiveComment[];
}

/**
 * Live reads for the preconditions. `recapture` must use the same capture
 * path as the run's evidence snapshot, so the comparison is like for like.
 */
export interface PreconditionReader {
  /** A fresh evidence snapshot (live issue, default branch, head SHA). Never throws. */
  recapture(): Promise<GroomingEvidenceSnapshot>;
  /** Most recent comments, newest first. */
  fetchRecentComments(max: number): Promise<LiveComment[]>;
  compareCommits(base: string, head: string): Promise<CommitComparison>;
  /**
   * Re-run a saved empty code-search query against the live head (#1116).
   * Optional: a global result with saved queries falls back to the
   * conservative stale-on-move behaviour when this (and `fetchCommitDate`)
   * is absent, because the negative evidence cannot be re-confirmed.
   */
  searchCode?(repoFullName: string, query: string, limit: number): Promise<unknown[]>;
  /** Read a commit's date for the search-index grace window (#1116). Optional, see `searchCode`. */
  fetchCommitDate?(repoFullName: string, sha: string): Promise<string | null>;
}

/** Comments re-read before apply: new-human-comment check and marker dedupe. */
export const PRECONDITION_COMMENT_WINDOW = 30;

export interface PreconditionInput {
  repoFullName: string;
  issueNumber: number;
  evidence: GroomingEvidenceSnapshot;
  /** When the run started reading comments: a human comment after this is new evidence. */
  evidenceWindowStart: Date;
  plan: GroomingPlan;
  /** What the run consulted, so a head move is judged against the plan's evidence scope. */
  repositoryQueries: string[];
  /** Repository-context searches that completed with zero results (#1115). */
  repositoryEmptyQueries?: string[];
  explorationRan: boolean;
  explorationToolCalls: ExplorationToolCallLike[];
  /** Clock for the search-index grace window; defaults to the real clock (#1116). */
  now?: () => Date;
}

function errorMessage(err: unknown): string {
  // GitHub-authored failure text is foreign input into Postgres errorMessage
  // columns (dispatch#1164): strip NUL and the other C0 controls (keep \n/\t).
  return sanitizeModelText(err instanceof Error ? err.message : String(err));
}

function sortedLabels(labels: string[]): string[] {
  return [...new Set(labels)].sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function checkIssue(input: PreconditionInput, fresh: GroomingEvidenceSnapshot): { check: PreconditionCheck; live: LiveIssueState | null } {
  const captured = input.evidence.issue;
  const current = fresh.issue;
  if (current.state === "unknown") {
    const why = fresh.warnings.find((w) => w.includes("issue")) ?? "the live issue could not be read";
    return { check: { name: "issue", status: "unverifiable", detail: `failed to re-read the live issue: ${why}` }, live: null };
  }
  const live: LiveIssueState = {
    title: current.title,
    body: current.body ?? null,
    labels: sortedLabels(current.labels),
    state: current.state,
  };
  if (captured.state === "unknown" || !input.evidence.issueFingerprint) {
    return {
      check: {
        name: "issue",
        status: "unverifiable",
        detail: "the evidence snapshot did not capture the live issue, so the plan cannot be shown to match it",
      },
      live,
    };
  }

  const changed: string[] = [];
  if (live.title !== captured.title) changed.push("title");
  if ((live.body ?? null) !== (captured.body ?? null)) changed.push("body");
  const capturedLabels = sortedLabels(captured.labels);
  if (!sameList(live.labels, capturedLabels)) {
    const added = live.labels.filter((label) => !capturedLabels.includes(label));
    const removed = capturedLabels.filter((label) => !live.labels.includes(label));
    const delta = [...added.map((l) => `+${l}`), ...removed.map((l) => `-${l}`)].join(" ");
    changed.push(`labels (${delta})`);
  }
  if (live.state !== captured.state) changed.push(`state (${captured.state} -> ${live.state})`);
  if (changed.length > 0) {
    return {
      check: { name: "issue", status: "changed", detail: `issue changed since the evidence snapshot: ${changed.join(", ")}` },
      live,
    };
  }
  if (live.state !== "open") {
    return { check: { name: "issue", status: "changed", detail: `issue is ${live.state}, not open` }, live };
  }
  return { check: { name: "issue", status: "passed", detail: "title, body, labels and state unchanged" }, live };
}

async function checkComments(
  input: PreconditionInput,
  reader: PreconditionReader,
): Promise<{ check: PreconditionCheck; comments: LiveComment[] }> {
  let comments: LiveComment[];
  try {
    comments = await reader.fetchRecentComments(PRECONDITION_COMMENT_WINDOW);
  } catch (err) {
    return {
      check: { name: "comments", status: "unverifiable", detail: `failed to re-read comments: ${errorMessage(err)}` },
      comments: [],
    };
  }
  const since = input.evidenceWindowStart.getTime();
  const newer = comments.filter((comment) => {
    const at = Date.parse(comment.createdAt);
    return !Number.isFinite(at) || at > since;
  });
  const human = newer.find((comment) => !isAutomationAuthor(comment.author));
  if (human) {
    return {
      check: { name: "comments", status: "changed", detail: `new comment by ${human.author} after the evidence was captured` },
      comments,
    };
  }
  // A full window of only-new comments may hide an older new human one.
  if (comments.length >= PRECONDITION_COMMENT_WINDOW && newer.length === comments.length) {
    return {
      check: {
        name: "comments",
        status: "unverifiable",
        detail: `more new comments than the check reads (${PRECONDITION_COMMENT_WINDOW}); cannot rule out a human one`,
      },
      comments,
    };
  }
  return { check: { name: "comments", status: "passed", detail: "no human comment since the evidence was captured" }, comments };
}

async function checkHead(
  input: PreconditionInput,
  fresh: GroomingEvidenceSnapshot,
  reader: PreconditionReader,
): Promise<{ check: PreconditionCheck; liveHeadSha: string | null }> {
  const { evidence } = input;
  if (!evidence.headSha || !evidence.defaultBranch) {
    // Nothing was pinned, so nothing pinned can have moved. Such a plan
    // cannot be ready or close (both require evidence read at a pinned SHA);
    // the ready/close policies enforce that independently.
    return {
      check: {
        name: "head",
        status: "skipped",
        detail: "the evidence snapshot was not pinned to a head SHA; no repository evidence is pinned",
      },
      liveHeadSha: fresh.headSha,
    };
  }
  if (!fresh.defaultBranch || !fresh.headSha) {
    const why = fresh.warnings.find((w) => w.includes("head SHA")) ?? "the default-branch head could not be resolved";
    return { check: { name: "head", status: "unverifiable", detail: why }, liveHeadSha: null };
  }
  if (fresh.defaultBranch !== evidence.defaultBranch) {
    return {
      check: { name: "head", status: "changed", detail: `default branch changed: ${evidence.defaultBranch} -> ${fresh.defaultBranch}` },
      liveHeadSha: fresh.headSha,
    };
  }
  const liveHeadSha = fresh.headSha;
  if (liveHeadSha === evidence.headSha) {
    return { check: { name: "head", status: "passed", detail: `${evidence.defaultBranch} head unchanged` }, liveHeadSha };
  }

  // The head moved. Judge the move against what this plan relies on, with
  // the same rules the freshness pass (#1064) applies after an applied groom.
  const range = `${evidence.headSha.slice(0, 12)}...${liveHeadSha.slice(0, 12)}`;
  const reliance = deriveEvidenceReliance(evidence.sources, input.plan.citations);
  const scope = deriveEvidenceScope({
    repositoryPaths: reliance.repositoryPaths,
    negativeSearch: hasNegativeSearchResult(input.explorationToolCalls),
    repositoryConsulted: input.explorationRan || input.repositoryQueries.length > 0,
    reliesOnSurfacedPath: reliance.reliesOnSurfacedPath,
  });
  if (scope === "none") {
    return {
      check: { name: "head", status: "passed", detail: `head moved ${range}; the plan relies on no repository evidence` },
      liveHeadSha,
    };
  }
  const savedQueries = savedNegativeSearchQueries({
    explorationToolCalls: input.explorationToolCalls,
    repositoryQueries: input.repositoryQueries,
    repositoryEmptyQueries: input.repositoryEmptyQueries,
    reliesOnSurfacedPath: reliance.reliesOnSurfacedPath,
    repositoryPaths: reliance.repositoryPaths,
  });
  const probe: NegativeSearchRecheckProbe | null =
    reader.searchCode && reader.fetchCommitDate
      ? { searchCode: reader.searchCode, fetchCommitDate: reader.fetchCommitDate }
      : null;
  if (scope === "global" && (savedQueries.length === 0 || probe === null)) {
    // No saved empty searches to re-run, or no way to re-run them: keep the
    // conservative stale-on-move behaviour, and do not spend a compare
    // (there is nothing to reconfirm against). This matches the pre-#1116
    // behaviour and the case where the freshness pass could not recheck.
    return {
      check: { name: "head", status: "changed", detail: `head moved ${range} and the plan relies on repo-wide evidence` },
      liveHeadSha,
    };
  }

  let comparison: CommitComparison;
  try {
    comparison = await reader.compareCommits(evidence.headSha, liveHeadSha);
  } catch (err) {
    comparison = { ok: false, httpStatus: null, definitive: false, message: errorMessage(err) };
  }
  if (!comparison.ok) {
    return {
      check: {
        name: "head",
        status: comparison.definitive ? "changed" : "unverifiable",
        detail: `head moved ${range} and cannot be compared: ${comparison.message}`,
      },
      liveHeadSha,
    };
  }
  if (comparison.status === "identical") {
    return { check: { name: "head", status: "passed", detail: `head moved ${range} with identical content` }, liveHeadSha };
  }
  if (comparison.status !== "ahead" || comparison.truncated) {
    const why = comparison.truncated ? "changed-file list truncated" : `history ${comparison.status}`;
    return { check: { name: "head", status: "changed", detail: `head moved ${range}: ${why}` }, liveHeadSha };
  }
  const hits = intersectEvidencePaths(reliance.repositoryPaths, comparison.files);
  if (hits.length > 0) {
    const shown = hits.slice(0, 5).join(", ") + (hits.length > 5 ? `, +${hits.length - 5} more` : "");
    return { check: { name: "head", status: "changed", detail: `head moved ${range} and touched ${shown}` }, liveHeadSha };
  }
  if (scope === "global") {
    // A global result whose relied-on read paths the move did NOT touch: its
    // saved empty searches decide, reusing the shared recheck so the apply-time
    // precondition agrees with the freshness pass's applyComparison recheck
    // (#1116). probe is non-null here: step 2 returned when it was null.
    const recheck = await recheckNegativeSearches({
      repoFullName: input.repoFullName,
      queries: savedQueries,
      probe: probe as NegativeSearchRecheckProbe,
      resolveHeadDate: async () => {
        try {
          const at = await reader.fetchCommitDate!(input.repoFullName, liveHeadSha);
          const parsed = at ? Date.parse(at) : Number.NaN;
          return Number.isNaN(parsed) ? { state: "failed" as const } : { state: "ok" as const, at: parsed };
        } catch {
          return { state: "failed" as const };
        }
      },
      trySpend: () => true,
      now: input.now ?? (() => new Date()),
    });
    switch (recheck.kind) {
      case "confirmed_absent":
        return {
          check: { name: "head", status: "passed", detail: `head moved ${range}; re-checked saved empty searches confirm the negative evidence` },
          liveHeadSha,
        };
      case "matched":
        return {
          check: { name: "head", status: "changed", detail: `head moved ${range}; a previously empty search now matches: ${recheck.query}` },
          liveHeadSha,
        };
      case "head_too_recent":
        return {
          check: { name: "head", status: "changed", detail: `head moved ${range} within the search-index grace window; negative evidence not re-confirmed` },
          liveHeadSha,
        };
      case "recheck_failed":
      case "budget_exhausted":
      case "unavailable":
        return {
          check: { name: "head", status: "changed", detail: `head moved ${range} and the plan relies on repo-wide evidence` },
          liveHeadSha,
        };
    }
  }
  return {
    check: { name: "head", status: "passed", detail: `head moved ${range} without touching the plan's evidence paths` },
    liveHeadSha,
  };
}

/**
 * Re-read live state and check every precondition. All checks run, so the
 * run records everything that changed; none of them writes.
 */
export async function validateApplyPreconditions(
  input: PreconditionInput,
  reader: PreconditionReader,
): Promise<PreconditionResult> {
  let fresh: GroomingEvidenceSnapshot | null = null;
  let recaptureError: string | null = null;
  try {
    fresh = await reader.recapture();
  } catch (err) {
    recaptureError = errorMessage(err);
  }

  let issue: { check: PreconditionCheck; live: LiveIssueState | null };
  let head: { check: PreconditionCheck; liveHeadSha: string | null };
  if (fresh) {
    issue = checkIssue(input, fresh);
    head = await checkHead(input, fresh, reader);
  } else {
    const detail = `failed to re-read live state: ${recaptureError}`;
    issue = { check: { name: "issue", status: "unverifiable", detail }, live: null };
    head = { check: { name: "head", status: "unverifiable", detail }, liveHeadSha: null };
  }
  const comments = await checkComments(input, reader);

  const checks = [issue.check, comments.check, head.check];
  const failures = checks
    .filter((check) => check.status === "changed" || check.status === "unverifiable")
    .map((check) => `${check.name}: ${check.detail}`);
  return {
    ok: failures.length === 0,
    checks,
    failures,
    live: issue.live,
    liveHeadSha: head.liveHeadSha,
    recentComments: comments.comments,
  };
}

// ─── Mutation policies ────────────────────────────────────────────────────────

function isPinnedRepositoryCitation(catalog: EvidenceCatalog, id: string): boolean {
  if (!catalog.binding.headSha) return false;
  const entry = catalog.entries.find((candidate) => candidate.id === id);
  return entry !== undefined && entry.subject === "repository" && entry.pinned;
}

/**
 * The stricter already_done close policy, evaluated at apply time. Returns
 * every reason the close may not be applied; empty means it may.
 *
 * On top of the plan validator's close rules (a decisive citation, no
 * material uncertainty), an applied close needs:
 * - an already_done verdict with an already_done close (duplicate and
 *   superseded closes are never applied);
 * - high verdict confidence;
 * - at least one close citation that is repository content read at the
 *   pinned head SHA (direct current-revision evidence), not only a PR,
 *   commit or comment;
 * - no material uncertainty of any kind;
 * - grounding for THIS issue (dispatch#1099): every acceptance criterion
 *   backed by a verbatim excerpt of a file read at the pinned head (with one
 *   of the issue's expected files among them, when it names any), or a cited
 *   merged PR whose closing reference is this issue.
 * The apply preconditions separately guarantee that the head has not moved
 * under that evidence and the issue is still open.
 */
export function evaluateClosePolicy(plan: GroomingPlan, catalog: EvidenceCatalog): string[] {
  const reasons: string[] = [];
  const close = plan.mutations.close;
  if (plan.verdict.actionability !== "already_done" || !close || close.reason !== "already_done") {
    reasons.push("only an already_done verdict with an already_done close is ever applied");
    return reasons;
  }
  if (plan.verdict.confidence !== "high") {
    reasons.push(`verdict confidence is ${plan.verdict.confidence}; closing requires high`);
  }
  if (!close.evidenceRefs.some((id) => isPinnedRepositoryCitation(catalog, id))) {
    reasons.push("the close cites no repository content read at the pinned head SHA");
  }
  plan.verdict.uncertainties.forEach((u, i) => {
    if (u.material) reasons.push(`material uncertainty remains (verdict.uncertainties[${i}]): ${u.question}`);
  });
  reasons.push(...evaluateCloseGrounding({ evidenceRefs: close.evidenceRefs, criteria: close.criteria ?? [] }, catalog).errors);
  if (plan.evidence.evidenceDigest !== catalog.binding.evidenceDigest) {
    reasons.push("the plan is bound to a different evidence snapshot");
  }
  return reasons;
}

/**
 * Ready promotion re-checked at apply time. The plan validator already
 * rejects an inconsistent ready plan; this is the applier's own guard so a
 * status/ready label is never written for a plan whose readiness does not
 * hold against this run's catalog.
 */
export function evaluateReadyPolicy(plan: GroomingPlan, catalog: EvidenceCatalog): string[] {
  const reasons: string[] = [];
  if (plan.verdict.actionability !== "ready" || !plan.readiness.ready) {
    reasons.push("the plan's derived readiness is not ready");
  }
  if (plan.readiness.evidenceDigest !== catalog.binding.evidenceDigest || plan.evidence.evidenceDigest !== catalog.binding.evidenceDigest) {
    reasons.push("the plan's readiness is bound to a different evidence snapshot");
  }
  reasons.push(...evaluateReadiness(plan, catalog));
  return reasons;
}

/**
 * The child-brief fields that are missing from this brief, in field order
 * (dispatch#1066). A field counts as present when it is non-blank after
 * trimming; a list field needs at least one entry that trims non-empty
 * (whitespace-only entries do not count). `dependencies` is deliberately
 * never reported: a child may legitimately depend on nothing.
 */
export function childBriefCompletenessGaps(brief: ChildBrief): string[] {
  const gaps: string[] = [];
  if (brief.problem.trim().length === 0) gaps.push("problem");
  if (brief.designDecision === null || brief.designDecision.trim().length === 0) gaps.push("designDecision");
  if (brief.verifiedCurrentBehavior === null || brief.verifiedCurrentBehavior.trim().length === 0) {
    gaps.push("verifiedCurrentBehavior");
  }
  const lists: Array<[string, string[]]> = [
    ["relevantPaths", brief.relevantPaths],
    ["inScope", brief.inScope],
    ["outOfScope", brief.outOfScope],
    ["acceptanceCriteria", brief.acceptanceCriteria],
    ["tests", brief.tests],
  ];
  for (const [name, entries] of lists) {
    if (!entries.some((entry) => entry.trim().length > 0)) gaps.push(name);
  }
  return gaps;
}

/**
 * Decomposition re-checked at apply time (dispatch#1066). Returns every
 * reason the plan's children may not be created; empty means they may.
 *
 * A decomposition splits one issue into bounded children, so it is only
 * applied when the parent's analysis is decisive enough to trust the split:
 * - the plan does not also recommend closing the issue (a closed parent has
 *   no children to carry its work);
 * - the verdict confidence is not low;
 * - no material uncertainty of any kind remains.
 * The apply preconditions separately guarantee the issue is still open.
 *
 * Every child brief must also be a COMPLETE bounded implementation brief,
 * because each one becomes a real child GitHub issue that a fresh worker
 * has to implement with no other context:
 * - `problem` is non-blank (the plan parser already guarantees this; it is
 *   enforced again so a forged plan cannot slip past);
 * - `designDecision` is a non-blank string; null is rejected. Even the
 *   outcome "no design choice, follow existing pattern X" must be stated,
 *   so the worker knows nothing is left to decide;
 * - `verifiedCurrentBehavior` is a non-blank string; null is rejected —
 *   the brief must carry the current behavior the parent's analysis
 *   verified;
 * - `relevantPaths`, `inScope`, `outOfScope`, `acceptanceCriteria` and
 *   `tests` each contain at least one entry whose trimmed value is
 *   non-empty (whitespace-only entries do not count as present);
 * - `dependencies` may legitimately be empty: a child may depend on
 *   nothing, so it is never a reason.
 * Each incomplete brief is a reason of its own naming its index and
 * missing fields (see childBriefCompletenessGaps), so the run records
 * exactly which children and which fields are short.
 */
export function evaluateDecompositionPolicy(plan: GroomingPlan): string[] {
  const reasons: string[] = [];
  if (plan.mutations.close) {
    reasons.push("the plan recommends closing the issue; a decomposed parent is not closed");
  }
  if (plan.verdict.confidence === "low") {
    reasons.push("verdict confidence is low; decomposition requires at least medium confidence");
  }
  plan.verdict.uncertainties.forEach((u, i) => {
    if (u.material) reasons.push(`material uncertainty remains (verdict.uncertainties[${i}]): ${u.question}`);
  });
  plan.decomposition.childBriefs.forEach((brief, i) => {
    const gaps = childBriefCompletenessGaps(brief);
    if (gaps.length > 0) {
      reasons.push(`child brief[${i}] is not a complete bounded implementation brief (missing: ${gaps.join(", ")})`);
    }
  });
  return reasons;
}
