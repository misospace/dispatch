import { describe, expect, it } from "vitest";
import {
  dependencyKey,
  formatDependencyBlockReason,
  normalizeRepoKey,
  parseIssueDependencies,
  resolveOpenBlockers,
} from "./issue-dependencies";

describe("normalizeRepoKey", () => {
  it("lowercases and trims", () => {
    expect(normalizeRepoKey(" Owner/Repo ")).toBe("owner/repo");
  });

  it("maps null, undefined, and empty to null", () => {
    expect(normalizeRepoKey(null)).toBeNull();
    expect(normalizeRepoKey(undefined)).toBeNull();
    expect(normalizeRepoKey("   ")).toBeNull();
  });
});

describe("dependencyKey", () => {
  it("renders bare #N for a null repo", () => {
    expect(dependencyKey(null, 5)).toBe("#5");
    expect(dependencyKey(undefined, 5)).toBe("#5");
  });

  it("renders owner/repo#N with a normalized repo", () => {
    expect(dependencyKey("Owner/Repo", 9)).toBe("owner/repo#9");
  });
});

describe("parseIssueDependencies", () => {
  it("returns [] for null or undefined bodies", () => {
    expect(parseIssueDependencies(null)).toEqual([]);
    expect(parseIssueDependencies(undefined)).toEqual([]);
  });

  it("returns [] when no trigger phrase is present", () => {
    expect(parseIssueDependencies("Fixes the crash in #5")).toEqual([]);
    expect(parseIssueDependencies("See #5 for details")).toEqual([]);
  });

  it("parses bare #N refs for each trigger phrasing", () => {
    const phrasings = [
      "Depends on #5",
      "depend on #5",
      "depended on #5",
      "dependency on #5",
      "depends upon #5",
      "Blocked by #5",
      "BLOCKED ON #5",
      "blocking issue #5",
      "Requires #5",
      "require #5",
      "Requirements: #5",
    ];
    for (const body of phrasings) {
      expect(parseIssueDependencies(body), body).toEqual([{ repo: null, number: 5 }]);
    }
  });

  it("does not treat 'required by' as a trigger", () => {
    expect(parseIssueDependencies("required by #5")).toEqual([]);
    expect(parseIssueDependencies("as required by the RFC in #5")).toEqual([]);
  });

  it("parses comma-separated refs", () => {
    expect(parseIssueDependencies("depends on #5, #6, #7")).toEqual([
      { repo: null, number: 5 },
      { repo: null, number: 6 },
      { repo: null, number: 7 },
    ]);
  });

  it("parses 'and'-separated refs", () => {
    expect(parseIssueDependencies("depends on #5 and #6")).toEqual([
      { repo: null, number: 5 },
      { repo: null, number: 6 },
    ]);
  });

  it("parses '&' and '+' separated refs", () => {
    expect(parseIssueDependencies("blocked by #5 & #6")).toEqual([
      { repo: null, number: 5 },
      { repo: null, number: 6 },
    ]);
    expect(parseIssueDependencies("requires #5+#6")).toEqual([
      { repo: null, number: 5 },
      { repo: null, number: 6 },
    ]);
  });

  it("parses '/' separated refs", () => {
    expect(parseIssueDependencies("depends on #5 / #6")).toEqual([
      { repo: null, number: 5 },
      { repo: null, number: 6 },
    ]);
  });

  it("parses cross-repo owner/repo#N refs", () => {
    expect(parseIssueDependencies("depends on other/repo#9")).toEqual([
      { repo: "other/repo", number: 9 },
    ]);
  });

  it("parses GitHub URL refs with the repo from the path", () => {
    expect(parseIssueDependencies("blocked by https://github.com/foo/bar/issues/12")).toEqual([
      { repo: "foo/bar", number: 12 },
    ]);
    expect(parseIssueDependencies("requires https://github.com/foo/bar/issues/1234")).toEqual([
      { repo: "foo/bar", number: 1234 },
    ]);
  });

  it("parses mixed ref forms in one list, in first-seen order", () => {
    expect(
      parseIssueDependencies(
        "depends on #5, other/repo#6, and https://github.com/x/y/issues/7",
      ),
    ).toEqual([
      { repo: null, number: 5 },
      { repo: "other/repo", number: 6 },
      { repo: "x/y", number: 7 },
    ]);
  });

  it("ignores refs with number <= 0", () => {
    expect(parseIssueDependencies("depends on #0 and #5")).toEqual([{ repo: null, number: 5 }]);
  });

  it("dedupes refs by dependencyKey in first-seen order", () => {
    expect(parseIssueDependencies("depends on #5 and #5")).toEqual([{ repo: null, number: 5 }]);
    expect(parseIssueDependencies("blocked by #5; depends on #5")).toEqual([
      { repo: null, number: 5 },
    ]);
  });

  it("keeps same-number refs from different repos distinct", () => {
    expect(parseIssueDependencies("depends on #5 and other/repo#5")).toEqual([
      { repo: null, number: 5 },
      { repo: "other/repo", number: 5 },
    ]);
  });

  it("handles multiple trigger phrases in one body", () => {
    expect(parseIssueDependencies("depends on #5; blocked by #6")).toEqual([
      { repo: null, number: 5 },
      { repo: null, number: 6 },
    ]);
  });

  it("stops the ref list at the first non-ref word", () => {
    expect(parseIssueDependencies("depends on the fix in #5")).toEqual([]);
    expect(parseIssueDependencies("depends on #5 because #6 is broken")).toEqual([
      { repo: null, number: 5 },
    ]);
  });

  it("never throws on arbitrary input", () => {
    expect(parseIssueDependencies("### depends on ###")).toEqual([]);
    expect(parseIssueDependencies("depends on")).toEqual([]);
    expect(parseIssueDependencies("#")).toEqual([]);
  });
});

describe("resolveOpenBlockers", () => {
  const open = new Set(["test/repo#5", "other/repo#9"]);

  it("keeps only refs whose key is in the open set", () => {
    const deps = [
      { repo: "test/repo", number: 5 },
      { repo: "test/repo", number: 6 },
      { repo: "other/repo", number: 9 },
    ];
    expect(resolveOpenBlockers(deps, open, "test/repo")).toEqual([
      { repo: "test/repo", number: 5 },
      { repo: "other/repo", number: 9 },
    ]);
  });

  it("applies the default repo to refs without one", () => {
    const deps = [
      { repo: null, number: 5 },
      { repo: null, number: 6 },
    ];
    expect(resolveOpenBlockers(deps, open, "test/repo")).toEqual([
      { repo: null, number: 5 },
    ]);
  });

  it("preserves input order", () => {
    const deps = [
      { repo: "other/repo", number: 9 },
      { repo: "test/repo", number: 5 },
    ];
    expect(resolveOpenBlockers(deps, open, "test/repo")).toEqual([
      { repo: "other/repo", number: 9 },
      { repo: "test/repo", number: 5 },
    ]);
  });

  it("excludes a self-referential ref when self is provided", () => {
    const deps = [
      { repo: null, number: 5 },
      { repo: "test/repo", number: 5 },
    ];
    expect(
      resolveOpenBlockers(deps, open, "test/repo", { repo: "test/repo", number: 5 }),
    ).toEqual([]);
  });

  it("compares self refs case-insensitively", () => {
    const deps = [{ repo: "Test/Repo", number: 5 }];
    expect(
      resolveOpenBlockers(deps, open, "Test/Repo", { repo: "TEST/REPO", number: 5 }),
    ).toEqual([]);
  });

  it("returns [] for an empty open set", () => {
    expect(resolveOpenBlockers([{ repo: null, number: 5 }], new Set<string>(), "test/repo")).toEqual(
      [],
    );
  });
});

describe("formatDependencyBlockReason", () => {
  it('returns "" when there are no blockers', () => {
    expect(formatDependencyBlockReason([])).toBe("");
  });

  it("renders bare #N for same-repo refs", () => {
    expect(formatDependencyBlockReason([{ repo: null, number: 5 }], "test/repo")).toBe(
      "Blocked by open #5",
    );
  });

  it("renders owner/repo#N when the ref repo differs from the default", () => {
    expect(
      formatDependencyBlockReason([{ repo: "other/repo", number: 9 }], "test/repo"),
    ).toBe("Blocked by open other/repo#9");
  });

  it("omits the repo prefix when the repos match after normalization", () => {
    expect(
      formatDependencyBlockReason([{ repo: "Test/Repo", number: 5 }], "test/repo"),
    ).toBe("Blocked by open #5");
  });

  it("joins multiple refs with commas", () => {
    expect(
      formatDependencyBlockReason(
        [
          { repo: null, number: 5 },
          { repo: "other/repo", number: 9 },
        ],
        "test/repo",
      ),
    ).toBe("Blocked by open #5, other/repo#9");
  });
});
