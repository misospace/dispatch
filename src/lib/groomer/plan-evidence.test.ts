import { describe, expect, it } from "vitest";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import { buildEvidenceCatalog, catalogIds, renderEvidenceCatalog } from "./plan-evidence";

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
    { path: "src/a.ts", provenance: "repository", ref: "abc123def4567890" },
    { path: "src/a.ts", provenance: "repository", ref: "abc123def4567890" },
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
      sources: [{ path: "src/a.ts", provenance: "repository", ref: null }],
    });
    expect(catalog.entries.find((e) => e.id === "repo:src/a.ts")?.pinned).toBe(false);
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

  it("says when repository reads are unpinned", () => {
    const text = renderEvidenceCatalog(buildEvidenceCatalog({ ...base, headSha: null, pinnedRef: null }));
    expect(text).toContain("NOT pinned");
  });
});
