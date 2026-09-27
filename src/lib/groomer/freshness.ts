/**
 * Grooming freshness (#1064).
 *
 * A grooming result is only as good as the evidence it was validated
 * against. This module defines that evidence identity (the "baseline"
 * persisted on Issue after an applied groom), the pure checks that decide
 * whether newer GitHub/repository state invalidates it, and the derived
 * freshness status that later consumers (worker admission, #1065) can read
 * without invoking a model.
 *
 * Nothing here talks to GitHub or the database directly; see
 * freshness-invalidation.ts for the bounded pass that feeds these checks.
 */
import { createHash } from "crypto";

import { dependencyKey, normalizeRepoKey, parseIssueDependencies } from "@/lib/issue-dependencies";
import type { EvidenceSource, GroomingEvidenceSnapshot } from "./evidence-snapshot";

/**
 * How far repository commits can invalidate a result:
 * - "paths": the result rests on a bounded set of repository paths; only a
 *   commit touching one of them invalidates it.
 * - "global": the result rests on a negative or repo-wide assertion (a code
 *   search that found nothing, or repository access with no path read), so
 *   any new default-branch commit conservatively invalidates it.
 * - "none": the run consulted no repository state at all, so commits cannot
 *   invalidate evidence it never used.
 */
export type GroomingEvidenceScope = "paths" | "global" | "none";

export const GROOMING_STALE_REASONS = [
  "issue_changed",
  "human_comment",
  "dependency_changed",
  "related_work_changed",
  "evidence_path_changed",
  "global_evidence_commit",
  "compare_unreliable",
] as const;
export type GroomingStaleReason = (typeof GROOMING_STALE_REASONS)[number];

export type GroomingFreshnessStatus = "unknown" | "fresh" | "stale";

/** Repository paths kept on the baseline; exploration is already bounded to a similar count. */
export const MAX_BASELINE_PATHS = 60;
/** Related-work refs kept on the baseline. */
export const MAX_BASELINE_RELATED_WORK = 20;
/** Dependency keys kept on the baseline. */
export const MAX_BASELINE_DEPENDENCIES = 20;
/**
 * Empty code-search queries retained to recheck global evidence. Capped well
 * below the freshness pass's search budget (20) so a single issue can always
 * complete its recheck — commit-date fetch plus every saved query — even
 * when it is first in the pass (#1091 review).
 */
export const MAX_BASELINE_SEARCH_CODE_QUERIES = 10;
export const MAX_BASELINE_SEARCH_CODE_QUERY_CHARS = 200;

/**
 * Statuses a worker owns. The freshness pass does not evaluate these (a claim
 * rewrites the status label, and that is not a grooming-relevant edit), and
 * the selector never re-grooms them.
 */
const WORKER_OWNED_STATUSES = new Set(["status/in-progress", "status/in-review", "status/done"]);

export function isFreshnessTrackedStatus(labels: string[]): boolean {
  return !labels.some((label) => WORKER_OWNED_STATUSES.has(label));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface FingerprintableIssue {
  title: string;
  body: string | null;
  state: string;
  labels: string[];
}

/**
 * Fingerprint of the grooming-relevant issue state: title, body, state and
 * labels. agent/* labels are claims, not triage, so they are excluded; so
 * are cosmetic differences (label order, CRLF line endings, trailing
 * whitespace) that GitHub round-trips can introduce.
 *
 * Distinct from the evidence snapshot's `issueFingerprint`, which pins the
 * PRE-analysis live state; this one is computed over the state Dispatch
 * expects AFTER applying the groom, so the groomer's own writes compare equal.
 */
export function computeGroomingIssueFingerprint(issue: FingerprintableIssue): string {
  const labels = [...new Set(issue.labels.filter((label) => !label.startsWith("agent/")))].sort();
  const canonical = {
    title: issue.title.trim(),
    body: (issue.body ?? "").replace(/\r\n/g, "\n").trimEnd(),
    state: issue.state.toLowerCase(),
    labels,
  };
  return sha256Hex(JSON.stringify(canonical));
}

export interface ExplorationToolCallLike {
  name: string;
  ok: boolean;
  bytes: number;
  arguments?: Record<string, unknown>;
}

/**
 * Map exploration tool records to the freshness input shape, keeping the
 * call arguments so saved empty search queries can be recovered later.
 */
export function explorationCallsForFreshness(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; ok: boolean; bytes: number; preview?: string }>,
): ExplorationToolCallLike[] {
  return toolCalls.map(({ name, arguments: args, ok, bytes }) => ({ name, arguments: args, ok, bytes }));
}

function emptySearchCodeQueries(toolCalls: ExplorationToolCallLike[]): string[] {
  const queries: string[] = [];
  for (const call of toolCalls) {
    if (call.name !== "search_code" || !call.ok || call.bytes !== 0) continue;
    const raw = call.arguments?.query;
    if (typeof raw !== "string") continue;
    const query = raw.trim().slice(0, MAX_BASELINE_SEARCH_CODE_QUERY_CHARS);
    if (!query || queries.includes(query)) continue;
    queries.push(query);
    if (queries.length >= MAX_BASELINE_SEARCH_CODE_QUERIES) break;
  }
  return queries;
}

/**
 * A search_code call that succeeded with zero bytes returned "No matches":
 * the run learned that something does NOT exist anywhere in the repository,
 * which no bounded path set can protect.
 */
export function hasNegativeSearchResult(toolCalls: ExplorationToolCallLike[]): boolean {
  return toolCalls.some((call) => call.name === "search_code" && call.ok && call.bytes === 0);
}

/**
 * - `none`: no repository evidence at all.
 * - `global`: a negative search, a relied-on path that was only surfaced
 *   (a search hit or a path the model named, never read at the pinned SHA),
 *   or repository access with no read path to bound it.
 * - `paths`: everything relied on is a bounded set of read paths.
 */
export function deriveEvidenceScope(input: {
  repositoryPaths: string[];
  negativeSearch: boolean;
  repositoryConsulted: boolean;
  reliesOnSurfacedPath?: boolean;
}): GroomingEvidenceScope {
  if (!input.repositoryConsulted && input.repositoryPaths.length === 0 && !input.reliesOnSurfacedPath) return "none";
  if (input.negativeSearch || input.reliesOnSurfacedPath || input.repositoryPaths.length === 0) return "global";
  return "paths";
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

/**
 * Changed files that touch an evidence path. An evidence path matches a
 * changed file when they are equal or the path is a directory prefix of the
 * file; an empty/root evidence path matches everything.
 */
export function intersectEvidencePaths(evidencePaths: string[], changedFiles: string[]): string[] {
  const evidence = evidencePaths.map(normalizePath);
  if (evidence.some((path) => path === "")) return changedFiles.slice();
  return changedFiles.filter((file) => {
    const changed = normalizePath(file);
    return evidence.some((path) => changed === path || changed.startsWith(`${path}/`));
  });
}

/**
 * Dependency keys declared by an issue body, via the #1038 parser, resolved
 * against the issue's own repo and excluding self-references.
 */
export function dependencyKeysForIssue(body: string | null, repoFullName: string, issueNumber: number): string[] {
  const selfKey = dependencyKey(repoFullName, issueNumber);
  const keys: string[] = [];
  for (const ref of parseIssueDependencies(body)) {
    const key = dependencyKey(ref.repo ?? repoFullName, ref.number);
    if (key === selfKey || keys.includes(key)) continue;
    keys.push(key);
    if (keys.length >= MAX_BASELINE_DEPENDENCIES) break;
  }
  return keys;
}

/** Parse a dependency key (`owner/repo#N`) back to its parts. */
export function parseDependencyKey(key: string): { repo: string | null; number: number } | null {
  const match = /^(.*)#(\d+)$/.exec(key);
  if (!match) return null;
  return { repo: normalizeRepoKey(match[1]), number: Number(match[2]) };
}

export interface RelatedWorkBaselineEntry {
  key: string;
  kind: "issue" | "pull_request";
  repo: string;
  number: number;
  state: "open" | "closed" | "merged";
}

const RELATED_KEY_PATTERN = /^github:(issue|pr):([^#\s]+\/[^#\s]+)#(\d+)$/;

/**
 * Parse a related-work evidence key (`github:issue|pr:owner/repo#N`) with the
 * state it was observed in. Null for commits, unknown states and other keys.
 */
export function relatedWorkEntry(key: string, state: string | null): RelatedWorkBaselineEntry | null {
  if (state !== "open" && state !== "closed" && state !== "merged") return null;
  const match = RELATED_KEY_PATTERN.exec(key);
  if (!match) return null;
  return {
    key,
    kind: match[1] === "pr" ? "pull_request" : "issue",
    repo: match[2],
    number: Number(match[3]),
    state,
  };
}

/**
 * Heuristic related-work reliance, for a plan that cites none: issues/PRs the
 * run read directly and whose state it observed. Search hits are excluded
 * (the search index lags, and a hit is incidental), as are commits (no state).
 */
export function relatedWorkBaseline(sources: EvidenceSource[]): RelatedWorkBaselineEntry[] {
  const entries: RelatedWorkBaselineEntry[] = [];
  for (const source of sources) {
    if (source.provenance === "repository") continue;
    if (source.via !== "read") continue;
    const entry = relatedWorkEntry(source.key, source.state);
    if (!entry) continue;
    entries.push(entry);
    if (entries.length >= MAX_BASELINE_RELATED_WORK) break;
  }
  return entries;
}

/**
 * A plan citation (#1062's GroomingPlanCitation), structurally: the evidence
 * id the plan cited, its subject, and the related-work state it saw.
 */
export interface FreshnessCitation {
  id: string;
  subject: string;
  state: string | null;
}

const REPOSITORY_CITATION_PREFIX = "repo:";

export interface EvidenceReliance {
  /** Read repository paths the result relies on. */
  repositoryPaths: string[];
  /** A relied-on repository path was never read (search hit / model claim). */
  reliesOnSurfacedPath: boolean;
  relatedWork: RelatedWorkBaselineEntry[];
  /** Per subject: whether the plan's citations decided it, or the heuristic did. */
  basis: { repository: "citations" | "heuristic"; relatedWork: "citations" | "heuristic" };
}

/**
 * What the result relied on. A plan's citations win for each subject they
 * cover; a subject the plan cites nothing for falls back to the heuristic
 * (every read path, every directly read issue/PR), which over-approximates
 * reliance and so only costs extra re-grooms. Surfaced-only paths never
 * bound a result: cited, they make it global; uncited, they are ignored
 * (a surfaced-only run with no read path is global via the empty path set).
 */
export function deriveEvidenceReliance(
  sources: EvidenceSource[],
  citations: FreshnessCitation[] | undefined,
): EvidenceReliance {
  const readPaths: string[] = [];
  const surfaced = new Set<string>();
  for (const source of sources) {
    if (source.provenance !== "repository") continue;
    if (source.via === "read") {
      if (!readPaths.includes(source.path)) readPaths.push(source.path);
    } else {
      surfaced.add(source.path);
    }
  }
  const readSet = new Set(readPaths);

  const cited = citations ?? [];
  const citedRepo = cited
    .filter((c) => c.subject === "repository" && c.id.startsWith(REPOSITORY_CITATION_PREFIX))
    .map((c) => c.id.slice(REPOSITORY_CITATION_PREFIX.length));
  const citedRelated = cited.filter((c) => c.subject === "related_work");

  let repositoryPaths: string[];
  let reliesOnSurfacedPath = false;
  let repositoryBasis: EvidenceReliance["basis"]["repository"] = "heuristic";
  if (citedRepo.length > 0) {
    repositoryBasis = "citations";
    repositoryPaths = [...new Set(citedRepo.filter((path) => readSet.has(path)))];
    reliesOnSurfacedPath = citedRepo.some((path) => !readSet.has(path));
  } else {
    repositoryPaths = readPaths;
  }

  let relatedWork: RelatedWorkBaselineEntry[];
  let relatedBasis: EvidenceReliance["basis"]["relatedWork"] = "heuristic";
  if (citedRelated.length > 0) {
    relatedBasis = "citations";
    relatedWork = [];
    for (const citation of citedRelated) {
      const entry = relatedWorkEntry(citation.id, citation.state);
      if (entry && !relatedWork.some((existing) => existing.key === entry.key)) relatedWork.push(entry);
      if (relatedWork.length >= MAX_BASELINE_RELATED_WORK) break;
    }
  } else {
    relatedWork = relatedWorkBaseline(sources);
  }

  return {
    repositoryPaths: repositoryPaths.slice(0, MAX_BASELINE_PATHS),
    reliesOnSurfacedPath,
    relatedWork,
    basis: { repository: repositoryBasis, relatedWork: relatedBasis },
  };
}

/** Tolerant reader for the persisted JSON column. */
export function readRelatedWorkBaseline(value: unknown): RelatedWorkBaselineEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is RelatedWorkBaselineEntry =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as RelatedWorkBaselineEntry).key === "string" &&
      typeof (entry as RelatedWorkBaselineEntry).repo === "string" &&
      typeof (entry as RelatedWorkBaselineEntry).number === "number" &&
      typeof (entry as RelatedWorkBaselineEntry).state === "string",
  );
}

/** The Issue columns a baseline writes. Also clears any prior staleness. */
export interface GroomingFreshnessBaseline {
  groomedRunId: string;
  groomedHeadSha: string | null;
  groomedDefaultBranch: string | null;
  groomedIssueFingerprint: string;
  groomedCommentCount: number | null;
  groomedEvidenceDigest: string | null;
  groomedEvidenceCapturedAt: Date;
  groomedEvidenceScope: GroomingEvidenceScope;
  groomedEvidencePaths: string[];
  groomedSearchCodeQueries: string[];
  groomedDependencyKeys: string[];
  groomedOpenBlockerKeys: string[];
  groomedRelatedWork: RelatedWorkBaselineEntry[];
  groomingVerifiedSha: string | null;
  groomingStaleAt: null;
  groomingStaleReasons: string[];
  groomingStaleDetail: null;
}

/** The columns that reset freshness to unknown when no baseline can be recorded. */
export const UNKNOWN_FRESHNESS: Record<string, unknown> = {
  groomedRunId: null,
  groomedHeadSha: null,
  groomedDefaultBranch: null,
  groomedIssueFingerprint: null,
  groomedCommentCount: null,
  groomedEvidenceDigest: null,
  groomedEvidenceCapturedAt: null,
  groomedEvidenceScope: null,
  groomedEvidencePaths: [],
  groomedSearchCodeQueries: [],
  groomedDependencyKeys: [],
  groomedOpenBlockerKeys: [],
  groomedRelatedWork: null,
  groomingVerifiedSha: null,
  groomingStaleAt: null,
  groomingStaleReasons: [],
  groomingStaleDetail: null,
  groomingRetryAfter: null,
};

export interface GroomingFreshnessInput {
  groomingRunId: string;
  repoFullName: string;
  issueNumber: number;
  evidence: GroomingEvidenceSnapshot;
  /** Dispatch's cached issue at selection time; the fallback when the live capture failed. */
  candidate: { title: string; body: string | null; commentsCount?: number | null };
  /** Title/body the groom wrote to GitHub, if any. */
  appliedTitle?: string;
  appliedBody?: string;
  /** Full label set written to GitHub (updateIssueLabels replaces the set). */
  labelsAfter: string[];
  closed: boolean;
  /** Before the run fetched comments: a human comment after this is new evidence. */
  evidenceWindowStart: Date;
  repositoryQueries: string[];
  explorationRan: boolean;
  explorationToolCalls: ExplorationToolCallLike[];
  /** The validated plan's citations (#1062), when there is a plan. */
  citations?: FreshnessCitation[];
  /** Returns the subset of dependency keys whose issue is currently open. */
  resolveOpenKeys: (keys: string[]) => Promise<Set<string>>;
}

/**
 * Build the freshness baseline for an applied groom: the expected post-apply
 * issue state, the pinned repository revision and evidence set, and the
 * dependency / related-work state the result was validated against.
 */
export async function buildGroomingFreshnessBaseline(input: GroomingFreshnessInput): Promise<GroomingFreshnessBaseline> {
  const { evidence } = input;
  const liveCaptured = evidence.issue.state !== "unknown";
  const title = input.appliedTitle ?? (liveCaptured ? evidence.issue.title : input.candidate.title);
  const body = input.appliedBody ?? (liveCaptured ? evidence.issue.body : input.candidate.body);
  const state = input.closed ? "closed" : liveCaptured ? evidence.issue.state : "open";

  const reliance = deriveEvidenceReliance(evidence.sources, input.citations);
  const scope = deriveEvidenceScope({
    repositoryPaths: reliance.repositoryPaths,
    negativeSearch: hasNegativeSearchResult(input.explorationToolCalls),
    repositoryConsulted: input.explorationRan || input.repositoryQueries.length > 0,
    reliesOnSurfacedPath: reliance.reliesOnSurfacedPath,
  });

  const dependencyKeys = dependencyKeysForIssue(body, input.repoFullName, input.issueNumber);
  const openKeys = dependencyKeys.length > 0 ? await input.resolveOpenKeys(dependencyKeys) : new Set<string>();

  return {
    groomedRunId: input.groomingRunId,
    groomedHeadSha: evidence.headSha,
    groomedDefaultBranch: evidence.defaultBranch,
    groomedIssueFingerprint: computeGroomingIssueFingerprint({ title, body, state, labels: input.labelsAfter }),
    groomedCommentCount: input.candidate.commentsCount ?? null,
    groomedEvidenceDigest: evidence.evidenceDigest || null,
    groomedEvidenceCapturedAt: input.evidenceWindowStart,
    groomedEvidenceScope: scope,
    groomedEvidencePaths: reliance.repositoryPaths,
    // Only negative-search globals may be rechecked later (#1091). The other
    // global cases — a relied-on path that was only surfaced, or repository
    // access with no read path — keep the conservative stale-on-commit
    // behaviour even when an empty search also happened during the run.
    // A no-read-path global may still save its queries when exploration
    // searches were its ONLY repository evidence: no repository-context
    // queries ran and nothing else (e.g. list_directory) surfaced paths.
    groomedSearchCodeQueries:
      scope === "global" &&
      !reliance.reliesOnSurfacedPath &&
      (reliance.repositoryPaths.length > 0 ||
        (input.repositoryQueries.length === 0 &&
          !input.explorationToolCalls.some((call) => call.name === "list_directory")))
        ? emptySearchCodeQueries(input.explorationToolCalls)
        : [],
    groomedDependencyKeys: dependencyKeys,
    groomedOpenBlockerKeys: dependencyKeys.filter((key) => openKeys.has(key)).sort(),
    groomedRelatedWork: reliance.relatedWork,
    groomingVerifiedSha: evidence.headSha,
    groomingStaleAt: null,
    groomingStaleReasons: [],
    groomingStaleDetail: null,
  };
}

export interface FreshnessColumns {
  groomedIssueFingerprint: string | null;
  groomingStaleAt: Date | null;
  groomingStaleReasons?: string[] | null;
  groomingVerifiedSha?: string | null;
}

export interface GroomingFreshness {
  status: GroomingFreshnessStatus;
  reasons: string[];
  /**
   * Whether the result has been verified against `currentHeadSha`: null when
   * no head was supplied, false when verification is behind (or impossible
   * because the run was unpinned). A strict consumer treats false as not fresh.
   */
  verifiedAgainstHead: boolean | null;
}

/** Derive freshness from persisted columns alone — no model, no GitHub call. */
export function deriveGroomingFreshness(issue: FreshnessColumns, currentHeadSha?: string | null): GroomingFreshness {
  const verifiedAgainstHead =
    currentHeadSha === undefined ? null : !!issue.groomingVerifiedSha && issue.groomingVerifiedSha === currentHeadSha;
  if (!issue.groomedIssueFingerprint) return { status: "unknown", reasons: [], verifiedAgainstHead };
  if (issue.groomingStaleAt) {
    return { status: "stale", reasons: issue.groomingStaleReasons ?? [], verifiedAgainstHead };
  }
  return { status: "fresh", reasons: [], verifiedAgainstHead };
}
