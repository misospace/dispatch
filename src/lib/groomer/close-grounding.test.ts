import { describe, expect, it } from "vitest";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import {
  asRepoFilePath,
  collectPinnedReadContent,
  evaluateCloseGrounding,
  normalizeCriterion,
  normalizeWhitespace,
  parseAcceptanceCriteria,
  parseExpectedFiles,
} from "./close-grounding";
import { buildEvidenceCatalog } from "./plan-evidence";

const HEAD = "abc123def4567890";

describe("parseExpectedFiles", () => {
  it("reads the backticked paths of an Expected files heading section (the #583 body)", () => {
    const body = [
      "## Context",
      "",
      "Relevant existing seams:",
      "- `pr_reviewer/platform.py`",
      "- `action.yml`",
      "",
      "## Expected files",
      "",
      "`pr_reviewer/platform.py`",
      "`scripts/platform_api.sh`",
      "`tests/test_platform.py`",
      "`tests/test_platform_api.sh`",
      "",
      "If a dedicated context module is warranted, add:",
      "`pr_reviewer/tangled_context.py`",
      "",
      "## Implementation notes",
      "",
      "- Accept explicit `PLATFORM=tangled` and keep `resolve_platform()` stable; see `docs/platforms.md`.",
    ].join("\n");
    expect(parseExpectedFiles(body)).toEqual([
      "pr_reviewer/platform.py",
      "scripts/platform_api.sh",
      "tests/test_platform.py",
      "tests/test_platform_api.sh",
      "pr_reviewer/tangled_context.py",
    ]);
  });

  it("reads a label-form section, inline or as a list, and stops at the next label or blank line", () => {
    expect(parseExpectedFiles("Expected files: `src/a.ts`, `src/b.ts`\n\nSee `src/c.ts` too.")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parseExpectedFiles("**Expected files:**\n- `src/a.ts` (modify)\n- src/b.test.ts — new\nTests:\n- `src/c.ts`")).toEqual([
      "src/a.ts",
      "src/b.test.ts",
    ]);
    expect(parseExpectedFiles("### Expected Files\n\n1. `./src/a.ts:12`\n2. `src/b.ts#L3-L9`")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("falls back to explicit backticked repository paths when there is no section", () => {
    const body = "The bug is in `src/lib/prisma.ts`; `DATABASE_URL` and `config.enabled` are fine, `resolve()` too. Also `Dockerfile` and `package.json`.";
    expect(parseExpectedFiles(body)).toEqual(["src/lib/prisma.ts", "Dockerfile", "package.json"]);
  });

  it("ignores things that are not repository file paths", () => {
    for (const token of [
      "owner/repo",
      "misospace/dispatch#1099",
      "https://example.com/a.ts",
      "/etc/passwd.conf",
      "../up.ts",
      "src/lib/",
      "src/lib/groomer",
      "mutations.close",
      "v1.2.3",
      "a b.ts",
      "text/plain",
    ]) {
      expect(asRepoFilePath(token), token).toBeNull();
    }
    expect(parseExpectedFiles(null)).toEqual([]);
    expect(parseExpectedFiles("No paths here at all.")).toEqual([]);
  });
});

describe("parseAcceptanceCriteria", () => {
  it("reads checkbox and bullet items of an Acceptance criteria section", () => {
    const body = [
      "## Acceptance criteria",
      "",
      "- [ ] `resolve_platform()` accepts explicit `tangled`.",
      "- [x] Existing GitHub auto-resolution behavior remains unchanged.",
      "* Shell and Python resolvers agree.",
      "1. No network calls are introduced.",
      "",
      "## Dependencies",
      "",
      "- none",
    ].join("\n");
    expect(parseAcceptanceCriteria(body)).toEqual([
      "`resolve_platform()` accepts explicit `tangled`.",
      "Existing GitHub auto-resolution behavior remains unchanged.",
      "Shell and Python resolvers agree.",
      "No network calls are introduced.",
    ]);
  });

  it("is empty when the issue states no enumerable criteria", () => {
    expect(parseAcceptanceCriteria("Login is broken.")).toEqual([]);
    expect(parseAcceptanceCriteria("## Acceptance criteria\n\nIt should just work.")).toEqual([]);
  });

  it("compares criteria ignoring case, emphasis, spacing and a trailing stop", () => {
    expect(normalizeCriterion("`resolve_platform()` accepts  explicit **tangled**.")).toBe(
      normalizeCriterion("resolve_platform() accepts explicit tangled"),
    );
    expect(normalizeCriterion("A test covers it")).not.toBe(normalizeCriterion("A test covers dry-run"));
  });
});

describe("collectPinnedReadContent", () => {
  it("keeps only reads at the pinned head, normalised, preferring the longest read of a path", () => {
    const store = collectPinnedReadContent(HEAD, [
      { path: "a.ts", ref: HEAD, content: "one\n  two" },
      { path: "a.ts", ref: HEAD, content: "one\n  two\nthree" },
      { path: "a.ts", ref: HEAD, content: "one" },
      { path: "b.ts", ref: "main", content: "default branch read" },
      { path: "c.ts", ref: null, content: "unpinned" },
    ]);
    expect([...store.files.entries()]).toEqual([["a.ts", "one two three"]]);
    expect(collectPinnedReadContent(null, [{ path: "a.ts", ref: null, content: "x" }]).files.size).toBe(0);
  });

  it("is bounded", () => {
    const reads = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.ts`, ref: HEAD, content: "x".repeat(40) }));
    expect(collectPinnedReadContent(HEAD, reads, 100).files.size).toBe(2);
  });

  it("normalises whitespace only", () => {
    expect(normalizeWhitespace("  a\n\t b  c ")).toBe("a b c");
  });
});

function snapshot(overrides: Partial<GroomingEvidenceSnapshot> = {}): GroomingEvidenceSnapshot {
  return {
    capturedAt: "2026-09-27T00:00:00.000Z",
    repoFullName: "org/repo",
    defaultBranch: "main",
    headSha: HEAD,
    pinnedRef: HEAD,
    issue: {
      number: 42,
      title: "Add dry-run",
      body: "## Expected files\n\n- `src/sync.ts`\n",
      labels: [],
      state: "open",
      updatedAt: "2026-09-26T00:00:00.000Z",
      url: "https://github.com/org/repo/issues/42",
    },
    issueFingerprint: "fp",
    comments: [],
    evidenceDigest: "digest",
    warnings: [],
    sources: [
      { path: "src/sync.ts", provenance: "repository", via: "read", ref: HEAD },
      {
        key: "github:pr:org/repo#50",
        provenance: "github_pull_request",
        state: "merged",
        url: null,
        via: "read",
        observedAt: "2026-09-27T00:00:01.000Z",
        ref: null,
        closes: ["org/repo#42"],
        baseRef: "main",
      },
      {
        key: "github:pr:org/repo#51",
        provenance: "github_pull_request",
        state: "open",
        url: null,
        via: "read",
        observedAt: "2026-09-27T00:00:01.000Z",
        ref: null,
        closes: ["org/repo#42"],
        baseRef: "main",
      },
      {
        key: "github:pr:org/repo#52",
        provenance: "github_pull_request",
        state: "merged",
        url: null,
        via: "search",
        observedAt: "2026-09-27T00:00:01.000Z",
        ref: null,
      },
    ],
    ...overrides,
  };
}

const SYNC = "if (opts.dryRun) {\n  printPlan(plan); // see #42\n  return; // unlike #41\n}";
const catalog = (overrides: Partial<GroomingEvidenceSnapshot> = {}) =>
  buildEvidenceCatalog(snapshot(overrides), collectPinnedReadContent(HEAD, [{ path: "src/sync.ts", ref: HEAD, content: SYNC }]));

describe("evaluateCloseGrounding", () => {
  const criterion = (excerpt: string, evidenceRef = "repo:src/sync.ts") => ({ criterion: "dry-run prints the plan", evidenceRef, excerpt });

  it("accepts a verbatim, whitespace-normalised excerpt of an expected file", () => {
    expect(evaluateCloseGrounding({ evidenceRefs: [], criteria: [criterion("if (opts.dryRun) { printPlan(plan);")] }, catalog())).toEqual({
      errors: [],
      closingPullRequest: null,
    });
  });

  it("rejects an excerpt that refers to another issue, but not one naming this issue", () => {
    expect(evaluateCloseGrounding({ evidenceRefs: [], criteria: [criterion("printPlan(plan); // see #42")] }, catalog()).errors).toEqual([]);
    expect(evaluateCloseGrounding({ evidenceRefs: [], criteria: [criterion("return; // unlike #41")] }, catalog()).errors[0]).toBe(
      "mutations.close.criteria[0].excerpt: refers to #41; evidence about other issues can corroborate but cannot ground this issue's criteria",
    );
  });

  it("treats a merged PR into the default branch that closes this issue as sufficient on its own", () => {
    expect(evaluateCloseGrounding({ evidenceRefs: ["github:pr:org/repo#50"], criteria: [] }, catalog())).toEqual({
      errors: [],
      closingPullRequest: "github:pr:org/repo#50",
    });
  });

  it("never treats an unmerged PR, a search hit, or a PR merged elsewhere as closing proof", () => {
    const errors = (refs: string[], overrides: Partial<GroomingEvidenceSnapshot> = {}) =>
      evaluateCloseGrounding({ evidenceRefs: refs, criteria: [] }, catalog(overrides)).errors.join("\n");
    expect(errors(["github:pr:org/repo#51"])).toContain("github:pr:org/repo#51 is open, not merged");
    expect(errors(["github:pr:org/repo#52"])).toContain("github:pr:org/repo#52 has no known closing references");
    expect(errors(["github:pr:org/repo#50"], { defaultBranch: "trunk" })).toContain("was merged into main, not the default branch");
  });

  it("still rejects a fabricated excerpt when a closing PR is cited", () => {
    const result = evaluateCloseGrounding(
      { evidenceRefs: ["github:pr:org/repo#50"], criteria: [criterion("opts.dryRun === true")] },
      catalog(),
    );
    expect(result.closingPullRequest).toBe("github:pr:org/repo#50");
    expect(result.errors).toEqual([expect.stringContaining("not found verbatim in src/sync.ts")]);
  });

  it("rejects reads that are not pinned and content that was not captured", () => {
    const unpinned = buildEvidenceCatalog(
      snapshot({ sources: [{ path: "src/sync.ts", provenance: "repository", via: "surfaced", ref: null }] }),
      collectPinnedReadContent(HEAD, [{ path: "src/sync.ts", ref: HEAD, content: SYNC }]),
    );
    expect(evaluateCloseGrounding({ evidenceRefs: [], criteria: [criterion("printPlan(plan);")] }, unpinned).errors[0]).toBe(
      "mutations.close.criteria[0].evidenceRef: src/sync.ts was not read at the pinned head SHA",
    );
    const otherHead = buildEvidenceCatalog(snapshot(), collectPinnedReadContent("f00", [{ path: "src/sync.ts", ref: "f00", content: SYNC }]));
    expect(evaluateCloseGrounding({ evidenceRefs: [], criteria: [criterion("printPlan(plan);")] }, otherHead).errors[0]).toBe(
      "mutations.close.criteria[0].evidenceRef: the content of src/sync.ts as read at the pinned head is not available to check the excerpt against",
    );
  });

  it("carries the issue's expected files and criteria on the catalog, and the PR's closing references on its entry", () => {
    const cat = catalog();
    expect(cat.grounding).toMatchObject({ issueKey: "org/repo#42", expectedFiles: ["src/sync.ts"], acceptanceCriteria: [] });
    const pr = cat.entries.find((e) => e.id === "github:pr:org/repo#50")!;
    expect(pr).toMatchObject({ closes: ["org/repo#42"], baseRef: "main" });
    expect(pr.label).toContain("closes org/repo#42");
  });
});
