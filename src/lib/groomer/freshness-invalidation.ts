/**
 * Cheap, bounded invalidation of grooming results (#1064).
 *
 * Runs after an issue sync, against the state that sync just cached. It
 * never invokes a model and never runs a groom: it only marks a fresh
 * grooming baseline stale (with reasons) so the periodic groomer's selector
 * picks the issue up again. Checks are ordered cheapest first — database
 * comparisons, then a bounded number of GitHub reads — and an issue that
 * cannot be fully checked within the budget is simply left for the next
 * pass rather than guessed at.
 *
 * Idempotent: every write is guarded on the baseline it evaluated
 * (groomedRunId) and on the issue still being fresh, so a repeated pass, or
 * one racing a new groom, cannot double-mark or stale a newer baseline.
 */
import { prisma } from "@/lib/prisma";
import { fetchIssue, fetchIssueComments } from "@/lib/github-issues";
import { fetchPullRequestState } from "@/lib/github-prs";
import { fetchLatestCommit, fetchCommitDate } from "@/lib/github-ci";
import { compareCommits, searchRepositoryCode, type CommitComparison } from "@/lib/github-code-search";
import { dependencyKey } from "@/lib/issue-dependencies";
import { findOpenIssueKeys } from "@/lib/issue-dependency-annotation";
import { isAutomationAuthor } from "./context";
import {
  buildGroomingFreshnessBaseline,
  computeGroomingIssueFingerprint,
  intersectEvidencePaths,
  isFreshnessTrackedStatus,
  parseDependencyKey,
  readRelatedWorkBaseline,
  UNKNOWN_FRESHNESS,
  type GroomingFreshnessInput,
  type GroomingStaleReason,
  type RelatedWorkBaselineEntry,
} from "./freshness";

export const FRESHNESS_ACTOR = "grooming-freshness";

export interface FreshnessIssueRow {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  commentsCount: number;
  groomedRunId: string | null;
  groomedHeadSha: string | null;
  groomedDefaultBranch: string | null;
  groomedIssueFingerprint: string | null;
  groomedCommentCount: number | null;
  groomedEvidenceCapturedAt: Date | null;
  groomedEvidenceScope: string | null;
  groomedEvidencePaths: string[];
  groomedSearchCodeQueries: string[];
  groomedDependencyKeys: string[];
  groomedOpenBlockerKeys: string[];
  groomedRelatedWork: unknown;
  groomingVerifiedSha: string | null;
}

export interface StaleMark {
  reasons: GroomingStaleReason[];
  detail: string;
}

export interface FreshnessStore {
  /** Open issues in the repo with a fresh (baselined, not stale) grooming result. */
  findFreshIssues(repositoryId: string, take: number): Promise<FreshnessIssueRow[]>;
  /** Subset of `owner/repo#N` keys that are open issues in enabled repos. */
  findOpenIssueKeys(numbers: number[]): Promise<Set<string>>;
  /** Cached open/closed state of tracked issues, keyed `owner/repo#N` (lowercased repo). */
  findCachedIssueStates(numbers: number[]): Promise<Map<string, "open" | "closed">>;
  /** Mark stale if the baseline is still `groomedRunId` and still fresh. Returns whether it wrote. */
  markStale(issue: FreshnessIssueRow, mark: StaleMark, at: Date): Promise<boolean>;
  /** Advance verification of a still-fresh baseline (no-op when it was replaced or staled). */
  advance(issue: FreshnessIssueRow, data: { groomingVerifiedSha?: string; groomedCommentCount?: number }): Promise<void>;
  recordAudit(repoFullName: string, issue: FreshnessIssueRow, mark: StaleMark): Promise<void>;
}

export interface FreshnessGitHub {
  fetchHeadSha(repoFullName: string, branch: string): Promise<string | null>;
  searchCode?(repoFullName: string, query: string, limit: number): Promise<{ path: string }[]>;
  /** Committer timestamp for a sha; used to judge code-search index catch-up. */
  fetchCommitDate?(repoFullName: string, sha: string): Promise<string | null>;
  compareCommits(repoFullName: string, base: string, head: string): Promise<CommitComparison>;
  fetchRecentComments(
    repoFullName: string,
    issueNumber: number,
    max: number,
  ): Promise<Array<{ author: string; createdAt: string }>>;
  fetchIssueState(repoFullName: string, issueNumber: number): Promise<"open" | "closed" | null>;
  fetchPullRequestState(repoFullName: string, prNumber: number): Promise<"open" | "closed" | "merged" | null>;
}

export interface FreshnessBudget {
  /** Fresh issues evaluated per repo per pass. */
  maxIssuesPerRepo: number;
  /** Commit comparisons per pass (one per distinct verified SHA, shared by every issue at it). */
  maxCompares: number;
  /** Issue comment reads per pass. */
  maxCommentFetches: number;
  /** Related issue/PR state reads per pass (tracked issues come from the cache, free). */
  maxRelatedFetches: number;
  /** Saved negative code-search queries rechecked per pass. */
  maxSearchCodeRechecks: number;
  /** Comments read per comment check. */
  commentWindow: number;
}

export const DEFAULT_FRESHNESS_BUDGET: FreshnessBudget = {
  maxIssuesPerRepo: 200,
  maxCompares: 10,
  maxCommentFetches: 10,
  maxRelatedFetches: 10,
  maxSearchCodeRechecks: 20,
  commentWindow: 30,
};

/**
 * GitHub code search runs against an index that can lag the default branch.
 * A saved empty query only counts as "still absent" once the new head commit
 * is at least this old; younger heads defer the recheck to a later pass
 * (#1091). Failures and missing timestamps stay conservative instead.
 */
export const SEARCH_RECHECK_INDEX_GRACE_MS = 30 * 60 * 1000;

export interface FreshnessPassResult {
  issuesChecked: number;
  markedStale: Array<{ repo: string; issueNumber: number; reasons: GroomingStaleReason[] }>;
  /** Issues whose checks could not all complete this pass (budget or transient failure). */
  deferred: number;
  githubCalls: number;
  warnings: string[];
}

interface Evaluation {
  issue: FreshnessIssueRow;
  reasons: GroomingStaleReason[];
  details: string[];
  deferred: boolean;
  advance: { groomingVerifiedSha?: string; groomedCommentCount?: number };
}

function cacheKey(repo: string, number: number): string {
  return dependencyKey(repo, number);
}

function sortedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((value, index) => value === y[index]);
}

function stale(evaluation: Evaluation, reason: GroomingStaleReason, detail: string): void {
  if (!evaluation.reasons.includes(reason)) evaluation.reasons.push(reason);
  evaluation.details.push(detail);
}

/**
 * Evaluate every fresh grooming result in `repos` against current state and
 * mark the invalidated ones stale. Never throws for a single issue or repo;
 * failures become warnings and deferrals.
 */
export async function runGroomingFreshnessPass(
  repos: Array<{ id: string; fullName: string }>,
  store: FreshnessStore = makePrismaFreshnessStore(),
  github: FreshnessGitHub = defaultFreshnessGitHub,
  budget: FreshnessBudget = DEFAULT_FRESHNESS_BUDGET,
  now: () => Date = () => new Date(),
): Promise<FreshnessPassResult> {
  const result: FreshnessPassResult = { issuesChecked: 0, markedStale: [], deferred: 0, githubCalls: 0, warnings: [] };
  const remaining = {
    compares: budget.maxCompares,
    comments: budget.maxCommentFetches,
    related: budget.maxRelatedFetches,
    searchCode: budget.maxSearchCodeRechecks,
  };

  for (const repo of repos) {
    try {
      await evaluateRepo(repo, store, github, budget, remaining, result, now);
    } catch (err) {
      result.warnings.push(`freshness: ${repo.fullName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

async function evaluateRepo(
  repo: { id: string; fullName: string },
  store: FreshnessStore,
  github: FreshnessGitHub,
  budget: FreshnessBudget,
  remaining: { compares: number; comments: number; related: number; searchCode: number },
  result: FreshnessPassResult,
  now: () => Date,
): Promise<void> {
  const rows = (await store.findFreshIssues(repo.id, budget.maxIssuesPerRepo)).filter(
    (row) => row.state === "open" && row.groomedIssueFingerprint && isFreshnessTrackedStatus(row.labels),
  );
  if (rows.length === 0) return;
  result.issuesChecked += rows.length;

  const evaluations: Evaluation[] = rows.map((issue) => ({ issue, reasons: [], details: [], deferred: false, advance: {} }));

  // 1. Issue content: title/body/state/labels against the expected post-apply state.
  for (const evaluation of evaluations) {
    const { issue } = evaluation;
    const current = computeGroomingIssueFingerprint(issue);
    if (current !== issue.groomedIssueFingerprint) {
      stale(evaluation, "issue_changed", "issue title/body/state/labels changed since grooming");
    }
  }

  // 2. Dependencies (#1038 keys) against the open set, and related work
  //    against the tracked-issue cache. One query each, no GitHub calls.
  const dependencyNumbers = new Set<number>();
  const relatedNumbers = new Set<number>();
  for (const { issue } of evaluations) {
    for (const key of issue.groomedDependencyKeys) {
      const parsed = parseDependencyKey(key);
      if (parsed) dependencyNumbers.add(parsed.number);
    }
    for (const entry of readRelatedWorkBaseline(issue.groomedRelatedWork)) {
      if (entry.kind === "issue") relatedNumbers.add(entry.number);
    }
  }
  const openKeys = dependencyNumbers.size > 0 ? await store.findOpenIssueKeys([...dependencyNumbers]) : new Set<string>();
  const cachedStates =
    relatedNumbers.size > 0 ? await store.findCachedIssueStates([...relatedNumbers]) : new Map<string, "open" | "closed">();

  for (const evaluation of evaluations) {
    const { issue } = evaluation;
    if (issue.groomedDependencyKeys.length > 0) {
      const openNow = issue.groomedDependencyKeys.filter((key) => openKeys.has(key));
      if (!sortedEqual(openNow, issue.groomedOpenBlockerKeys)) {
        const was = issue.groomedOpenBlockerKeys.join(", ") || "none";
        const is = openNow.join(", ") || "none";
        stale(evaluation, "dependency_changed", `open blockers changed: ${was} -> ${is}`);
      }
    }
  }

  // Everything below spends GitHub budget, so skip issues already stale.
  const live = () => evaluations.filter((evaluation) => evaluation.reasons.length === 0);

  // 3. New comments: only when the count grew, and only human comments count.
  for (const evaluation of live()) {
    const { issue } = evaluation;
    const baseline = issue.groomedCommentCount ?? 0;
    if (issue.commentsCount <= baseline) continue;
    if (remaining.comments <= 0) {
      evaluation.deferred = true;
      continue;
    }
    remaining.comments--;
    result.githubCalls++;
    try {
      const comments = await github.fetchRecentComments(repo.fullName, issue.number, budget.commentWindow);
      const since = issue.groomedEvidenceCapturedAt?.getTime() ?? 0;
      const newer = comments.filter((comment) => Date.parse(comment.createdAt) > since);
      const human = newer.find((comment) => !isAutomationAuthor(comment.author));
      // A full page of only-new comments may hide older new ones we did not read.
      const unread =
        comments.length >= budget.commentWindow &&
        newer.length === comments.length &&
        issue.commentsCount - baseline > comments.length;
      if (human) {
        stale(evaluation, "human_comment", `new comment by ${human.author}`);
      } else if (unread) {
        stale(evaluation, "human_comment", "more new comments than the check reads; assuming a human one");
      } else {
        evaluation.advance.groomedCommentCount = issue.commentsCount;
      }
    } catch (err) {
      evaluation.deferred = true;
      result.warnings.push(
        `freshness: ${repo.fullName}#${issue.number} comment check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Related work the result cited: tracked issues from the cache, the rest
  //    (PRs, untracked issues) within the GitHub budget.
  for (const evaluation of live()) {
    for (const entry of readRelatedWorkBaseline(evaluation.issue.groomedRelatedWork)) {
      const current = await relatedState(entry, cachedStates, github, remaining, result);
      if (current === undefined) {
        evaluation.deferred = true;
        continue;
      }
      if (current === null) continue;
      if (current !== entry.state) {
        stale(evaluation, "related_work_changed", `${entry.repo}#${entry.number} ${entry.state} -> ${current}`);
        break;
      }
    }
  }

  // 5. Default-branch commits since the last verified SHA.
  await evaluateCommits(repo.fullName, live(), github, remaining, result, now);

  // Persist.
  const at = now();
  for (const evaluation of evaluations) {
    const { issue } = evaluation;
    if (evaluation.reasons.length > 0) {
      const mark: StaleMark = { reasons: evaluation.reasons, detail: evaluation.details.join("; ").slice(0, 2000) };
      const wrote = await store.markStale(issue, mark, at);
      if (wrote) {
        result.markedStale.push({ repo: repo.fullName, issueNumber: issue.number, reasons: mark.reasons });
        try {
          await store.recordAudit(repo.fullName, issue, mark);
        } catch (err) {
          result.warnings.push(
            `freshness: ${repo.fullName}#${issue.number} audit write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      continue;
    }
    if (evaluation.deferred) result.deferred++;
    if (Object.keys(evaluation.advance).length > 0) await store.advance(issue, evaluation.advance);
  }
}

/**
 * Current state of one related-work ref. undefined = could not check this
 * pass (budget or failure); null = state unknowable (e.g. a deleted ref),
 * which is not treated as a change.
 */
async function relatedState(
  entry: RelatedWorkBaselineEntry,
  cachedStates: Map<string, "open" | "closed">,
  github: FreshnessGitHub,
  remaining: { related: number },
  result: FreshnessPassResult,
): Promise<string | null | undefined> {
  if (entry.kind === "issue") {
    const cached = cachedStates.get(cacheKey(entry.repo, entry.number));
    if (cached) return cached;
  }
  if (remaining.related <= 0) return undefined;
  remaining.related--;
  result.githubCalls++;
  try {
    return entry.kind === "issue"
      ? await github.fetchIssueState(entry.repo, entry.number)
      : await github.fetchPullRequestState(entry.repo, entry.number);
  } catch {
    return undefined;
  }
}

async function evaluateCommits(
  repoFullName: string,
  evaluations: Evaluation[],
  github: FreshnessGitHub,
  remaining: { compares: number; searchCode: number },
  result: FreshnessPassResult,
  now: () => Date,
): Promise<void> {
  const sensitive = evaluations.filter(
    (evaluation) =>
      evaluation.issue.groomedEvidenceScope === "paths" || evaluation.issue.groomedEvidenceScope === "global",
  );
  if (sensitive.length === 0) return;

  const byBranch = new Map<string, Evaluation[]>();
  for (const evaluation of sensitive) {
    const branch = evaluation.issue.groomedDefaultBranch;
    const base = evaluation.issue.groomingVerifiedSha ?? evaluation.issue.groomedHeadSha;
    // An unpinned groom has nothing to compare from: it stays unverified
    // (verifiedAgainstHead=false for a strict consumer) rather than stale, so
    // a repo whose head cannot be resolved does not re-groom in a loop.
    if (!branch || !base) {
      evaluation.deferred = true;
      continue;
    }
    const list = byBranch.get(branch) ?? [];
    list.push(evaluation);
    byBranch.set(branch, list);
  }

  for (const [branch, group] of byBranch) {
    let head: string | null = null;
    result.githubCalls++;
    try {
      head = await github.fetchHeadSha(repoFullName, branch);
    } catch (err) {
      result.warnings.push(
        `freshness: ${repoFullName}@${branch} head lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!head) {
      for (const evaluation of group) evaluation.deferred = true;
      continue;
    }

    const byBase = new Map<string, Evaluation[]>();
    for (const evaluation of group) {
      const base = (evaluation.issue.groomingVerifiedSha ?? evaluation.issue.groomedHeadSha)!;
      if (base === head) continue;
      const list = byBase.get(base) ?? [];
      list.push(evaluation);
      byBase.set(base, list);
    }

    for (const [base, members] of byBase) {
      if (remaining.compares <= 0) {
        for (const evaluation of members) evaluation.deferred = true;
        continue;
      }
      remaining.compares--;
      result.githubCalls++;
      const comparison = await github.compareCommits(repoFullName, base, head);
      await applyComparison(members, comparison, base, head, repoFullName, github, remaining, result, now);
    }
  }
}

async function applyComparison(
  members: Evaluation[],
  comparison: CommitComparison,
  base: string,
  head: string,
  repoFullName: string,
  github: FreshnessGitHub,
  remaining: { searchCode: number },
  result: FreshnessPassResult,
  now: () => Date,
): Promise<void> {
  const range = `${base.slice(0, 12)}...${head.slice(0, 12)}`;
  if (!comparison.ok) {
    if (comparison.definitive) {
      for (const evaluation of members) {
        stale(evaluation, "compare_unreliable", `cannot compare ${range}: ${comparison.message}`);
      }
    } else {
      result.warnings.push(`freshness: ${repoFullName} ${comparison.message}`);
      for (const evaluation of members) evaluation.deferred = true;
    }
    return;
  }
  if (comparison.status === "identical") {
    for (const evaluation of members) evaluation.advance.groomingVerifiedSha = head;
    return;
  }
  if (comparison.status !== "ahead" || comparison.truncated) {
    const why = comparison.truncated ? "changed-file list truncated" : `history ${comparison.status}`;
    for (const evaluation of members) stale(evaluation, "compare_unreliable", `${range}: ${why}`);
    return;
  }
  for (const evaluation of members) {
    if (evaluation.issue.groomedEvidenceScope === "global") {
      const queries = evaluation.issue.groomedSearchCodeQueries ?? [];
      // A commit that touches a relied-on read path invalidates the result
      // regardless of what the saved searches say (#1091: other global
      // evidence keeps the conservative behaviour).
      const pathHits = intersectEvidencePaths(evaluation.issue.groomedEvidencePaths, comparison.files);
      if (pathHits.length > 0) {
        const shown = pathHits.slice(0, 5).join(", ") + (pathHits.length > 5 ? `, +${pathHits.length - 5} more` : "");
        stale(evaluation, "global_evidence_commit", `default branch moved ${range}; commit touched relied-on evidence paths: ${shown}`);
        continue;
      }
      if (queries.length > 0 && github.searchCode && github.fetchCommitDate) {
        if (remaining.searchCode <= 0) {
          stale(evaluation, "global_evidence_commit", `default branch moved ${range} and the result relied on repo-wide evidence`);
          continue;
        }
        remaining.searchCode--;
        result.githubCalls++;
        let committedAt: string | null = null;
        try {
          committedAt = await github.fetchCommitDate(repoFullName, head);
        } catch {
          committedAt = null;
        }
        const at = committedAt ? Date.parse(committedAt) : Number.NaN;
        if (Number.isNaN(at)) {
          // No trustworthy timestamp: cannot confirm the index caught up, so
          // stay conservative (stale), never fresh-and-verified.
          stale(evaluation, "global_evidence_commit", `default branch moved ${range} and the result relied on repo-wide evidence`);
          continue;
        }
        if (now().getTime() - at < SEARCH_RECHECK_INDEX_GRACE_MS) {
          // The head is too recent for the code-search index to have caught
          // up; an empty recheck now would not mean "still absent". Defer to
          // a later pass without advancing or staling.
          evaluation.deferred = true;
          continue;
        }
        let matchedQuery: string | null = null;
        let allEmpty = true;
        for (const query of queries) {
          if (remaining.searchCode <= 0) {
            allEmpty = false;
            break;
          }
          remaining.searchCode--;
          result.githubCalls++;
          try {
            if ((await github.searchCode(repoFullName, query, 1)).length > 0) {
              matchedQuery = query;
              allEmpty = false;
              break;
            }
          } catch {
            allEmpty = false;
            break;
          }
        }
        if (matchedQuery) {
          stale(evaluation, "global_evidence_commit", `default branch moved ${range}; previously empty search query now matches: ${matchedQuery}`);
          continue;
        }
        if (allEmpty) {
          evaluation.advance.groomingVerifiedSha = head;
          continue;
        }
      }
      stale(evaluation, "global_evidence_commit", `default branch moved ${range} and the result relied on repo-wide evidence`);
      continue;
    }
    const hits = intersectEvidencePaths(evaluation.issue.groomedEvidencePaths, comparison.files);
    if (hits.length > 0) {
      const shown = hits.slice(0, 5).join(", ") + (hits.length > 5 ? `, +${hits.length - 5} more` : "");
      stale(evaluation, "evidence_path_changed", `${range} touched ${shown}`);
    } else {
      evaluation.advance.groomingVerifiedSha = head;
    }
  }
}

// ---------------------------------------------------------------------------
// Recording (called by the groomer after an applied run)
// ---------------------------------------------------------------------------

/**
 * Issue columns for a new freshness baseline, resolving dependency openness
 * against the cache. Never throws: when the baseline cannot be built the
 * columns reset to "unknown" (and any stale mark is cleared), so a recording
 * failure costs a lowest-priority backfill later rather than a re-groom loop.
 */
export async function freshnessBaselineIssueData(
  client: typeof prisma,
  input: Omit<GroomingFreshnessInput, "resolveOpenKeys">,
): Promise<Record<string, unknown>> {
  try {
    const baseline = await buildGroomingFreshnessBaseline({
      ...input,
      resolveOpenKeys: (keys) =>
        findOpenIssueKeys(
          keys.map((key) => parseDependencyKey(key)?.number).filter((n): n is number => n !== undefined),
          client,
        ),
    });
    return { ...baseline };
  } catch (err) {
    console.warn(
      `[groomer] ${input.repoFullName}#${input.issueNumber}: freshness baseline not recorded; freshness is unknown:`,
      err,
    );
    return { ...UNKNOWN_FRESHNESS };
  }
}

// ---------------------------------------------------------------------------
// Webhook fast path
// ---------------------------------------------------------------------------

export interface CommentInvalidationInput {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  author: string;
  createdAt: string;
}

/**
 * Mark a fresh result stale for a new human comment delivered by webhook.
 * Automation comments, comments older than the grooming evidence window and
 * issues without a fresh baseline are ignored. The sync pass stays the
 * backstop when webhooks are not configured.
 */
export async function invalidateGroomingForComment(
  input: CommentInvalidationInput,
  client: typeof prisma = prisma,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  if (isAutomationAuthor(input.author)) return false;
  const issue = await client.issue.findUnique({
    where: { id: input.issueId },
    select: {
      id: true,
      labels: true,
      groomedRunId: true,
      groomedIssueFingerprint: true,
      groomingStaleAt: true,
      groomedEvidenceCapturedAt: true,
    },
  });
  if (!issue || !issue.groomedIssueFingerprint || issue.groomingStaleAt) return false;
  const createdAt = Date.parse(input.createdAt);
  const since = issue.groomedEvidenceCapturedAt?.getTime() ?? 0;
  if (Number.isFinite(createdAt) && createdAt <= since) return false;
  const mark: StaleMark = { reasons: ["human_comment"], detail: `new comment by ${input.author}` };
  const updated = await client.issue.updateMany({
    where: { id: issue.id, groomedRunId: issue.groomedRunId, groomingStaleAt: null },
    data: { groomingStaleAt: now(), groomingStaleReasons: mark.reasons, groomingStaleDetail: mark.detail },
  });
  if (updated.count === 0) return false;
  await client.auditLog.create({
    data: {
      actor: FRESHNESS_ACTOR,
      action: "grooming_stale",
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueId: issue.id,
      beforeLabels: issue.labels,
      afterLabels: issue.labels,
      success: true,
      notes: JSON.stringify({ ...mark, groomedRunId: issue.groomedRunId, via: "webhook" }),
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Prisma / GitHub wiring
// ---------------------------------------------------------------------------

const FRESHNESS_SELECT = {
  id: true,
  number: true,
  title: true,
  body: true,
  state: true,
  labels: true,
  commentsCount: true,
  groomedRunId: true,
  groomedHeadSha: true,
  groomedDefaultBranch: true,
  groomedIssueFingerprint: true,
  groomedCommentCount: true,
  groomedEvidenceCapturedAt: true,
  groomedEvidenceScope: true,
  groomedEvidencePaths: true,
  groomedSearchCodeQueries: true,
  groomedDependencyKeys: true,
  groomedOpenBlockerKeys: true,
  groomedRelatedWork: true,
  groomingVerifiedSha: true,
} as const;

export function makePrismaFreshnessStore(client: typeof prisma = prisma): FreshnessStore {
  return {
    findFreshIssues(repositoryId, take) {
      return client.issue.findMany({
        where: {
          repositoryId,
          state: "open",
          groomedIssueFingerprint: { not: null },
          groomingStaleAt: null,
        },
        select: FRESHNESS_SELECT,
        // Oldest verification first, so a capped pass rotates fairly.
        orderBy: [{ groomedAt: "asc" }, { number: "asc" }],
        take,
      });
    },
    findOpenIssueKeys(numbers) {
      return findOpenIssueKeys(numbers);
    },
    async findCachedIssueStates(numbers) {
      const rows = await client.issue.findMany({
        where: { number: { in: numbers } },
        select: { number: true, state: true, repository: { select: { fullName: true } } },
      });
      const states = new Map<string, "open" | "closed">();
      for (const row of rows) {
        states.set(cacheKey(row.repository.fullName, row.number), row.state === "closed" ? "closed" : "open");
      }
      return states;
    },
    async markStale(issue, mark, at) {
      const updated = await client.issue.updateMany({
        where: { id: issue.id, groomedRunId: issue.groomedRunId, groomingStaleAt: null },
        data: { groomingStaleAt: at, groomingStaleReasons: mark.reasons, groomingStaleDetail: mark.detail },
      });
      return updated.count > 0;
    },
    async advance(issue, data) {
      await client.issue.updateMany({
        where: { id: issue.id, groomedRunId: issue.groomedRunId, groomingStaleAt: null },
        data,
      });
    },
    async recordAudit(repoFullName, issue, mark) {
      await client.auditLog.create({
        data: {
          actor: FRESHNESS_ACTOR,
          action: "grooming_stale",
          repoFullName,
          issueNumber: issue.number,
          issueId: issue.id,
          beforeLabels: issue.labels,
          afterLabels: issue.labels,
          success: true,
          notes: JSON.stringify({ reasons: mark.reasons, detail: mark.detail, groomedRunId: issue.groomedRunId }),
        },
      });
    },
  };
}

export const defaultFreshnessGitHub: FreshnessGitHub = {
  async fetchHeadSha(repoFullName, branch) {
    return (await fetchLatestCommit(repoFullName, branch))?.sha ?? null;
  },
  compareCommits,
  searchCode: searchRepositoryCode,
  fetchCommitDate,
  async fetchRecentComments(repoFullName, issueNumber, max) {
    const comments = await fetchIssueComments(repoFullName, issueNumber, max, "desc");
    return comments.map((comment) => ({ author: comment.user?.login ?? "unknown", createdAt: comment.created_at ?? "" }));
  },
  async fetchIssueState(repoFullName, issueNumber) {
    const issue = await fetchIssue(repoFullName, issueNumber);
    return issue.state === "closed" ? "closed" : "open";
  },
  async fetchPullRequestState(repoFullName, prNumber) {
    const pr = await fetchPullRequestState(repoFullName, prNumber);
    if (pr.mergedAt) return "merged";
    if (pr.state === "open" || pr.state === "closed") return pr.state;
    return null;
  },
};

/**
 * Run the pass after a sync without ever failing it. Returns the summary, or
 * null when the pass itself blew up (logged).
 */
export async function runGroomingFreshnessPassBestEffort(
  repos: Array<{ id: string; fullName: string }>,
): Promise<FreshnessPassResult | null> {
  try {
    const result = await runGroomingFreshnessPass(repos);
    for (const warning of result.warnings) console.warn(`[groomer] ${warning}`);
    return result;
  } catch (err) {
    console.error("[groomer] grooming freshness pass failed:", err);
    return null;
  }
}
