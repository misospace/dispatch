import { describe, expect, it } from "vitest";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import { buildEvidenceCatalog, catalogIds, renderEvidenceCatalog, typedVerdictDependencyKeys } from "./plan-evidence";
import { MAX_BASELINE_DEPENDENCIES } from "./freshness";
import type { GroomingPlan } from "./plan";

const base: GroomingEvidenceSnapshot = {
  capturedAt: "2026-09-26T00:00:00.000Z",
  repoFullName: "org/repo",
  defaultBranch: "main",
  headSha: "abc123def4567890",
  pinnedRef: "abc123def4567890",
  issue: { number: 42, title: "t", body: null, labels: [], state: "open", updatedAt: "", url: "" },
  issueFingerprint: "fp",
  comments: [
    { id: "1", author: "alice", createdAt: "2026-09-25T00:00:00Z", body: "b", provenance: "human_comment", authoritative: true },
    { id: "2", author: "itsmiso-ai", createdAt: "", body: "b", provenance: "automation_comment", authoritative: false },
  ],
  evidenceDigest: "digest",
  warnings: [],
  sources: [
    { path: "src/a.ts", provenance: "repository", via: "read", ref: "abc123def4567890" },
    { path: "src/a.ts", provenance: "repository", via: "read", ref: "abc123def4567890" },
    { key: "github:issue:org/repo#7", provenance: "github_issue", state: "open", url: null, via: "search", observedAt: "", ref: null },
  ],
};

describe("buildEvidenceCatalog", () => {
  it("lists the issue, comments and sources with their provenance, in snapshot order", () => {
    const catalog = buildEvidenceCatalog(base);
    expect(catalog.entries.map((e) => [e.id, e.subject, e.provenance, e.authoritative, e.pinned, e.state])).toEqual([
      ["issue", "issue", "github_issue", true, false, null],
      ["comment:1", "comment", "human_comment", true, false, null],
      ["comment:2", "comment", "automation_comment", false, false, null],
      ["repo:src/a.ts", "repository", "repository", true, true, null],
      ["github:issue:org/repo#7", "related_work", "github_issue", true, false, "open"],
    ]);
    expect(catalog.binding).toMatchObject({ evidenceDigest: "digest", headSha: "abc123def4567890", issueFingerprint: "fp" });
  });

  it("marks repository sources unpinned when the snapshot has no head SHA", () => {
    const catalog = buildEvidenceCatalog({
      ...base,
      headSha: null,
      pinnedRef: null,
      sources: [{ path: "src/a.ts", provenance: "repository", via: "read", ref: null }],
    });
    expect(catalog.entries.find((e) => e.id === "repo:src/a.ts")?.pinned).toBe(false);
  });

  it("never pins a surfaced search hit, even with a head SHA", () => {
    const catalog = buildEvidenceCatalog({
      ...base,
      sources: [{ path: "src/hit.ts", provenance: "repository", via: "surfaced", ref: "abc123def4567890" }],
    });
    const entry = catalog.entries.find((e) => e.id === "repo:src/hit.ts");
    expect(entry?.pinned).toBe(false);
    expect(entry?.label).toContain("not read");
  });

  it("filters ids by subject", () => {
    const catalog = buildEvidenceCatalog(base);
    expect(catalogIds(catalog, "repository")).toEqual(["repo:src/a.ts"]);
    expect(catalogIds(catalog, "related_work")).toEqual(["github:issue:org/repo#7"]);
  });
});

describe("renderEvidenceCatalog", () => {
  it("lists every id and marks automation comments as context only", () => {
    const text = renderEvidenceCatalog(buildEvidenceCatalog(base));
    expect(text).toContain("## Evidence you can cite");
    expect(text).toContain("- comment:2 — comment by itsmiso-ai (automation: context only, never authority)");
    expect(text).toContain("- repo:src/a.ts — repository path at abc123def456");
    expect(text).toContain("pinned to abc123def456 on main");
  });

  it("tells the model the issue's expected files and acceptance criteria (dispatch#1099)", () => {
    const body = "## Expected files\n\n- `src/a.ts`\n\n## Acceptance criteria\n\n- [ ] a() returns 1.";
    const text = renderEvidenceCatalog(buildEvidenceCatalog({ ...base, issue: { ...base.issue, body } }));
    expect(text).toContain("This issue names expected files: src/a.ts.");
    expect(text).toContain("an already_done close must ground one by one:\n- a() returns 1.");
    expect(renderEvidenceCatalog(buildEvidenceCatalog(base))).not.toContain("expected files");
  });

  it("says when repository reads are unpinned", () => {
    const text = renderEvidenceCatalog(buildEvidenceCatalog({ ...base, headSha: null, pinnedRef: null }));
    expect(text).toContain("NOT pinned");
  });
});

describe("typedVerdictDependencyKeys", () => {
  const sources = [
    { path: "src/a.ts", provenance: "repository" as const, via: "read" as const, ref: "abc123def4567890" },
    { key: "github:issue:org/repo#7", provenance: "github_issue" as const, state: "open" as const, url: null, via: "read" as const, observedAt: "", ref: null },
    { key: "github:issue:org/repo#8", provenance: "github_issue" as const, state: "closed" as const, url: null, via: "read" as const, observedAt: "", ref: null },
    { key: "github:issue:org/repo#42", provenance: "github_issue" as const, state: "open" as const, url: null, via: "read" as const, observedAt: "", ref: null },
    { key: "github:pr:org/repo#12", provenance: "github_pull_request" as const, state: "open" as const, url: null, via: "read" as const, observedAt: "", ref: null },
  ];
  const catalog = buildEvidenceCatalog({ ...base, sources });
  type Dep = NonNullable<NonNullable<GroomingPlan["implementationBrief"]>["dependencies"]>[number];

  function planWith(dependencies: Dep[]): GroomingPlan {
    return { implementationBrief: { dependencies } } as unknown as GroomingPlan;
  }

  it("includes open and unknown states, excludes closed and merged", () => {
    const keys = typedVerdictDependencyKeys(
      planWith([
        { ref: "org/repo#7", state: "open", evidenceRef: "github:issue:org/repo#7" },
        { ref: "org/repo#7", state: "unknown", evidenceRef: "github:issue:org/repo#7" },
        { ref: "org/repo#8", state: "closed", evidenceRef: "github:issue:org/repo#7" },
        { ref: "org/repo#8", state: "merged", evidenceRef: "github:issue:org/repo#7" },
      ]),
      catalog,
    );
    expect(keys).toEqual(["org/repo#7"]);
  });

  it("skips a dependency with no evidenceRef (the evidence stays incomplete)", () => {
    const keys = typedVerdictDependencyKeys(
      planWith([{ ref: "other/repo#7", state: "open", evidenceRef: null }]),
      catalog,
    );
    expect(keys).toEqual([]);
  });

  it("skips non-related-work, repository and unknown evidence refs", () => {
    const keys = typedVerdictDependencyKeys(
      planWith([
        { ref: "a", state: "open", evidenceRef: "repo:src/a.ts" },
        { ref: "b", state: "open", evidenceRef: "issue" },
        { ref: "c", state: "open", evidenceRef: "comment:1" },
        { ref: "d", state: "open", evidenceRef: "github:issue:nowhere/else#1" },
      ]),
      catalog,
    );
    expect(keys).toEqual([]);
  });

  it("skips pull-request evidence refs", () => {
    const keys = typedVerdictDependencyKeys(
      planWith([{ ref: "org/repo#12", state: "open", evidenceRef: "github:pr:org/repo#12" }]),
      catalog,
    );
    expect(keys).toEqual([]);
  });

  it("dedupes, excludes the issue's own key and enforces the cap", () => {
    const manySources = [
      ...Array.from({ length: MAX_BASELINE_DEPENDENCIES + 5 }, (_, i) => ({
        key: `github:issue:org/repo#${i + 1}`,
        provenance: "github_issue" as const,
        state: "open" as const,
        url: null,
        via: "read" as const,
        observedAt: "",
        ref: null as null,
      })),
      // The groomed issue itself (#42), cited twice below.
      { key: "github:issue:org/repo#42", provenance: "github_issue" as const, state: "open" as const, url: null, via: "read" as const, observedAt: "", ref: null },
    ];
    const manyCatalog = buildEvidenceCatalog({ ...base, sources: manySources });
    const deps: Dep[] = manySources.map((source) => ({
      ref: source.key,
      state: "open" as const,
      evidenceRef: source.key,
    }));
    deps.push({ ref: "dup", state: "unknown", evidenceRef: "github:issue:org/repo#42" });

    const keys = typedVerdictDependencyKeys(planWith(deps), manyCatalog);
    expect(keys).not.toContain("org/repo#42");
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(MAX_BASELINE_DEPENDENCIES);
  });
});
