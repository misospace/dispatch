import { createHash } from "crypto";

import { fetchIssue } from "@/lib/github-issues";
import { fetchRepositoryMetadata } from "@/lib/github-code-search";
import { fetchLatestCommit } from "@/lib/github-ci";
import type { GitHubIssue } from "@/types";
import { isAutomationAuthor } from "./context";

export type EvidenceProvenance = "repository" | "github_issue" | "human_comment" | "automation_comment";

export interface EvidenceComment {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  provenance: "human_comment" | "automation_comment";
  authoritative: boolean; // human => true, automation => false
}

export interface EvidenceSource {
  path: string;
  provenance: "repository";
  ref: string | null; // the pinned head SHA this run read at
}

export interface EvidenceSnapshotIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[]; // sorted
  state: string;
  updatedAt: string;
  url: string;
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
  sources: EvidenceSource[]; // repository evidence paths read/searched this run (appended after exploration)
}

export interface EvidenceSnapshotInput {
  repoFullName: string;
  issueNumber: number;
  comments: Array<{ id?: number | null; author: string; createdAt: string; body: string }>;
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

/** Hard cap on repository evidence paths retained per snapshot. */
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

/**
 * Append repository paths read during exploration as provenanced evidence.
 * Returns a NEW snapshot (input is not mutated), dedupes by path (first
 * wins), and bounds the list so a runaway exploration cannot bloat it.
 * Each source is stamped with the run's pinned head SHA.
 */
export function addEvidenceSources(
  snapshot: GroomingEvidenceSnapshot,
  paths: string[],
): GroomingEvidenceSnapshot {
  const seen = new Set(snapshot.sources.map((source) => source.path));
  const sources: EvidenceSource[] = [...snapshot.sources];
  for (const path of paths) {
    if (sources.length >= MAX_EVIDENCE_SOURCES) break;
    if (seen.has(path)) continue;
    seen.add(path);
    sources.push({ path, provenance: "repository", ref: snapshot.headSha });
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
    issueState: snapshot.issue.state,
    commentCount: comments.length,
    humanCommentCount: comments.filter((comment) => comment.provenance === "human_comment").length,
    automationCommentCount: comments.filter((comment) => comment.provenance === "automation_comment").length,
    commentProvenance: comments.slice(0, MAX_PERSISTED_COMMENTS).map((comment) => ({
      id: comment.id,
      author: comment.author,
      provenance: comment.provenance,
    })),
    sourceCount: snapshot.sources.length,
    sources: snapshot.sources.slice(0, MAX_PERSISTED_SOURCES).map((source) => ({
      path: source.path,
      provenance: source.provenance,
      ref: source.ref,
    })),
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
    };
  }

  const comments: EvidenceComment[] = input.comments.map((comment, index) => {
    const automation = isAutomationAuthor(comment.author);
    return {
      id: String(comment.id ?? `synthetic-${index}`),
      author: comment.author,
      createdAt: comment.createdAt,
      body: comment.body,
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
