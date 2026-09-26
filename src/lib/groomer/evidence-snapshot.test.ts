import { describe, expect, it, vi } from "vitest";

import type { GitHubIssue } from "@/types";

import {
  addEvidenceSources,
  collectGroomingEvidenceSnapshot,
  computeEvidenceDigest,
  computeIssueFingerprint,
  summarizeEvidenceForPersistence,
  type EvidenceSnapshotInput,
  type EvidenceSnapshotIssue,
  type GroomingEvidenceSnapshot,
} from "./evidence-snapshot";

const REPO = "org/repo";
const HEAD_SHA = "a".repeat(40);

const fakeIssue: GitHubIssue = {
  number: 42,
  title: "Fix authentication timeout",
  body: "Users get a 504 when the auth service is slow.",
  state: "open",
  html_url: `https://github.com/${REPO}/issues/42`,
  labels: [
    { name: "status/ready", color: "0e8a16" },
    { name: "priority/p2", color: "eeeeee" },
  ],
  assignees: [],
  comments: 2,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-15T12:00:00Z",
  closed_at: null,
};

const input: EvidenceSnapshotInput = {
  repoFullName: REPO,
  issueNumber: 42,
  comments: [
    { id: 1, author: "alice", createdAt: "2026-09-10T00:00:00Z", body: "Please fix this" },
    { id: 2, author: "github-actions[bot]", createdAt: "2026-09-11T00:00:00Z", body: "CI is green" },
    { id: 3, author: "itsmiso-ai", createdAt: "2026-09-12T00:00:00Z", body: "On it" },
    { author: "bob", createdAt: "2026-09-13T00:00:00Z", body: "Bumping" },
  ],
};

function makeDeps() {
  return {
    fetchIssue: vi.fn<(repoFullName: string, issueNumber: number) => Promise<GitHubIssue>>(),
    fetchRepositoryMetadata: vi.fn<(repoFullName: string) => Promise<{ defaultBranch: string }>>(),
    fetchLatestCommit: vi.fn<(repoFullName: string, branch: string) => Promise<{ sha: string } | null>>(),
  };
}

function happyDeps() {
  const deps = makeDeps();
  deps.fetchRepositoryMetadata.mockResolvedValue({ defaultBranch: "main" });
  deps.fetchLatestCommit.mockResolvedValue({ sha: HEAD_SHA });
  deps.fetchIssue.mockResolvedValue(fakeIssue);
  return deps;
}

function baseSnapshot(overrides: Partial<GroomingEvidenceSnapshot> = {}): GroomingEvidenceSnapshot {
  return {
    capturedAt: "2026-09-25T00:00:00.000Z",
    repoFullName: REPO,
    defaultBranch: "main",
    headSha: HEAD_SHA,
    pinnedRef: HEAD_SHA,
    issue: {
      number: 42,
      title: "Fix authentication timeout",
      body: "Users get a 504 when the auth service is slow.",
      labels: ["priority/p2", "status/ready"],
      state: "open",
      updatedAt: "2026-09-15T12:00:00Z",
      url: `https://github.com/${REPO}/issues/42`,
    },
    issueFingerprint: "fp",
    comments: [],
    evidenceDigest: "digest",
    warnings: [],
    sources: [],
    ...overrides,
  };
}

describe("computeIssueFingerprint", () => {
  const issue: EvidenceSnapshotIssue = {
    number: 7,
    title: "Fix bug",
    body: "It breaks",
    labels: ["priority/p2", "status/ready"],
    state: "open",
    updatedAt: "2026-09-15T12:00:00Z",
    url: `https://github.com/${REPO}/issues/7`,
  };

  it("is deterministic for the same issue object", () => {
    expect(computeIssueFingerprint(issue)).toBe(computeIssueFingerprint(issue));
  });

  it("changes when the body changes", () => {
    expect(computeIssueFingerprint({ ...issue, body: "It breaks differently" })).not.toBe(
      computeIssueFingerprint(issue),
    );
  });

  it("is stable across label ordering", () => {
    expect(computeIssueFingerprint({ ...issue, labels: ["status/ready", "priority/p2"] })).toBe(
      computeIssueFingerprint(issue),
    );
  });
});

describe("computeEvidenceDigest", () => {
  const base = {
    defaultBranch: "main",
    issueFingerprint: "fp",
    comments: [
      {
        id: "1",
        author: "alice",
        createdAt: "2026-09-10T00:00:00Z",
        body: "hello",
        provenance: "human_comment" as const,
        authoritative: true,
      },
    ],
  };

  it("changes when the pinned head SHA changes (branch moved)", () => {
    const before = computeEvidenceDigest({ ...base, headSha: "b".repeat(40) });
    const after = computeEvidenceDigest({ ...base, headSha: "c".repeat(40) });
    expect(before).not.toBe(after);
  });

  it("changes when a comment's provenance changes", () => {
    const human = computeEvidenceDigest({ ...base, headSha: HEAD_SHA });
    const automation = computeEvidenceDigest({
      ...base,
      headSha: HEAD_SHA,
      comments: base.comments.map((comment) => ({
        ...comment,
        provenance: "automation_comment" as const,
      })),
    });
    expect(human).not.toBe(automation);
  });
});

describe("collectGroomingEvidenceSnapshot", () => {
  it("maps the live issue and pins the default-branch head", async () => {
    const snapshot = await collectGroomingEvidenceSnapshot(input, happyDeps());

    expect(snapshot.defaultBranch).toBe("main");
    expect(snapshot.headSha).toBe(HEAD_SHA);
    expect(snapshot.pinnedRef).toBe(HEAD_SHA);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.issue).toEqual({
      number: 42,
      title: "Fix authentication timeout",
      body: "Users get a 504 when the auth service is slow.",
      labels: ["priority/p2", "status/ready"],
      state: "open",
      updatedAt: "2026-09-15T12:00:00Z",
      url: `https://github.com/${REPO}/issues/42`,
    });
    expect(snapshot.issueFingerprint).toBe(computeIssueFingerprint(snapshot.issue));
    expect(snapshot.evidenceDigest).toBe(
      computeEvidenceDigest({
        headSha: snapshot.headSha,
        defaultBranch: snapshot.defaultBranch,
        issueFingerprint: snapshot.issueFingerprint,
        comments: snapshot.comments,
      }),
    );
  });

  it("classifies comment provenance: automation authors are never authoritative", async () => {
    const snapshot = await collectGroomingEvidenceSnapshot(input, happyDeps());
    const byId = new Map(snapshot.comments.map((comment) => [comment.id, comment]));

    expect(byId.get("1")).toMatchObject({ author: "alice", provenance: "human_comment", authoritative: true });
    expect(byId.get("2")).toMatchObject({
      author: "github-actions[bot]",
      provenance: "automation_comment",
      authoritative: false,
    });
    expect(byId.get("3")).toMatchObject({
      author: "itsmiso-ai",
      provenance: "automation_comment",
      authoritative: false,
    });
    // Comment without an id gets a synthetic positional id.
    expect(byId.get("synthetic-3")).toMatchObject({
      author: "bob",
      provenance: "human_comment",
      authoritative: true,
    });
  });

  it("warns when fetchLatestCommit resolves null so reads are not silently unpinned", async () => {
    const deps = makeDeps();
    deps.fetchRepositoryMetadata.mockResolvedValue({ defaultBranch: "main" });
    deps.fetchLatestCommit.mockResolvedValue(null);
    deps.fetchIssue.mockResolvedValue(fakeIssue);

    const snapshot = await collectGroomingEvidenceSnapshot(input, deps);

    expect(snapshot.headSha).toBeNull();
    expect(snapshot.pinnedRef).toBeNull();
    expect(snapshot.warnings.some((warning) => /unpinned/i.test(warning))).toBe(true);
  });

  it("does not warn about unpinned reads when fetchLatestCommit resolves a real sha", async () => {
    const snapshot = await collectGroomingEvidenceSnapshot(input, happyDeps());

    expect(snapshot.warnings.some((warning) => /unpinned/i.test(warning))).toBe(false);
  });

  it("degrades gracefully when every dependency call rejects", async () => {
    const deps = makeDeps();
    deps.fetchIssue.mockRejectedValue(new Error("issue fetch blew up"));
    deps.fetchRepositoryMetadata.mockRejectedValue(new Error("metadata fetch blew up"));
    deps.fetchLatestCommit.mockRejectedValue(new Error("commit fetch blew up"));

    const snapshot = await collectGroomingEvidenceSnapshot(input, deps);

    expect(snapshot.headSha).toBeNull();
    expect(snapshot.pinnedRef).toBeNull();
    expect(snapshot.defaultBranch).toBeNull();
    expect(snapshot.warnings.length).toBeGreaterThan(0);
    expect(snapshot.issue).toEqual({
      number: 42,
      title: "",
      body: null,
      labels: [],
      state: "unknown",
      updatedAt: "",
      url: "",
    });
    // Comments are still mapped from the provided input.
    expect(snapshot.comments).toHaveLength(4);
  });
});

describe("addEvidenceSources", () => {
  it("appends sources pinned to the run head SHA, deduped, without mutating the input", async () => {
    const snapshot = await collectGroomingEvidenceSnapshot(input, happyDeps());

    const next = addEvidenceSources(snapshot, ["src/a.ts", "src/a.ts", "src/b.ts"]);

    expect(next.sources).toEqual([
      { path: "src/a.ts", provenance: "repository", ref: HEAD_SHA },
      { path: "src/b.ts", provenance: "repository", ref: HEAD_SHA },
    ]);
    expect(snapshot.sources).toEqual([]);
  });

  it("caps sources at the maximum", () => {
    const paths = Array.from({ length: 70 }, (_, i) => `src/file-${i}.ts`);
    const next = addEvidenceSources(baseSnapshot(), paths);

    expect(next.sources).toHaveLength(60);
    expect(next.sources.map((source) => source.path)).toEqual(paths.slice(0, 60));
  });
});

describe("summarizeEvidenceForPersistence", () => {
  it("returns the expected keys and bounded counts", async () => {
    const snapshot = await collectGroomingEvidenceSnapshot(input, happyDeps());
    const withSources = addEvidenceSources(snapshot, ["src/a.ts", "src/b.ts"]);

    const summary = summarizeEvidenceForPersistence(withSources);

    expect(Object.keys(summary).sort()).toEqual([
      "automationCommentCount",
      "capturedAt",
      "commentCount",
      "commentProvenance",
      "defaultBranch",
      "evidenceDigest",
      "headSha",
      "humanCommentCount",
      "issueFingerprint",
      "issueState",
      "issueUpdatedAt",
      "pinnedRef",
      "sourceCount",
      "sources",
      "warnings",
    ]);
    expect(summary).toMatchObject({
      capturedAt: snapshot.capturedAt,
      defaultBranch: "main",
      headSha: HEAD_SHA,
      pinnedRef: HEAD_SHA,
      evidenceDigest: snapshot.evidenceDigest,
      issueFingerprint: snapshot.issueFingerprint,
      issueUpdatedAt: "2026-09-15T12:00:00Z",
      issueState: "open",
      commentCount: 4,
      humanCommentCount: 2,
      automationCommentCount: 2,
      sourceCount: 2,
    });
    expect(summary.commentProvenance).toEqual(
      withSources.comments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        provenance: comment.provenance,
      })),
    );
    expect(summary.sources).toEqual([
      { path: "src/a.ts", provenance: "repository", ref: HEAD_SHA },
      { path: "src/b.ts", provenance: "repository", ref: HEAD_SHA },
    ]);
    expect(summary.warnings).toEqual([]);
  });
});
