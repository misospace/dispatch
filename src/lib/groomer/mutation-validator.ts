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
  type ExplorationToolCallLike,
} from "./freshness";
import { evaluateReadiness, type GroomingPlan } from "./plan";
import type { EvidenceCatalog } from "./plan-evidence";

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
  explorationRan: boolean;
  explorationToolCalls: ExplorationToolCallLike[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  if (scope === "global") {
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
 * - no material uncertainty of any kind.
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
