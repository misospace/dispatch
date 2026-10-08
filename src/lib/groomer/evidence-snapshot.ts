import { createHash } from "crypto";

import { fetchIssue } from "@/lib/github-issues";
import { fetchRepositoryMetadata } from "@/lib/github-code-search";
import { fetchLatestCommit } from "@/lib/github-ci";
import type { GitHubIssue } from "@/types";
import { isAutomationAuthor } from "./context";

export type EvidenceProvenance =
  | "repository"
  | "github_issue"
  | "github_pull_request"
  | "github_commit"
  | "human_comment"
  | "automation_comment";

export interface EvidenceComment {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  authorAssociation?: string | null;
  provenance: "human_comment" | "automation_comment";
  authoritative: boolean; // human => true, automation => false
}

export interface RepositoryEvidenceSource {
  path: string;
  provenance: "repository";
  /**
   * "read": the file was fetched at `ref`. "surfaced": the path only came
   * from a code-search hit (the default-branch index, not the pinned SHA) or
   * from the model's own findings, so it is never pinned (`ref: null`).
   */
  via: "read" | "surfaced";
  ref: string | null; // the pinned head SHA this run read at; null when surfaced or unpinned
}

/**
 * GitHub issue/PR/commit state the related-work tools observed. This is live
 * forge state, not repository content, so it is never pinned to the run's
 * head SHA: `ref` is always null and `observedAt` records when it was read.
 */
export interface RelatedWorkEvidenceSource {
  key: string; // stable identity, e.g. github:pr:org/repo#12
  provenance: "github_issue" | "github_pull_request" | "github_commit";
  state: "open" | "closed" | "merged" | null; // null for commits
  url: string | null;
  via: "read" | "search"; // direct read, or a search-index hit (may lag)
  observedAt: string;
  ref: null;
  /** A pull request read directly: the issues GitHub records it as closing (`owner/repo#N`). */
  closes?: string[];
  /** A pull request read directly: its base branch. */
  baseRef?: string;
}

export type EvidenceSource = RepositoryEvidenceSource | RelatedWorkEvidenceSource;

/** A related-work observation as the exploration tools report it. */
export interface RelatedWorkObservation {
  key: string;
  kind: "issue" | "pull_request" | "commit";
  state: "open" | "closed" | "merged" | null;
  url: string | null;
  via: "read" | "search";
  observedAt: string;
  /**
   * Pull requests read directly: GitHub's closing references (`owner/repo#N`).
   * Absent when unknown (a search hit, or the lookup failed).
   */
  closes?: string[];
  /** Pull requests read directly: the base branch it targets. */
  baseRef?: string;
}

export interface EvidenceSnapshotIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[]; // sorted
  state: string;
  updatedAt: string;
  url: string;
  /** Total comments reported by GitHub; absent only in legacy snapshots. */
  commentsCount?: number | null;
  /** Optional for legacy snapshots; new captures always include both fields. */
  author?: string | null;
  authorAssociation?: string | null;
}

export interface GroomingEvidenceSnapshot {
  capturedAt: string; // ISO, set once at capture
  repoFullName: string;
  defaultBranch: string | null;
  headSha: string | null; // exact default-branch head SHA captured before analysis
  pinnedRef: string | null; // === headSha when resolvable; what repo reads are forced to
  issue: EvidenceSnapshotIssue; // LIVE issue state
  issueFingerprint: string; // sha256 of canonical issue content
  comments: EvidenceComment[];
  evidenceDigest: string; // sha256 over pinned inputs (headSha + defaultBranch + issueFingerprint + comment identity)
  warnings: string[]; // capture-time diagnostics (soft-failures land here)
  sources: EvidenceSource[]; // repository paths and related-work refs read this run (appended after exploration)
}

export interface EvidenceSnapshotInput {
  repoFullName: string;
  issueNumber: number;
  comments: Array<{
    id?: number | null;
    author: string;
    createdAt: string;
    body: string;
    authorAssociation?: string | null;
  }>;
}

export interface EvidenceSnapshotDeps {
  fetchIssue: (repoFullName: string, issueNumber: number) => Promise<GitHubIssue>;
  fetchRepositoryMetadata: (repoFullName: string) => Promise<{ defaultBranch: string }>;
  fetchLatestCommit: (repoFullName: string, branch: string) => Promise<{ sha: string } | null>;
}

export const defaultEvidenceSnapshotDeps: EvidenceSnapshotDeps = {
  fetchIssue,
  fetchRepositoryMetadata,
  fetchLatestCommit,
};

/** Hard cap on evidence sources (repository paths + related-work refs) retained per snapshot. */
const MAX_EVIDENCE_SOURCES = 60;
/** Cap on comment provenance entries kept in the persisted summary. */
const MAX_PERSISTED_COMMENTS = 50;
/** Cap on source entries kept in the persisted summary. */
const MAX_PERSISTED_SOURCES = 60;
/** Cap on capture-time warnings kept in the persisted summary. */
const MAX_PERSISTED_WARNINGS = 20;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fingerprint the live issue state a run is about to analyze. Labels are
 * sorted so reordering them does not change the fingerprint; title and body
 * stay verbatim so any content change is detected.
 */
export function computeIssueFingerprint(issue: EvidenceSnapshotIssue): string {
  const canonical = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: [...issue.labels].sort(),
    state: issue.state,
  };
  return sha256Hex(JSON.stringify(canonical));
}

/**
 * Digest over the pinned inputs of a run: head SHA, default branch, issue
 * fingerprint, and comment identity/provenance. Deliberately excludes comment
 * bodies so the digest stays small and a body edit does not churn the
 * pinned-input identity.
 */
export function computeEvidenceDigest(parts: {
  headSha: string | null;
  defaultBranch: string | null;
  issueFingerprint: string;
  comments: EvidenceComment[];
}): string {
  const canonical = {
    headSha: parts.headSha,
    defaultBranch: parts.defaultBranch,
    issueFingerprint: parts.issueFingerprint,
    comments: parts.comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      createdAt: comment.createdAt,
      provenance: comment.provenance,
    })),
  };
  return sha256Hex(JSON.stringify(canonical));
}

function sourceIdentity(source: EvidenceSource): string {
  return source.provenance === "repository" ? `path:${source.path}` : `key:${source.key}`;
}

/**
 * Append repository paths as provenanced evidence. Returns a NEW snapshot
 * (input is not mutated), dedupes by path, and bounds the list so a runaway
 * exploration cannot bloat it.
 *
 * `via: "read"` paths were fetched at the pinned ref and are stamped with the
 * run's head SHA. `via: "surfaced"` paths (code-search hits, paths the model
 * named) were not read at that SHA, so they carry `ref: null`. A read
 * supersedes an earlier surfaced entry for the same path; otherwise the
 * first entry wins.
 */
export function addEvidenceSources(
  snapshot: GroomingEvidenceSnapshot,
  paths: string[],
  via: RepositoryEvidenceSource["via"] = "read",
): GroomingEvidenceSnapshot {
  const sources: EvidenceSource[] = [...snapshot.sources];
  const indexByIdentity = new Map(sources.map((source, index) => [sourceIdentity(source), index]));
  for (const path of paths) {
    const identity = `path:${path}`;
    const entry: RepositoryEvidenceSource = {
      path,
      provenance: "repository",
      via,
      ref: via === "read" ? snapshot.headSha : null,
    };
    const existing = indexByIdentity.get(identity);
    if (existing !== undefined) {
      const current = sources[existing] as RepositoryEvidenceSource;
      if (current.via === "surfaced" && via === "read") sources[existing] = entry;
      continue;
    }
    if (sources.length >= MAX_EVIDENCE_SOURCES) break;
    indexByIdentity.set(identity, sources.length);
    sources.push(entry);
  }
  return { ...snapshot, sources };
}

const RELATED_WORK_PROVENANCE: Record<RelatedWorkObservation["kind"], RelatedWorkEvidenceSource["provenance"]> = {
  issue: "github_issue",
  pull_request: "github_pull_request",
  commit: "github_commit",
};

/**
 * Append related-work observations (GitHub issue/PR/commit state) as
 * provenanced evidence. Returns a NEW snapshot, dedupes by evidence key, and
 * shares the source cap with repository paths. A direct read supersedes an
 * earlier search hit for the same key, because search-index state can lag.
 * These sources are deliberately unpinned (`ref: null`).
 */
export function addRelatedWorkEvidence(
  snapshot: GroomingEvidenceSnapshot,
  observations: RelatedWorkObservation[],
): GroomingEvidenceSnapshot {
  const sources: EvidenceSource[] = [...snapshot.sources];
  const indexByKey = new Map<string, number>();
  sources.forEach((source, index) => {
    if (source.provenance !== "repository") indexByKey.set(source.key, index);
  });
  for (const observation of observations) {
    const entry: RelatedWorkEvidenceSource = {
      key: observation.key,
      provenance: RELATED_WORK_PROVENANCE[observation.kind],
      state: observation.state,
      url: observation.url,
      via: observation.via,
      observedAt: observation.observedAt,
      ref: null,
      ...(observation.closes !== undefined ? { closes: [...observation.closes] } : {}),
      ...(observation.baseRef !== undefined ? { baseRef: observation.baseRef } : {}),
    };
    const existing = indexByKey.get(observation.key);
    if (existing !== undefined) {
      const current = sources[existing] as RelatedWorkEvidenceSource;
      if (current.via === "search" && observation.via === "read") sources[existing] = entry;
      continue;
    }
    if (sources.length >= MAX_EVIDENCE_SOURCES) continue;
    indexByKey.set(observation.key, sources.length);
    sources.push(entry);
  }
  return { ...snapshot, sources };
}

/**
 * Reduce a snapshot to a bounded plain object for the GroomingRun JSON
 * column: identity and counts plus capped detail arrays, never full bodies.
 */
export function summarizeEvidenceForPersistence(snapshot: GroomingEvidenceSnapshot): Record<string, unknown> {
  const comments = snapshot.comments;
  return {
    capturedAt: snapshot.capturedAt,
    defaultBranch: snapshot.defaultBranch,
    headSha: snapshot.headSha,
    pinnedRef: snapshot.pinnedRef,
    evidenceDigest: snapshot.evidenceDigest,
    issueFingerprint: snapshot.issueFingerprint,
    issueUpdatedAt: snapshot.issue.updatedAt,
    issueCommentsCount: snapshot.issue.commentsCount,
    issueState: snapshot.issue.state,
    issueAuthor: snapshot.issue.author,
    issueAuthorAssociation: snapshot.issue.authorAssociation,
    commentCount: comments.length,
    humanCommentCount: comments.filter((comment) => comment.provenance === "human_comment").length,
    automationCommentCount: comments.filter((comment) => comment.provenance === "automation_comment").length,
    commentProvenance: comments.slice(0, MAX_PERSISTED_COMMENTS).map((comment) => ({
      id: comment.id,
      author: comment.author,
      provenance: comment.provenance,
    })),
    sourceCount: snapshot.sources.length,
    sources: snapshot.sources.slice(0, MAX_PERSISTED_SOURCES).map((source) =>
      source.provenance === "repository"
        ? { path: source.path, provenance: source.provenance, via: source.via, ref: source.ref }
        : {
            key: source.key,
            provenance: source.provenance,
            state: source.state,
            url: source.url,
            via: source.via,
            observedAt: source.observedAt,
            ref: source.ref,
            ...(source.closes !== undefined ? { closes: source.closes } : {}),
            ...(source.baseRef !== undefined ? { baseRef: source.baseRef } : {}),
          },
    ),
    warnings: snapshot.warnings.slice(0, MAX_PERSISTED_WARNINGS),
  };
}

/**
 * Capture the run's evidence baseline BEFORE model analysis: the pinned
 * default-branch head SHA, the live issue, and provenanced comments.
 *
 * This never throws: every dependency call soft-fails into `warnings` and
 * the snapshot degrades (null pinned ref, empty issue shell) so an
 * evidence-capture failure can never fail a grooming run.
 */
export async function collectGroomingEvidenceSnapshot(
  input: EvidenceSnapshotInput,
  deps: EvidenceSnapshotDeps = defaultEvidenceSnapshotDeps,
): Promise<GroomingEvidenceSnapshot> {
  const warnings: string[] = [];
  const capturedAt = new Date().toISOString();

  let defaultBranch: string | null = null;
  let headSha: string | null = null;
  try {
    defaultBranch = (await deps.fetchRepositoryMetadata(input.repoFullName)).defaultBranch;
  } catch (err) {
    warnings.push(`evidence: failed to resolve default-branch head SHA: ${errorMessage(err)}`);
  }
  if (defaultBranch !== null) {
    try {
      const commit = await deps.fetchLatestCommit(input.repoFullName, defaultBranch);
      headSha = commit?.sha ?? null;
      if (headSha === null) {
        warnings.push(
          `evidence: default-branch head SHA unavailable for ${input.repoFullName}@${defaultBranch}; repository reads are unpinned for this run`,
        );
      }
    } catch (err) {
      warnings.push(`evidence: failed to resolve default-branch head SHA: ${errorMessage(err)}`);
    }
  }

  let issue: EvidenceSnapshotIssue;
  try {
    const live = await deps.fetchIssue(input.repoFullName, input.issueNumber);
    issue = {
      number: live.number,
      title: live.title,
      body: live.body,
      labels: live.labels.map((label) => label.name).sort(),
      state: live.state,
      updatedAt: live.updated_at,
      url: live.html_url,
      commentsCount: live.comments,
      author: live.user?.login ?? null,
      authorAssociation: live.author_association ?? null,
    };
  } catch (err) {
    warnings.push(`evidence: failed to fetch live issue state: ${errorMessage(err)}`);
    issue = {
      number: input.issueNumber,
      title: "",
      body: null,
      labels: [],
      state: "unknown",
      updatedAt: "",
      url: "",
      author: null,
      authorAssociation: null,
    };
  }

  const comments: EvidenceComment[] = input.comments.map((comment, index) => {
    const automation = isAutomationAuthor(comment.author);
    return {
      id: String(comment.id ?? `synthetic-${index}`),
      author: comment.author,
      createdAt: comment.createdAt,
      body: comment.body,
      authorAssociation: comment.authorAssociation ?? null,
      provenance: automation ? "automation_comment" : "human_comment",
      authoritative: !automation,
    };
  });

  const issueFingerprint = computeIssueFingerprint(issue);
  const evidenceDigest = computeEvidenceDigest({
    headSha,
    defaultBranch,
    issueFingerprint,
    comments,
  });

  return {
    capturedAt,
    repoFullName: input.repoFullName,
    defaultBranch,
    headSha,
    pinnedRef: headSha,
    issue,
    issueFingerprint,
    comments,
    evidenceDigest,
    warnings,
    sources: [],
  };
}
