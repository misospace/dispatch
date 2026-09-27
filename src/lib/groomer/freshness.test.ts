import { describe, expect, it } from "vitest";
import {
  buildGroomingFreshnessBaseline,
  computeGroomingIssueFingerprint,
  deriveEvidenceReliance,
  deriveEvidenceScope,
  deriveGroomingFreshness,
  dependencyKeysForIssue,
  hasNegativeSearchResult,
  intersectEvidencePaths,
  isFreshnessTrackedStatus,
  relatedWorkBaseline,
  type GroomingFreshnessInput,
  UNKNOWN_FRESHNESS,
} from "./freshness";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";

const evidence: GroomingEvidenceSnapshot = {
  capturedAt: "2026-09-25T00:00:00.000Z",
  repoFullName: "org/repo",
  defaultBranch: "main",
  headSha: "sha-1",
  pinnedRef: "sha-1",
  issue: {
    number: 7,
    title: "Live title",
    body: "Live body. Depends on #5 and other/repo#9.",
    labels: ["priority/p1"],
    state: "open",
    updatedAt: "2026-09-24T00:00:00.000Z",
    url: "https://github.com/org/repo/issues/7",
  },
  issueFingerprint: "pre",
  comments: [],
  evidenceDigest: "digest-1",
  warnings: [],
  sources: [
    { path: "src/a.ts", provenance: "repository", via: "read", ref: "sha-1" },
    { path: "src/a.ts", provenance: "repository", via: "read", ref: "sha-1" },
    { path: "src/hit.ts", provenance: "repository", via: "surfaced", ref: null },
    {
      key: "github:pr:org/repo#12",
      provenance: "github_pull_request",
      state: "open",
      url: null,
      via: "read",
      observedAt: "2026-09-25T00:00:00.000Z",
      ref: null,
    },
    {
      key: "github:issue:org/repo#13",
      provenance: "github_issue",
      state: "closed",
      url: null,
      via: "search",
      observedAt: "2026-09-25T00:00:00.000Z",
      ref: null,
    },
  ],
};

function input(overrides: Partial<GroomingFreshnessInput> = {}): GroomingFreshnessInput {
  return {
    groomingRunId: "gr-1",
    repoFullName: "org/repo",
    issueNumber: 7,
    evidence,
    candidate: { title: "Cached title", body: "Cached body", commentsCount: 3 },
    labelsAfter: ["priority/p1", "status/ready"],
    closed: false,
    evidenceWindowStart: new Date("2026-09-24T23:59:00.000Z"),
    repositoryQueries: [],
    explorationRan: true,
    explorationToolCalls: [{ name: "read_file", ok: true, bytes: 100 }],
    resolveOpenKeys: async (keys) => new Set(keys.filter((key) => key === "org/repo#5")),
    ...overrides,
  };
}

describe("computeGroomingIssueFingerprint", () => {
  const base = { title: "T", body: "B", state: "open", labels: ["status/ready", "priority/p1"] };

  it("ignores label order, agent claims, CRLF and trailing whitespace", () => {
    const fp = computeGroomingIssueFingerprint(base);
    expect(
      computeGroomingIssueFingerprint({
        title: " T ",
        body: "B\r\n\n",
        state: "OPEN",
        labels: ["priority/p1", "agent/koji", "status/ready"],
      }),
    ).toBe(fp);
  });

  it("changes on a title, body, state or non-agent label change", () => {
    const fp = computeGroomingIssueFingerprint(base);
    expect(computeGroomingIssueFingerprint({ ...base, title: "T2" })).not.toBe(fp);
    expect(computeGroomingIssueFingerprint({ ...base, body: "B2" })).not.toBe(fp);
    expect(computeGroomingIssueFingerprint({ ...base, state: "closed" })).not.toBe(fp);
    expect(computeGroomingIssueFingerprint({ ...base, labels: ["status/backlog", "priority/p1"] })).not.toBe(fp);
  });
});

describe("evidence scope", () => {
  it("treats a zero-result code search as a negative (global) assertion", () => {
    expect(hasNegativeSearchResult([{ name: "search_code", ok: true, bytes: 0 }])).toBe(true);
    expect(hasNegativeSearchResult([{ name: "search_code", ok: true, bytes: 40 }])).toBe(false);
    expect(hasNegativeSearchResult([{ name: "search_code", ok: false, bytes: 20 }])).toBe(false);
  });

  it("derives paths, global and none", () => {
    expect(deriveEvidenceScope({ repositoryPaths: ["a"], negativeSearch: false, repositoryConsulted: true })).toBe("paths");
    expect(deriveEvidenceScope({ repositoryPaths: ["a"], negativeSearch: true, repositoryConsulted: true })).toBe("global");
    expect(deriveEvidenceScope({ repositoryPaths: [], negativeSearch: false, repositoryConsulted: true })).toBe("global");
    expect(deriveEvidenceScope({ repositoryPaths: [], negativeSearch: false, repositoryConsulted: false })).toBe("none");
  });
});

describe("intersectEvidencePaths", () => {
  it("matches exact files and directory prefixes only", () => {
    expect(intersectEvidencePaths(["src/a.ts", "docs"], ["src/a.ts", "docs/x.md", "src/ab.ts", "docsx/y"])).toEqual([
      "src/a.ts",
      "docs/x.md",
    ]);
  });

  it("treats the repository root as matching everything", () => {
    expect(intersectEvidencePaths([""], ["anything.ts"])).toEqual(["anything.ts"]);
  });
});

describe("dependency and related-work baselines", () => {
  it("resolves same-repo refs and drops self references", () => {
    expect(dependencyKeysForIssue("Depends on #5, #7 and other/Repo#9", "org/repo", 7)).toEqual([
      "org/repo#5",
      "other/repo#9",
    ]);
  });

  it("keeps only directly read issue/PR refs with a state", () => {
    expect(relatedWorkBaseline(evidence.sources)).toEqual([
      { key: "github:pr:org/repo#12", kind: "pull_request", repo: "org/repo", number: 12, state: "open" },
    ]);
  });
});

describe("deriveEvidenceReliance", () => {
  it("without citations, relies on read paths only (surfaced hits never bound a result)", () => {
    const reliance = deriveEvidenceReliance(evidence.sources, undefined);
    expect(reliance.repositoryPaths).toEqual(["src/a.ts"]);
    expect(reliance.reliesOnSurfacedPath).toBe(false);
    expect(reliance.basis).toEqual({ repository: "heuristic", relatedWork: "heuristic" });
  });

  it("a surfaced-only run has no read path, so it is global", () => {
    const sources = [{ path: "src/hit.ts", provenance: "repository" as const, via: "surfaced" as const, ref: null }];
    const reliance = deriveEvidenceReliance(sources, undefined);
    expect(reliance.repositoryPaths).toEqual([]);
    expect(
      deriveEvidenceScope({ repositoryPaths: reliance.repositoryPaths, negativeSearch: false, repositoryConsulted: true }),
    ).toBe("global");
  });

  it("prefers the plan's citations over the heuristic", () => {
    const sources = [
      ...evidence.sources,
      { path: "src/b.ts", provenance: "repository" as const, via: "read" as const, ref: "sha-1" },
    ];
    const reliance = deriveEvidenceReliance(sources, [
      { id: "issue", subject: "issue", state: null },
      { id: "repo:src/b.ts", subject: "repository", state: null },
      { id: "github:issue:org/repo#13", subject: "related_work", state: "closed" },
    ]);
    // Only the cited read path, not every read path.
    expect(reliance.repositoryPaths).toEqual(["src/b.ts"]);
    expect(reliance.reliesOnSurfacedPath).toBe(false);
    // The cited search hit replaces the heuristic's directly-read PR.
    expect(reliance.relatedWork).toEqual([
      { key: "github:issue:org/repo#13", kind: "issue", repo: "org/repo", number: 13, state: "closed" },
    ]);
    expect(reliance.basis).toEqual({ repository: "citations", relatedWork: "citations" });
  });

  it("a cited surfaced-only path makes the result global", () => {
    const reliance = deriveEvidenceReliance(evidence.sources, [
      { id: "repo:src/a.ts", subject: "repository", state: null },
      { id: "repo:src/hit.ts", subject: "repository", state: null },
    ]);
    expect(reliance.repositoryPaths).toEqual(["src/a.ts"]);
    expect(reliance.reliesOnSurfacedPath).toBe(true);
    expect(
      deriveEvidenceScope({
        repositoryPaths: reliance.repositoryPaths,
        negativeSearch: false,
        repositoryConsulted: true,
        reliesOnSurfacedPath: true,
      }),
    ).toBe("global");
  });
});

describe("buildGroomingFreshnessBaseline", () => {
  it("records the pinned revision, evidence and expected post-apply state", async () => {
    const baseline = await buildGroomingFreshnessBaseline(input());
    expect(baseline).toMatchObject({
      groomedRunId: "gr-1",
      groomedHeadSha: "sha-1",
      groomedDefaultBranch: "main",
      groomedCommentCount: 3,
      groomedEvidenceDigest: "digest-1",
      groomedEvidenceScope: "paths",
      groomedEvidencePaths: ["src/a.ts"],
      groomedDependencyKeys: ["org/repo#5", "other/repo#9"],
      groomedOpenBlockerKeys: ["org/repo#5"],
      groomingVerifiedSha: "sha-1",
      groomingStaleAt: null,
      groomingStaleReasons: [],
    });
    // Live title/body + the labels the groom wrote.
    expect(baseline.groomedIssueFingerprint).toBe(
      computeGroomingIssueFingerprint({
        title: "Live title",
        body: evidence.issue.body,
        state: "open",
        labels: ["status/ready", "priority/p1"],
      }),
    );
  });

  it("fingerprints the groom's own title/body/close writes, so they are not external changes", async () => {
    const baseline = await buildGroomingFreshnessBaseline(
      input({ appliedTitle: "Rewritten", appliedBody: "Enriched", closed: true, labelsAfter: ["status/done"] }),
    );
    expect(baseline.groomedIssueFingerprint).toBe(
      computeGroomingIssueFingerprint({ title: "Rewritten", body: "Enriched", state: "closed", labels: ["status/done"] }),
    );
    expect(baseline.groomedDependencyKeys).toEqual([]);
  });

  it("falls back to the cached issue when the live capture failed", async () => {
    const baseline = await buildGroomingFreshnessBaseline(
      input({ evidence: { ...evidence, issue: { ...evidence.issue, state: "unknown" } } }),
    );
    expect(baseline.groomedIssueFingerprint).toBe(
      computeGroomingIssueFingerprint({
        title: "Cached title",
        body: "Cached body",
        state: "open",
        labels: ["priority/p1", "status/ready"],
      }),
    );
  });

  it("uses plan citations when given", async () => {
    const baseline = await buildGroomingFreshnessBaseline(
      input({ citations: [{ id: "repo:src/hit.ts", subject: "repository", state: null }] }),
    );
    expect(baseline.groomedEvidenceScope).toBe("global");
    expect(baseline.groomedEvidencePaths).toEqual([]);
  });

  it("marks a negative code search as global evidence", async () => {
    const baseline = await buildGroomingFreshnessBaseline(
      input({ explorationToolCalls: [{ name: "search_code", ok: true, bytes: 0 }] }),
    );
    expect(baseline.groomedEvidenceScope).toBe("global");
  });
});

describe("deriveGroomingFreshness", () => {
  it("is unknown without a baseline, stale when marked, fresh otherwise", () => {
    expect(deriveGroomingFreshness({ groomedIssueFingerprint: null, groomingStaleAt: null }).status).toBe("unknown");
    expect(
      deriveGroomingFreshness({
        groomedIssueFingerprint: "fp",
        groomingStaleAt: new Date(),
        groomingStaleReasons: ["human_comment"],
      }),
    ).toEqual({ status: "stale", reasons: ["human_comment"], verifiedAgainstHead: null });
    expect(deriveGroomingFreshness({ groomedIssueFingerprint: "fp", groomingStaleAt: null }).status).toBe("fresh");
  });

  it("reports head verification when a current head is supplied", () => {
    const issue = { groomedIssueFingerprint: "fp", groomingStaleAt: null, groomingVerifiedSha: "sha-2" };
    expect(deriveGroomingFreshness(issue, "sha-2").verifiedAgainstHead).toBe(true);
    expect(deriveGroomingFreshness(issue, "sha-3").verifiedAgainstHead).toBe(false);
    expect(deriveGroomingFreshness({ ...issue, groomingVerifiedSha: null }, "sha-2").verifiedAgainstHead).toBe(false);
  });
});

describe("isFreshnessTrackedStatus", () => {
  it("excludes worker-owned statuses", () => {
    expect(isFreshnessTrackedStatus(["status/ready"])).toBe(true);
    expect(isFreshnessTrackedStatus(["status/blocked"])).toBe(true);
    expect(isFreshnessTrackedStatus(["status/in-progress"])).toBe(false);
    expect(isFreshnessTrackedStatus(["status/in-review"])).toBe(false);
    expect(isFreshnessTrackedStatus(["status/done"])).toBe(false);
  });
});

describe("UNKNOWN_FRESHNESS", () => {
  it("also clears the unreadable-state backoff (dispatch#1063), so an external groom makes the issue selectable again", () => {
    expect(UNKNOWN_FRESHNESS).toMatchObject({ groomedIssueFingerprint: null, groomingStaleAt: null, groomingRetryAfter: null });
  });
});
