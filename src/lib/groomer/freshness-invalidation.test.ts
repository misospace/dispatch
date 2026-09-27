import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitComparison } from "@/lib/github-code-search";
import {
  DEFAULT_FRESHNESS_BUDGET,
  invalidateGroomingForComment,
  runGroomingFreshnessPass,
  type FreshnessGitHub,
  type FreshnessIssueRow,
  type FreshnessStore,
} from "./freshness-invalidation";
import { buildGroomingFreshnessBaseline, computeGroomingIssueFingerprint } from "./freshness";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";

const REPO = { id: "repo-1", fullName: "org/repo" };
const CAPTURED = new Date("2026-09-25T00:00:00.000Z");

function row(overrides: Partial<FreshnessIssueRow> = {}): FreshnessIssueRow {
  const base = {
    title: "Fix it",
    body: "Body",
    state: "open",
    labels: ["status/ready", "priority/p1"],
  };
  const merged = { ...base, ...overrides };
  return {
    id: `issue-${overrides.number ?? 1}`,
    number: 1,
    commentsCount: 2,
    groomedRunId: "gr-1",
    groomedHeadSha: "sha-1",
    groomedDefaultBranch: "main",
    groomedIssueFingerprint: computeGroomingIssueFingerprint(merged),
    groomedCommentCount: 2,
    groomedEvidenceCapturedAt: CAPTURED,
    groomedEvidenceScope: "paths",
    groomedEvidencePaths: ["src/a.ts"],
    groomedDependencyKeys: [],
    groomedOpenBlockerKeys: [],
    groomedRelatedWork: null,
    groomingVerifiedSha: "sha-1",
    ...merged,
  };
}

interface FakeStore extends FreshnessStore {
  rows: FreshnessIssueRow[];
  stale: Map<string, { reasons: string[]; detail: string }>;
  advanced: Array<{ id: string; data: Record<string, unknown> }>;
  audits: string[];
  openKeys: Set<string>;
  cachedStates: Map<string, "open" | "closed">;
}

function fakeStore(rows: FreshnessIssueRow[]): FakeStore {
  const store: FakeStore = {
    rows,
    stale: new Map(),
    advanced: [],
    audits: [],
    openKeys: new Set(),
    cachedStates: new Map(),
    async findFreshIssues(_repositoryId, take) {
      return store.rows.filter((r) => !store.stale.has(r.id)).slice(0, take);
    },
    async findOpenIssueKeys() {
      return store.openKeys;
    },
    async findCachedIssueStates() {
      return store.cachedStates;
    },
    async markStale(issue, mark) {
      if (store.stale.has(issue.id)) return false;
      store.stale.set(issue.id, { reasons: [...mark.reasons], detail: mark.detail });
      return true;
    },
    async advance(issue, data) {
      store.advanced.push({ id: issue.id, data });
    },
    async recordAudit(_repo, issue) {
      store.audits.push(issue.id);
    },
  };
  return store;
}

function fakeGitHub() {
  return {
    fetchHeadSha: vi.fn(async (): Promise<string | null> => "sha-1"),
    compareCommits: vi.fn(
      async (): Promise<CommitComparison> => ({ ok: true, status: "ahead", files: [], truncated: false }),
    ),
    fetchRecentComments: vi.fn(async (): Promise<Array<{ author: string; createdAt: string }>> => []),
    fetchIssueState: vi.fn(async (): Promise<"open" | "closed" | null> => "open"),
    fetchPullRequestState: vi.fn(async (): Promise<"open" | "closed" | "merged" | null> => "open"),
  };
}

async function pass(store: FakeStore, github: ReturnType<typeof fakeGitHub>, budget = DEFAULT_FRESHNESS_BUDGET) {
  return runGroomingFreshnessPass([REPO], store, github as unknown as FreshnessGitHub, budget, () => new Date());
}

describe("runGroomingFreshnessPass", () => {
  let github: ReturnType<typeof fakeGitHub>;
  beforeEach(() => {
    github = fakeGitHub();
  });

  it("leaves unchanged evidence fresh with only the head lookup", async () => {
    const store = fakeStore([row()]);
    const result = await pass(store, github);
    expect(store.stale.size).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(github.fetchHeadSha).toHaveBeenCalledTimes(1);
    expect(github.compareCommits).not.toHaveBeenCalled();
    expect(github.fetchRecentComments).not.toHaveBeenCalled();
  });

  it("stales an external issue body edit", async () => {
    const store = fakeStore([{ ...row(), body: "Edited by a human" }]);
    const result = await pass(store, github);
    expect(store.stale.get("issue-1")?.reasons).toEqual(["issue_changed"]);
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 1, reasons: ["issue_changed"] }]);
    expect(store.audits).toEqual(["issue-1"]);
  });

  it("does not stale the groomer's own expected post-apply state, or a claim label", async () => {
    // Baseline built the way run.ts builds it, from what the groom wrote.
    const evidence = {
      headSha: "sha-1",
      defaultBranch: "main",
      evidenceDigest: "d",
      sources: [{ path: "src/a.ts", provenance: "repository", ref: "sha-1" }],
      issue: { number: 1, title: "Short", body: "Old body", labels: [], state: "open", updatedAt: "", url: "" },
    } as unknown as GroomingEvidenceSnapshot;
    const baseline = await buildGroomingFreshnessBaseline({
      groomingRunId: "gr-9",
      repoFullName: "org/repo",
      issueNumber: 1,
      evidence,
      candidate: { title: "Short", body: "Old body", commentsCount: 0 },
      appliedTitle: "A properly descriptive title",
      appliedBody: "Enriched body",
      labelsAfter: ["status/ready", "priority/p2", "type/bug"],
      closed: false,
      evidenceWindowStart: CAPTURED,
      repositoryQueries: [],
      explorationRan: true,
      explorationToolCalls: [],
      resolveOpenKeys: async () => new Set(),
    });
    // What the next sync caches from GitHub: labels in another order, plus a
    // worker's agent label merged in by sync.
    const synced = {
      ...row(),
      ...baseline,
      title: "A properly descriptive title",
      body: "Enriched body\r\n",
      labels: ["type/bug", "agent/coder", "priority/p2", "status/ready"],
      commentsCount: 0,
    } as FreshnessIssueRow;
    const store = fakeStore([synced]);
    await pass(store, github);
    expect(store.stale.size).toBe(0);
  });

  it("skips worker-owned statuses entirely", async () => {
    const store = fakeStore([{ ...row(), labels: ["status/in-progress", "priority/p1", "agent/coder"] }]);
    const result = await pass(store, github);
    expect(result.issuesChecked).toBe(0);
    expect(store.stale.size).toBe(0);
  });

  it("stales on a new human comment", async () => {
    github.fetchRecentComments.mockResolvedValue([
      { author: "itsmiso-ai", createdAt: "2026-09-25T01:00:00Z" },
      { author: "joryirving", createdAt: "2026-09-25T02:00:00Z" },
    ]);
    const store = fakeStore([{ ...row(), commentsCount: 4 }]);
    await pass(store, github);
    expect(store.stale.get("issue-1")?.reasons).toEqual(["human_comment"]);
    expect(store.stale.get("issue-1")?.detail).toContain("joryirving");
  });

  it("does not stale on automation comments, and advances the comment baseline", async () => {
    github.fetchRecentComments.mockResolvedValue([
      { author: "itsmiso-ai", createdAt: "2026-09-25T01:00:00Z" },
      { author: "renovate[bot]", createdAt: "2026-09-25T02:00:00Z" },
      // A human comment the groom already saw (before the evidence window).
      { author: "joryirving", createdAt: "2026-09-24T02:00:00Z" },
    ]);
    const store = fakeStore([{ ...row(), commentsCount: 4 }]);
    await pass(store, github);
    expect(store.stale.size).toBe(0);
    expect(store.advanced).toEqual([{ id: "issue-1", data: { groomedCommentCount: 4 } }]);

    // Idempotent: with the advanced baseline, the next pass reads no comments.
    store.rows = [{ ...store.rows[0], groomedCommentCount: 4 }];
    github.fetchRecentComments.mockClear();
    await pass(store, github);
    expect(github.fetchRecentComments).not.toHaveBeenCalled();
  });

  it("stales when a dependency blocker resolves (a parked not-ready issue)", async () => {
    const blocked = {
      ...row({ labels: ["status/blocked", "priority/p1"] }),
      groomedDependencyKeys: ["org/repo#5"],
      groomedOpenBlockerKeys: ["org/repo#5"],
    };
    const store = fakeStore([blocked]);
    store.openKeys = new Set(); // #5 closed since grooming
    await pass(store, github);
    expect(store.stale.get("issue-1")?.reasons).toEqual(["dependency_changed"]);
    expect(store.stale.get("issue-1")?.detail).toContain("org/repo#5 -> none");
  });

  it("stales when a dependency reopens, and not when blockers are unchanged", async () => {
    const store = fakeStore([
      { ...row({ number: 1 }), groomedDependencyKeys: ["org/repo#5"], groomedOpenBlockerKeys: [] },
      { ...row({ number: 2 }), groomedDependencyKeys: ["org/repo#6"], groomedOpenBlockerKeys: ["org/repo#6"] },
    ]);
    store.openKeys = new Set(["org/repo#5", "org/repo#6"]);
    await pass(store, github);
    expect(store.stale.get("issue-1")?.reasons).toEqual(["dependency_changed"]);
    expect(store.stale.has("issue-2")).toBe(false);
  });

  it("stales when cited related work changed state", async () => {
    const store = fakeStore([
      {
        ...row({ number: 1 }),
        groomedRelatedWork: [{ key: "github:pr:org/repo#12", kind: "pull_request", repo: "org/repo", number: 12, state: "open" }],
      },
      {
        ...row({ number: 2 }),
        groomedRelatedWork: [{ key: "github:issue:org/repo#13", kind: "issue", repo: "org/repo", number: 13, state: "open" }],
      },
    ]);
    store.cachedStates = new Map([["org/repo#13", "open"]]);
    github.fetchPullRequestState.mockResolvedValue("merged");
    await pass(store, github);
    expect(store.stale.get("issue-1")?.reasons).toEqual(["related_work_changed"]);
    // Tracked issue answered from the cache, no GitHub read.
    expect(store.stale.has("issue-2")).toBe(false);
    expect(github.fetchIssueState).not.toHaveBeenCalled();
  });

  describe("default-branch commits", () => {
    it("does not stale a path-bounded result for an unrelated commit, and advances the verified SHA", async () => {
      github.fetchHeadSha.mockResolvedValue("sha-2");
      github.compareCommits.mockResolvedValue({ ok: true, status: "ahead", files: ["docs/readme.md"], truncated: false });
      const store = fakeStore([row()]);
      await pass(store, github);
      expect(store.stale.size).toBe(0);
      expect(store.advanced).toEqual([{ id: "issue-1", data: { groomingVerifiedSha: "sha-2" } }]);
    });

    it("stales a result whose evidenced path the commit touched", async () => {
      github.fetchHeadSha.mockResolvedValue("sha-2");
      github.compareCommits.mockResolvedValue({ ok: true, status: "ahead", files: ["src/a.ts"], truncated: false });
      const store = fakeStore([row()]);
      await pass(store, github);
      expect(store.stale.get("issue-1")?.reasons).toEqual(["evidence_path_changed"]);
      expect(store.stale.get("issue-1")?.detail).toContain("src/a.ts");
    });

    it("conservatively stales global (negative) evidence on any commit", async () => {
      github.fetchHeadSha.mockResolvedValue("sha-2");
      github.compareCommits.mockResolvedValue({ ok: true, status: "ahead", files: ["docs/readme.md"], truncated: false });
      const store = fakeStore([{ ...row(), groomedEvidenceScope: "global", groomedEvidencePaths: [] }]);
      await pass(store, github);
      expect(store.stale.get("issue-1")?.reasons).toEqual(["global_evidence_commit"]);
    });

    it("ignores commits for a result that used no repository evidence", async () => {
      github.fetchHeadSha.mockResolvedValue("sha-2");
      const store = fakeStore([{ ...row(), groomedEvidenceScope: "none", groomedEvidencePaths: [] }]);
      await pass(store, github);
      expect(github.fetchHeadSha).not.toHaveBeenCalled();
      expect(store.stale.size).toBe(0);
    });

    it("defers on a transient compare failure without staling or advancing", async () => {
      github.fetchHeadSha.mockResolvedValue("sha-2");
      github.compareCommits.mockResolvedValue({ ok: false, httpStatus: 502, definitive: false, message: "502" });
      const store = fakeStore([row()]);
      const result = await pass(store, github);
      expect(store.stale.size).toBe(0);
      expect(store.advanced).toEqual([]);
      expect(result.deferred).toBe(1);
      expect(result.warnings.join(" ")).toContain("502");
    });

    it("stales conservatively when the compare is definitively unreliable", async () => {
      github.fetchHeadSha.mockResolvedValue("sha-2");
      github.compareCommits
        .mockResolvedValueOnce({ ok: false, httpStatus: 404, definitive: true, message: "404 base gone" })
        .mockResolvedValueOnce({ ok: true, status: "ahead", files: [], truncated: true })
        .mockResolvedValueOnce({ ok: true, status: "diverged", files: [], truncated: false });
      const store = fakeStore([
        { ...row({ number: 1 }), groomingVerifiedSha: "base-a" },
        { ...row({ number: 2 }), groomingVerifiedSha: "base-b" },
        { ...row({ number: 3 }), groomingVerifiedSha: "base-c" },
      ]);
      await pass(store, github);
      for (const id of ["issue-1", "issue-2", "issue-3"]) {
        expect(store.stale.get(id)?.reasons).toEqual(["compare_unreliable"]);
      }
    });

    it("leaves an unpinned groom unverified rather than stale", async () => {
      const store = fakeStore([{ ...row(), groomedHeadSha: null, groomingVerifiedSha: null }]);
      const result = await pass(store, github);
      expect(store.stale.size).toBe(0);
      expect(result.deferred).toBe(1);
    });
  });

  describe("bounds and idempotency", () => {
    it("shares one compare across every issue verified at the same SHA", async () => {
      github.fetchHeadSha.mockResolvedValue("sha-2");
      const store = fakeStore([row({ number: 1 }), row({ number: 2 }), row({ number: 3 })]);
      await pass(store, github);
      expect(github.fetchHeadSha).toHaveBeenCalledTimes(1);
      expect(github.compareCommits).toHaveBeenCalledTimes(1);
    });

    it("respects the compare and comment budgets and defers the rest", async () => {
      github.fetchHeadSha.mockResolvedValue("sha-2");
      const rows = [1, 2, 3, 4].map((number) => ({
        ...row({ number }),
        groomingVerifiedSha: `base-${number}`,
        commentsCount: 5,
      }));
      const store = fakeStore(rows);
      const result = await pass(store, github, {
        ...DEFAULT_FRESHNESS_BUDGET,
        maxCompares: 2,
        maxCommentFetches: 1,
      });
      expect(github.compareCommits).toHaveBeenCalledTimes(2);
      expect(github.fetchRecentComments).toHaveBeenCalledTimes(1);
      // #1 fully checked; #2 lost its comment read, #3/#4 both reads.
      expect(result.deferred).toBe(3);
      expect(store.stale.size).toBe(0);
    });

    it("never marks the same baseline twice", async () => {
      const store = fakeStore([{ ...row(), title: "Changed" }]);
      await pass(store, github);
      // A second evaluation of the same (now stale) row: the store's guard refuses it.
      store.findFreshIssues = async () => store.rows;
      const second = await pass(store, github);
      expect(second.markedStale).toEqual([]);
      expect(store.audits).toEqual(["issue-1"]);
    });

    it("isolates a failing repo", async () => {
      const store = fakeStore([row()]);
      store.findFreshIssues = async () => {
        throw new Error("db down");
      };
      const result = await pass(store, github);
      expect(result.warnings[0]).toContain("db down");
    });
  });
});

describe("invalidateGroomingForComment", () => {
  function client(issue: Record<string, unknown> | null) {
    return {
      issue: {
        findUnique: vi.fn(async () => issue),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      auditLog: { create: vi.fn(async () => ({})) },
    };
  }
  const fresh = {
    id: "issue-1",
    labels: ["status/ready"],
    groomedRunId: "gr-1",
    groomedIssueFingerprint: "fp",
    groomingStaleAt: null,
    groomedEvidenceCapturedAt: CAPTURED,
  };
  const input = { issueId: "issue-1", repoFullName: "org/repo", issueNumber: 1, createdAt: "2026-09-25T03:00:00Z" };

  it("stales a fresh result for a new human comment, guarded on the baseline", async () => {
    const db = client(fresh);
    expect(await invalidateGroomingForComment({ ...input, author: "joryirving" }, db as never)).toBe(true);
    expect(db.issue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "issue-1", groomedRunId: "gr-1", groomingStaleAt: null },
        data: expect.objectContaining({ groomingStaleReasons: ["human_comment"] }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("ignores automation comments, old comments and baseline-less issues", async () => {
    const db = client(fresh);
    expect(await invalidateGroomingForComment({ ...input, author: "itsmiso-ai" }, db as never)).toBe(false);
    expect(db.issue.findUnique).not.toHaveBeenCalled();
    expect(
      await invalidateGroomingForComment({ ...input, author: "joryirving", createdAt: "2026-09-24T00:00:00Z" }, db as never),
    ).toBe(false);
    const unknown = client({ ...fresh, groomedIssueFingerprint: null });
    expect(await invalidateGroomingForComment({ ...input, author: "joryirving" }, unknown as never)).toBe(false);
    expect(db.issue.updateMany).not.toHaveBeenCalled();
    expect(unknown.issue.updateMany).not.toHaveBeenCalled();
  });
});
