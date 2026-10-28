import { describe, expect, it, vi } from "vitest";
import { RelatedWorkNotFoundError } from "@/lib/github-related-work";
import {
  buildGroomerToolDefinitions,
  executeGroomerTool,
  normalizeRepoPath,
  MAX_READ_LINES,
  type GroomerToolDeps,
} from "./tools";

const options = {
  repoFullName: "org/repo",
  maxSearchResults: 10,
  maxFileBytes: 4096,
  maxDirEntries: 60,
};

function makeDeps(overrides: Partial<GroomerToolDeps> = {}): GroomerToolDeps {
  return {
    searchCode: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(""),
    listDir: vi.fn().mockResolvedValue([]),
    fetchRelatedIssue: vi.fn().mockResolvedValue({}),
    fetchRelatedPullRequest: vi.fn().mockResolvedValue({}),
    fetchRelatedCommit: vi.fn().mockResolvedValue({}),
    searchRelatedWork: vi.fn().mockResolvedValue([]),
    fetchPullRequestClosingIssues: vi.fn().mockResolvedValue({ issues: [], truncated: false }),
    ...overrides,
  };
}

function notFound(
  kind: "issue" | "pull_request" | "commit",
  ref: string,
): RelatedWorkNotFoundError {
  return new RelatedWorkNotFoundError(kind, ref);
}

describe("buildGroomerToolDefinitions", () => {
  it("exposes search, read, list, related-work and submit", () => {
    const names = buildGroomerToolDefinitions().map(
      (t) => (t.function as { name: string }).name,
    );
    expect(names).toEqual([
      "search_code",
      "read_file",
      "list_directory",
      "search_related_work",
      "read_related_issue",
      "read_related_pr",
      "read_related_commit",
      "submit_findings",
    ]);
  });

  it("does not let the model set maxResults on search_related_work", () => {
    const def = buildGroomerToolDefinitions().find(
      (t) => (t.function as { name: string }).name === "search_related_work",
    ) as { function: { parameters: { properties: Record<string, unknown> } } };
    expect(def.function.parameters.properties).not.toHaveProperty("maxResults");
    expect(def.function.parameters.properties).toHaveProperty("query");
    expect(def.function.parameters.properties).toHaveProperty("type");
    expect(def.function.parameters.properties).toHaveProperty("state");
  });
});

describe("executeGroomerTool", () => {
  it("returns matching paths for search_code", async () => {
    const deps = makeDeps({
      searchCode: vi.fn().mockResolvedValue([{ path: "src/lib/prisma.ts" }, { path: "docs/db.md" }]),
    });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "PrismaPg" } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/lib/prisma.ts");
    expect(result.sources).toEqual(["src/lib/prisma.ts", "docs/db.md"]);
  });

  it("tells the model that an empty search may mean the thing is missing", async () => {
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "sslmode" } },
      options,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("may be the thing the issue says is missing");
    expect(result.bytes).toBe(0);
  });

  it("reads a file and reports it as a source", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("const adapter = new PrismaPg(url);") });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "src/lib/prisma.ts" } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("PrismaPg");
    expect(result.sources).toEqual(["src/lib/prisma.ts"]);
  });

  it("truncates a file past the byte budget", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("x".repeat(500)) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "big.ts" } },
      { ...options, maxFileBytes: 100 },
      deps,
    );
    expect(result.content).toContain("(truncated)");
    expect(result.content.length).toBeLessThan(400);
  });

  it("lists a directory and marks subdirectories", async () => {
    const deps = makeDeps({
      listDir: vi.fn().mockResolvedValue([
        { path: "src/lib", type: "dir", size: null },
        { path: "src/index.ts", type: "file", size: 12 },
      ]),
    });
    const result = await executeGroomerTool(
      { name: "list_directory", arguments: { path: "src" } },
      options,
      deps,
    );
    expect(result.content).toContain("- src/lib/");
    expect(result.content).toContain("- src/index.ts");
  });

  it("caps the number of directory entries shown", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      path: `src/f${i}.ts`,
      type: "file" as const,
      size: 1,
    }));
    const result = await executeGroomerTool(
      { name: "list_directory", arguments: { path: "src" } },
      { ...options, maxDirEntries: 3 },
      makeDeps({ listDir: vi.fn().mockResolvedValue(entries) }),
    );
    expect(result.content).toContain("… 7 more");
  });

  it("reports a failed call instead of throwing, so grooming survives it", async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockRejectedValue(new Error("404 Not Found")),
    });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "nope.ts" } },
      options,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("404 Not Found");
  });

  it("rejects an unknown tool by name without throwing", async () => {
    const result = await executeGroomerTool(
      { name: "write_file", arguments: { path: "x" } },
      options,
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('Unknown tool "write_file"');
  });

  it("rejects empty arguments", async () => {
    const search = await executeGroomerTool(
      { name: "search_code", arguments: { query: "  " } },
      options,
      makeDeps(),
    );
    expect(search.ok).toBe(false);
    const read = await executeGroomerTool(
      { name: "read_file", arguments: {} },
      options,
      makeDeps(),
    );
    expect(read.ok).toBe(false);
  });
});

describe("executeGroomerTool related-work", () => {
  it("search_related_work returns bounded hits and records the query", async () => {
    const hits = [
      {
        kind: "issue",
        state: "closed",
        htmlUrl: "https://github.com/org/repo/issues/101",
        evidenceKey: "github:issue:org/repo#101",
        title: "Original sslmode report",
      },
      {
        kind: "pull_request",
        state: "merged",
        htmlUrl: "https://github.com/org/repo/pull/102",
        evidenceKey: "github:pr:org/repo#102",
        title: "Attempted fix",
      },
    ];
    const deps = makeDeps({ searchRelatedWork: vi.fn().mockResolvedValue(hits) });
    const result = await executeGroomerTool(
      { name: "search_related_work", arguments: { query: "sslmode" } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toEqual(hits);
    // Related work is GitHub state, not repository paths: it never enters
    // `sources` (which the snapshot pins to the head SHA).
    expect(result.sources).toEqual([]);
    expect(result.relatedWork).toEqual([
      {
        key: "github:issue:org/repo#101",
        kind: "issue",
        state: "closed",
        url: "https://github.com/org/repo/issues/101",
        via: "search",
        observedAt: expect.any(String),
      },
      {
        key: "github:pr:org/repo#102",
        kind: "pull_request",
        state: "merged",
        url: "https://github.com/org/repo/pull/102",
        via: "search",
        observedAt: expect.any(String),
      },
    ]);
    expect(result.bytes).toBe(Buffer.byteLength(result.content, "utf8"));
    expect(deps.searchRelatedWork).toHaveBeenCalledWith("org/repo", "sslmode", {
      type: "all",
      state: "all",
      maxResults: 10,
    });
  });

  it("passes type and state through to the search adapter", async () => {
    const deps = makeDeps({ searchRelatedWork: vi.fn().mockResolvedValue([]) });
    await executeGroomerTool(
      { name: "search_related_work", arguments: { query: "sslmode", type: "pr", state: "open" } },
      options,
      deps,
    );
    expect(deps.searchRelatedWork).toHaveBeenCalledWith("org/repo", "sslmode", {
      type: "pr",
      state: "open",
      maxResults: 10,
    });
  });

  it("caps search_related_work at the configured maxResults", async () => {
    const deps = makeDeps({ searchRelatedWork: vi.fn().mockResolvedValue([]) });
    await executeGroomerTool(
      { name: "search_related_work", arguments: { query: "sslmode" } },
      { ...options, maxSearchResults: 5 },
      deps,
    );
    expect(deps.searchRelatedWork).toHaveBeenCalledWith(
      "org/repo",
      "sslmode",
      expect.objectContaining({ maxResults: 5 }),
    );
  });

  it("read_related_issue returns the issue's structured state", async () => {
    const deps = makeDeps({
      fetchRelatedIssue: vi
        .fn()
        .mockResolvedValue({
          kind: "issue",
          number: 7,
          title: "Dependency",
          state: "closed",
          htmlUrl: "https://github.com/org/repo/issues/7",
          evidenceKey: "github:issue:org/repo#7",
        }),
    });
    const result = await executeGroomerTool(
      { name: "read_related_issue", arguments: { number: 7 } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ number: 7, state: "closed" });
    expect(result.sources).toEqual([]);
    expect(result.relatedWork).toEqual([
      {
        key: "github:issue:org/repo#7",
        kind: "issue",
        state: "closed",
        url: "https://github.com/org/repo/issues/7",
        via: "read",
        observedAt: expect.any(String),
      },
    ]);
    expect(deps.fetchRelatedIssue).toHaveBeenCalledWith("org/repo", 7);
  });

  it("read_related_pr reports a merged PR as merged", async () => {
    const deps = makeDeps({
      fetchRelatedPullRequest: vi
        .fn()
        .mockResolvedValue({
          kind: "pull_request",
          number: 42,
          title: "Fix",
          state: "merged",
          htmlUrl: "https://github.com/org/repo/pull/42",
          evidenceKey: "github:pr:org/repo#42",
        }),
    });
    const result = await executeGroomerTool(
      { name: "read_related_pr", arguments: { number: 42 } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ number: 42, state: "merged" });
    expect(result.sources).toEqual([]);
    expect(result.relatedWork).toEqual([
      expect.objectContaining({ key: "github:pr:org/repo#42", kind: "pull_request", state: "merged", via: "read" }),
    ]);
  });

  it("read_related_pr reports an open PR as open", async () => {
    const deps = makeDeps({
      fetchRelatedPullRequest: vi
        .fn()
        .mockResolvedValue({
          kind: "pull_request",
          number: 43,
          title: "WIP",
          state: "open",
          evidenceKey: "github:pr:org/repo#43",
        }),
    });
    const result = await executeGroomerTool(
      { name: "read_related_pr", arguments: { number: 43 } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ state: "open" });
  });

  it("read_related_commit returns the commit evidence", async () => {
    const deps = makeDeps({
      fetchRelatedCommit: vi
        .fn()
        .mockResolvedValue({
          kind: "commit",
          sha: "abc123",
          message: "Fix the login bug",
          htmlUrl: "https://github.com/org/repo/commit/abc123",
          evidenceKey: "github:commit:org/repo@abc123",
        }),
    });
    const result = await executeGroomerTool(
      { name: "read_related_commit", arguments: { ref: "abc123" } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ sha: "abc123", message: "Fix the login bug" });
    expect(result.sources).toEqual([]);
    expect(result.relatedWork).toEqual([
      expect.objectContaining({ key: "github:commit:org/repo@abc123", kind: "commit", state: null, via: "read" }),
    ]);
    expect(deps.fetchRelatedCommit).toHaveBeenCalledWith("org/repo", "abc123");
  });

  it("records a PR number read via read_related_issue as pull_request evidence", async () => {
    const deps = makeDeps({
      fetchRelatedIssue: vi.fn().mockResolvedValue({
        kind: "pull_request",
        number: 12,
        state: "merged",
        merged: true,
        evidenceKey: "github:pr:org/repo#12",
      }),
    });
    const result = await executeGroomerTool(
      { name: "read_related_issue", arguments: { number: 12 } },
      options,
      deps,
    );
    expect(result.relatedWork).toEqual([
      expect.objectContaining({ key: "github:pr:org/repo#12", kind: "pull_request", state: "merged" }),
    ]);
  });

  it("rejects an unbounded or malformed commit ref without calling GitHub", async () => {
    const deps = makeDeps();
    for (const ref of ["a".repeat(101), "abc\u0000def", "abc def", "../../etc", "main..HEAD", "-rf"]) {
      const result = await executeGroomerTool(
        { name: "read_related_commit", arguments: { ref } },
        options,
        deps,
      );
      expect(result.ok, ref).toBe(false);
    }
    expect(deps.fetchRelatedCommit).not.toHaveBeenCalled();
  });

  it("degrades a not-found related-work ref to a warning, not a crash", async () => {
    const deps = makeDeps({
      fetchRelatedIssue: vi.fn().mockRejectedValue(notFound("issue", "org/repo#99")),
    });
    const result = await executeGroomerTool(
      { name: "read_related_issue", arguments: { number: 99 } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      found: false,
      kind: "issue",
      ref: "org/repo#99",
    });
    expect(result.warnings).toEqual(["related-work: not found issue org/repo#99"]);
    expect(result.sources).toEqual([]);
  });

  it("degrades a not-found PR to a warning, not a crash", async () => {
    const deps = makeDeps({
      fetchRelatedPullRequest: vi.fn().mockRejectedValue(notFound("pull_request", "org/repo#88")),
    });
    const result = await executeGroomerTool(
      { name: "read_related_pr", arguments: { number: 88 } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      found: false,
      kind: "pull_request",
      ref: "org/repo#88",
    });
    expect(result.warnings).toEqual(["related-work: not found pull_request org/repo#88"]);
  });

  it("degrades a thrown generic error to a warning plus an empty result", async () => {
    const deps = makeDeps({
      fetchRelatedPullRequest: vi
        .fn()
        .mockRejectedValue(new Error("GitHub API error for org/repo#42: 500 SENTINEL_UPSTREAM_BODY")),
    });
    const result = await executeGroomerTool(
      { name: "read_related_pr", arguments: { number: 42 } },
      options,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ error: true });
    expect(result.warnings).toEqual(["related-work: pull_request lookup failed"]);
    expect(result.sources).toEqual([]);
    expect(result.relatedWork).toBeUndefined();
    // The upstream error text never reaches the model or the persisted warnings.
    expect(result.content.includes("SENTINEL")).toBe(false);
    expect(result.warnings!.join(" ").includes("SENTINEL")).toBe(false);
  });

  it("degrades a thrown search error without throwing", async () => {
    const deps = makeDeps({
      searchRelatedWork: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "GitHub API error: 502 SENTINEL_UPSTREAM_BODY_HTML <html>...</html>",
          ),
        ),
    });
    const result = await executeGroomerTool(
      { name: "search_related_work", arguments: { query: "sslmode" } },
      options,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("search_related_work failed");
    expect(result.content.includes("SENTINEL_UPSTREAM_BODY_HTML")).toBe(false);
    expect(result.content.includes("SENTINEL")).toBe(false);
  });
});

describe("normalizeRepoPath", () => {
  it("accepts an ordinary repo path", () => {
    expect(normalizeRepoPath("src/lib/prisma.ts")).toEqual({ path: "src/lib/prisma.ts" });
  });

  it("strips redundant . segments and trailing slashes", () => {
    expect(normalizeRepoPath("./src//lib/")).toEqual({ path: "src/lib" });
  });

  it("allows the empty path, which means the repository root", () => {
    expect(normalizeRepoPath("")).toEqual({ path: "" });
  });

  it("rejects .. segments", () => {
    expect(normalizeRepoPath("../package.json")).toEqual({
      error: expect.stringContaining('contains ".."'),
    });
    expect(normalizeRepoPath("src/../../etc/passwd")).toEqual({
      error: expect.stringContaining('contains ".."'),
    });
    expect(normalizeRepoPath("src/lib/prisma.ts/..")).toEqual({
      error: expect.stringContaining('contains ".."'),
    });
  });

  it("rejects absolute paths", () => {
    expect(normalizeRepoPath("/etc/passwd")).toEqual({
      error: expect.stringContaining("is absolute"),
    });
  });

  it("rejects null bytes and control characters", () => {
    expect(normalizeRepoPath(`src/lib/prisma.ts${String.fromCharCode(0)}.png`)).toEqual({
      error: expect.stringContaining("control characters"),
    });
    expect(normalizeRepoPath(`src/lib${String.fromCharCode(10)}/etc/passwd`)).toEqual({
      error: expect.stringContaining("control characters"),
    });
    expect(normalizeRepoPath(`src${String.fromCharCode(13)}lib`)).toEqual({
      error: expect.stringContaining("control characters"),
    });
  });
});

describe("executeGroomerTool path handling", () => {
  it("refuses a traversing read_file without calling GitHub", async () => {
    const deps = makeDeps();
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "../package.json" } },
      options,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it("refuses an absolute list_directory without calling GitHub", async () => {
    const deps = makeDeps();
    const result = await executeGroomerTool(
      { name: "list_directory", arguments: { path: "/etc" } },
      options,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(deps.listDir).not.toHaveBeenCalled();
  });

  it("refuses a null byte in a path without calling GitHub", async () => {
    const deps = makeDeps();
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: `src/a.ts${String.fromCharCode(0)}` } },
      options,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it("passes the normalized path through to the fetcher", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") });
    await executeGroomerTool(
      { name: "read_file", arguments: { path: "./src/lib/prisma.ts" } },
      options,
      deps,
    );
    expect(deps.readFile).toHaveBeenCalledWith("org/repo", "src/lib/prisma.ts", undefined);
  });

  it("passes the optional ref through to read_file so the groomer can verify against the base branch (dispatch#957)", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") });
    await executeGroomerTool(
      { name: "read_file", arguments: { path: "src/lib/prisma.ts", ref: "main" } },
      options,
      deps,
    );
    expect(deps.readFile).toHaveBeenCalledWith("org/repo", "src/lib/prisma.ts", "main");
  });

  it("passes the optional ref through to list_directory", async () => {
    const deps = makeDeps({ listDir: vi.fn().mockResolvedValue([]) });
    await executeGroomerTool(
      { name: "list_directory", arguments: { path: "src", ref: "main" } },
      options,
      deps,
    );
    expect(deps.listDir).toHaveBeenCalledWith("org/repo", "src", "main");
  });

  it("exposes a ref parameter on the read_file tool definition so models can call it", () => {
    const def = buildGroomerToolDefinitions().find(
      (t) => (t.function as { name: string }).name === "read_file",
    ) as { function: { parameters: { properties: Record<string, unknown> } } };
    expect(def.function.parameters.properties).toHaveProperty("ref");
  });

  it("does not leave a replacement character before the truncation marker", async () => {
    // "…" is three UTF-8 bytes; the cut lands inside it, so the decoded
    // prefix ends in an incomplete character. The path prefix and the
    // continuation marker are charged to the same budget as the content, so
    // the cut lands at byte 38 of this file.
    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(`${"y".repeat(37)}…${"z".repeat(60)}`),
    });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "a.ts" } },
      { ...options, maxFileBytes: 100 },
      deps,
    );
    expect(result.content).not.toContain("�");
    expect(result.file?.content).toBe("y".repeat(37));
    expect(result.content).toContain("(truncated)");
  });
});

describe("executeGroomerTool pinned ref", () => {
  it("forces read_file to the pinned ref, ignoring a conflicting model-supplied ref", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "src/lib/prisma.ts", ref: "main" } },
      { ...options, pinnedRef: "deadbeef" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.readFile).toHaveBeenCalledWith("org/repo", "src/lib/prisma.ts", "deadbeef");
  });

  it("forces read_file to the pinned ref when the model supplies none", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") });
    await executeGroomerTool(
      { name: "read_file", arguments: { path: "src/lib/prisma.ts" } },
      { ...options, pinnedRef: "deadbeef" },
      deps,
    );
    expect(deps.readFile).toHaveBeenCalledWith("org/repo", "src/lib/prisma.ts", "deadbeef");
  });

  it("keeps the model's ref when no pinned ref is set", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") });
    await executeGroomerTool(
      { name: "read_file", arguments: { path: "src/lib/prisma.ts", ref: "topic" } },
      options,
      deps,
    );
    expect(deps.readFile).toHaveBeenCalledWith("org/repo", "src/lib/prisma.ts", "topic");
  });

  it("passes no ref when neither a pinned ref nor a model ref is set", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") });
    await executeGroomerTool(
      { name: "read_file", arguments: { path: "src/lib/prisma.ts" } },
      options,
      deps,
    );
    expect(deps.readFile).toHaveBeenCalledWith("org/repo", "src/lib/prisma.ts", undefined);
  });

  it("forces list_directory to the pinned ref, ignoring a conflicting model-supplied ref", async () => {
    const deps = makeDeps({ listDir: vi.fn().mockResolvedValue([]) });
    await executeGroomerTool(
      { name: "list_directory", arguments: { path: "src", ref: "refs/heads/other" } },
      { ...options, pinnedRef: "deadbeef" },
      deps,
    );
    expect(deps.listDir).toHaveBeenCalledWith("org/repo", "src", "deadbeef");
  });

  it("forces list_directory to the pinned ref when the model supplies none", async () => {
    const deps = makeDeps({ listDir: vi.fn().mockResolvedValue([]) });
    await executeGroomerTool(
      { name: "list_directory", arguments: { path: "src" } },
      { ...options, pinnedRef: "deadbeef" },
      deps,
    );
    expect(deps.listDir).toHaveBeenCalledWith("org/repo", "src", "deadbeef");
  });
});

describe("close-grounding evidence (dispatch#1099)", () => {
  const mergedPr = {
    kind: "pull_request",
    number: 590,
    title: "Tangled sessions",
    state: "merged",
    baseRef: "main",
    htmlUrl: "https://github.com/org/repo/pull/590",
    evidenceKey: "github:pr:org/repo#590",
  };

  it("read_file hands back exactly what the model saw and the ref it was read at", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("x".repeat(500)) });
    const pinned = await executeGroomerTool(
      { name: "read_file", arguments: { path: "src/a.ts", ref: "main" } },
      { ...options, maxFileBytes: 100, pinnedRef: "deadbeef" },
      deps,
    );
    // The evidence is exactly the file content the model was shown: the path
    // prefix and the continuation marker are rendering, not content. The
    // whole answer — prefix, content and marker — stays inside the budget
    // the caller allowed.
    const shown = pinned.file?.content ?? "";
    expect(shown).toMatch(/^x+$/);
    expect(pinned.content).toContain(shown);
    expect(pinned.file).toMatchObject({ path: "src/a.ts", ref: "deadbeef" });
    expect(pinned.bytes).toBeLessThanOrEqual(100);
    const unpinned = await executeGroomerTool({ name: "read_file", arguments: { path: "src/a.ts" } }, options, deps);
    expect(unpinned.file).toMatchObject({ path: "src/a.ts", ref: null });
  });

  it("adds GitHub's closing references and base branch to a merged PR read", async () => {
    const deps = makeDeps({
      fetchRelatedPullRequest: vi.fn().mockResolvedValue(mergedPr),
      fetchPullRequestClosingIssues: vi.fn().mockResolvedValue({ issues: ["org/repo#587"], truncated: false }),
    });
    const result = await executeGroomerTool({ name: "read_related_pr", arguments: { number: 590 } }, options, deps);
    expect(deps.fetchPullRequestClosingIssues).toHaveBeenCalledWith("org/repo", 590, { maxResults: 10 });
    expect(JSON.parse(result.content)).toMatchObject({ closingIssues: ["org/repo#587"], closingIssuesTruncated: false });
    expect(result.relatedWork).toEqual([expect.objectContaining({ key: "github:pr:org/repo#590", closes: ["org/repo#587"], baseRef: "main" })]);
  });

  it("does the same for a PR number read through read_related_issue", async () => {
    const deps = makeDeps({
      fetchRelatedIssue: vi.fn().mockResolvedValue(mergedPr),
      fetchPullRequestClosingIssues: vi.fn().mockResolvedValue({ issues: ["org/repo#583"], truncated: false }),
    });
    const result = await executeGroomerTool({ name: "read_related_issue", arguments: { number: 590 } }, options, deps);
    expect(result.relatedWork).toEqual([expect.objectContaining({ kind: "pull_request", closes: ["org/repo#583"] })]);
  });

  it("costs no extra call for an unmerged PR", async () => {
    const deps = makeDeps({ fetchRelatedPullRequest: vi.fn().mockResolvedValue({ ...mergedPr, state: "open" }) });
    const result = await executeGroomerTool({ name: "read_related_pr", arguments: { number: 590 } }, options, deps);
    expect(deps.fetchPullRequestClosingIssues).not.toHaveBeenCalled();
    expect(result.relatedWork?.[0]).not.toHaveProperty("closes");
  });

  it("leaves closing references unknown, not empty, when the lookup fails", async () => {
    const deps = makeDeps({
      fetchRelatedPullRequest: vi.fn().mockResolvedValue(mergedPr),
      fetchPullRequestClosingIssues: vi.fn().mockRejectedValue(new Error("GraphQL 502")),
    });
    const result = await executeGroomerTool({ name: "read_related_pr", arguments: { number: 590 } }, options, deps);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["related-work: closing references lookup failed for org/repo#590"]);
    expect(result.relatedWork?.[0]).not.toHaveProperty("closes");
    expect(result.relatedWork?.[0]).toMatchObject({ state: "merged", baseRef: "main" });
  });
});

describe("executeGroomerTool read_file bounded ranges (dispatch#1451)", () => {
  function longFile(lines: number, prefix = "line"): string {
    return Array.from({ length: lines }, (_, i) => `${prefix} ${i + 1}`).join("\n");
  }

  it("exposes startLine and lineCount on the read_file tool definition", () => {
    const def = buildGroomerToolDefinitions().find(
      (t) => (t.function as { name: string }).name === "read_file",
    ) as { function: { parameters: { properties: Record<string, unknown> } } };
    expect(def.function.parameters.properties).toHaveProperty("startLine");
    expect(def.function.parameters.properties).toHaveProperty("lineCount");
    expect(def.function.parameters.properties).not.toHaveProperty("maxBytes");
  });

  it("reads the tail of a long file a head read could never reach", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(120)) });
    const head = await executeGroomerTool(
      { name: "read_file", arguments: { path: "big.ts" } },
      { ...options, maxFileBytes: 120 },
      deps,
    );
    expect(head.content).toContain("(truncated");
    expect(head.content).not.toContain("line 120");
    const tail = await executeGroomerTool(
      { name: "read_file", arguments: { path: "big.ts", startLine: 115 } },
      { ...options, maxFileBytes: 200 },
      deps,
    );
    expect(tail.ok).toBe(true);
    expect(tail.content).toContain("line 120");
    expect(tail.content).toContain("(lines 115-120 of 120)");
    expect(tail.content).toContain("end of file");
    expect(tail.file).toEqual({
      path: "big.ts",
      ref: null,
      content: longFile(120).split("\n").slice(114).join("\n"),
    });
  });

  it("names the continuation line when a range is cut by the byte budget", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(50, "x")) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "many.ts", startLine: 10, lineCount: 40 } },
      { ...options, maxFileBytes: 120 },
      deps,
    );
    // The coordinates header and the continuation footer are charged to the
    // same budget as the content, so the answer stays inside what the caller
    // allowed: "x 10".."x 18" cost 4 + 8*5 = 44 of the 120 bytes.
    expect(result.content).toContain("(lines 10-18 of 50)");
    expect(result.content).toContain("continues at line 19 (pass startLine=19)");
    expect(result.file?.content).toBe(
      ["x 10", "x 11", "x 12", "x 13", "x 14", "x 15", "x 16", "x 17", "x 18"].join("\n"),
    );
    expect(result.bytes).toBeLessThanOrEqual(120);
  });

  it("rejects invalid line ranges without fetching", async () => {
    for (const args of [
      { path: "a.ts", startLine: 0 },
      { path: "a.ts", startLine: -3 },
      { path: "a.ts", startLine: 1.5 },
      { path: "a.ts", startLine: "ten" },
      { path: "a.ts", lineCount: 0 },
      { path: "a.ts", lineCount: "many" },
    ]) {
      const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("x") });
      const result = await executeGroomerTool({ name: "read_file", arguments: args }, options, deps);
      expect(result.ok).toBe(false);
      expect(deps.readFile).not.toHaveBeenCalled();
    }
  });

  it("clamps an oversized lineCount to the per-call line cap", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(20, "s")) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "s.ts", startLine: 1, lineCount: 100000 } },
      { ...options, maxFileBytes: 4096 },
      deps,
    );
    expect(result.content).toContain(`line count capped at ${MAX_READ_LINES}`);
    expect(result.content).toContain("(lines 1-20 of 20,");
  });

  it("keeps whole UTF-8 characters inside a range cut by the byte budget", async () => {
    const text = "héllo wörld ünïcode\n".repeat(20);
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(text) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "u.ts", startLine: 2, lineCount: 20 } },
      { ...options, maxFileBytes: 120 },
      deps,
    );
    expect(result.content).not.toContain("�");
    expect(result.file?.content).toContain("héllo");
    // The whole answer — header, content and footer — stays inside the budget.
    expect(result.bytes).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(result.file?.content ?? "", "utf8")).toBeLessThanOrEqual(120);
  });

  it("cuts a single oversized line on a character boundary", async () => {
    // One line of two-byte characters: the byte budget cuts it mid-line, and
    // the cut must land on a character boundary.
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(`${"ü".repeat(200)}\nafter`) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "u.ts", startLine: 1, lineCount: 2 } },
      { ...options, maxFileBytes: 121 },
      deps,
    );
    expect(result.content).not.toContain("�");
    expect(result.content).toContain("(line 1 exceeds the byte limit; continues at line 2)");
    expect(result.file?.content).toMatch(/^ü+$/);
    expect(result.bytes).toBeLessThanOrEqual(121);
  });

  it("charges range output against the byte budget the caller passes", async () => {
    // The caller passes the budget it allows; a ranged read charged at that
    // cap cannot exceed it, framing included (dispatch#1451).
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(300, "longish line here")) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "b.ts", startLine: 200, lineCount: 100 } },
      { ...options, maxFileBytes: 120 },
      deps,
    );
    expect(result.content).toContain("(lines 200-");
    expect(Buffer.byteLength(result.file?.content ?? "", "utf8")).toBeLessThanOrEqual(120);
    expect(result.bytes).toBeLessThanOrEqual(120);
    expect(result.bytes).toBe(Buffer.byteLength(result.content, "utf8"));
  });

  it("rejects non-numeric range argument types instead of reading unbounded", async () => {
    for (const bad of [true, {}, [], 1e400]) {
      const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(5)) });
      const result = await executeGroomerTool(
        { name: "read_file", arguments: { path: "a.ts", startLine: bad } },
        options,
        deps,
      );
      expect(result.ok).toBe(false);
      expect(deps.readFile).not.toHaveBeenCalled();
    }
  });

  it("counts a trailing newline as a terminator, not an empty final line", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(`${longFile(5)}\n`) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "t.ts", startLine: 4 } },
      options,
      deps,
    );
    expect(result.content).toContain("(lines 4-5 of 5)");
    expect(result.content).toContain("end of file");
  });

  it("answers a startLine past the end without claiming file content", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(3)) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "tiny.ts", startLine: 9 } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("past the end of the file (3 line(s))");
    expect(result.file).toBeUndefined();
    expect(result.sources).toEqual([]);
  });

  it("keeps the pinned-revision evidence identity for ranged reads", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(10)) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "p.ts", startLine: 8, ref: "feature" } },
      { ...options, pinnedRef: "deadbeef" },
      deps,
    );
    expect(deps.readFile).toHaveBeenCalledWith("org/repo", "p.ts", "deadbeef");
    expect(result.file).toMatchObject({ path: "p.ts", ref: "deadbeef" });
  });

  it("truncates a single line larger than the budget and continues past it", async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(`small\n${"y".repeat(500)}\nafter`),
    });
    const first = await executeGroomerTool(
      { name: "read_file", arguments: { path: "huge.ts", startLine: 2 } },
      { ...options, maxFileBytes: 150 },
      deps,
    );
    expect(first.ok).toBe(true);
    expect(first.content).toContain("continues at line 3");
    expect(Buffer.byteLength(first.file?.content ?? "", "utf8")).toBeLessThanOrEqual(150);
    expect(first.bytes).toBeLessThanOrEqual(150);
    const next = await executeGroomerTool(
      { name: "read_file", arguments: { path: "huge.ts", startLine: 3 } },
      { ...options, maxFileBytes: 150 },
      deps,
    );
    expect(next.content).toContain("after");
  });

  it("names the over-budget line in the footer, at EOF and mid-file", async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(`small\n${"y".repeat(500)}\nafter`),
    });
    const mid = await executeGroomerTool(
      { name: "read_file", arguments: { path: "huge.ts", startLine: 2 } },
      { ...options, maxFileBytes: 150 },
      deps,
    );
    expect(mid.content).toContain("(line 2 exceeds the byte limit; continues at line 3)");
    const atEnd = await executeGroomerTool(
      { name: "read_file", arguments: { path: "tail.ts", startLine: 2 } },
      { ...options, maxFileBytes: 150 },
      makeDeps({ readFile: vi.fn().mockResolvedValue(`small\n${"y".repeat(500)}`) }),
    );
    expect(atEnd.content).toContain("(line 2 exceeds the byte limit)");
    expect(atEnd.content).not.toContain("continues at line");
  });

  it("behaves exactly as before when no range arguments are given", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("plain content") });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "n.ts" } },
      options,
      deps,
    );
    expect(result.content).toBe("n.ts:\nplain content");
  });

  it("a head truncation names the line a continuation read starts from", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(10)) });
    const head = await executeGroomerTool(
      { name: "read_file", arguments: { path: "c.ts" } },
      { ...options, maxFileBytes: 70 },
      deps,
    );
    const match = /startLine=(\d+)/.exec(head.content);
    expect(match).not.toBeNull();
    // The prefix and the marker are charged to the same budget as the content,
    // so the whole answer still fits what the caller allowed.
    expect(head.bytes).toBeLessThanOrEqual(70);
    const rest = await executeGroomerTool(
      { name: "read_file", arguments: { path: "c.ts", startLine: Number(match?.[1]) } },
      { ...options, maxFileBytes: 4096 },
      deps,
    );
    // Lines shown in both calls overlap at most one line; together they cover
    // the file, and the continuation ends at the tail.
    expect(rest.content).toContain("line 10");
    expect(rest.content).toContain("end of file");
  });

  it("caps the returned lines at the per-call line cap", async () => {
    // The tool definition advertises a cap of MAX_READ_LINES lines; a model
    // asking for more must not get more.
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(800, "L")) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "s.ts", startLine: 1, lineCount: 100000 } },
      { ...options, maxFileBytes: 8192 },
      deps,
    );
    expect(result.content).toContain(`line count capped at ${MAX_READ_LINES}`);
    expect(result.content).toContain("(lines 1-500 of 800");
    expect(result.file?.content.split("\n").length).toBe(MAX_READ_LINES);
    expect(result.file?.content).not.toContain("L 501");
  });

  it("cuts the content down to what the framing leaves, instead of giving up", async () => {
    // The framing does not fit alongside the whole file, but it does fit
    // alongside fewer lines: the read must show those lines rather than
    // claim the budget is exhausted.
    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(longFile(5, "0123456789abcdef")),
    });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "f.ts", startLine: 1, lineCount: 500 } },
      { ...options, maxFileBytes: 120 },
      deps,
    );
    expect(result.content).not.toContain("byte budget exhausted");
    expect(result.content).toContain("(lines 1-2 of 5)");
    expect(result.content).toContain("continues at line 3 (pass startLine=3)");
    expect(result.bytes).toBeLessThanOrEqual(120);
  });

  it("charges a ranged answer to the remaining exploration budget, not the file cap", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(300, "longish line here")) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "b.ts", startLine: 200, lineCount: 100 } },
      { ...options, maxFileBytes: 4096, maxTotalBytesRemaining: 300 },
      deps,
    );
    expect(result.bytes).toBeLessThanOrEqual(300);
  });

  it("answers inside the budget when the framing alone does not fit", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(50, "x")) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "many.ts", startLine: 10, lineCount: 40 } },
      { ...options, maxFileBytes: 20 },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(20);
    expect(result.content).toContain("byte budget");
    // Nothing was shown, so no path is claimed read and no evidence recorded.
    expect(result.sources).toEqual([]);
    expect(result.file).toBeUndefined();
  });

  it("keeps the head read inside the budget the caller allows", async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue(longFile(120)) });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "big.ts" } },
      { ...options, maxFileBytes: 120 },
      deps,
    );
    expect(result.bytes).toBeLessThanOrEqual(120);
    expect(result.content).toContain("(truncated)");
  });
});

describe("executeGroomerTool search failure vs true absence (dispatch#1451)", () => {
  it("treats a failed search as an outage with a bounded fallback, not absence", async () => {
    const deps = makeDeps({
      searchCode: vi.fn().mockRejectedValue(
        new Error("Code search failed for org/repo: 502 <html>\n<body>" + "x".repeat(5000) + "</body>"),
      ),
    });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "enrich" } },
      options,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not evidence the code is missing");
    expect(result.content).toContain("list_directory");
    expect(result.content).not.toContain("No matches");
    // Upstream bodies reach the model only collapsed and length-bounded.
    expect(result.content).not.toContain("\n");
    expect(result.content.length).toBeLessThan(700);
    expect(result.warnings?.[0]).toContain("bounded directory/file fallback");
  });

  it("collapses the upstream search error to a 200-byte line", async () => {
    // The fence is bytes, not characters: a body of multi-byte characters must
    // not carry more bytes than the fence allows (dispatch#1451).
    const deps = makeDeps({
      searchCode: vi.fn().mockRejectedValue(new Error("é".repeat(400))),
    });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "enrich" } },
      options,
      deps,
    );
    const summary = /^search_code failed: (.*?) This is a search outage/s.exec(result.content)?.[1] ?? "";
    expect(summary.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(200);
    expect(result.content).not.toContain("\n");
  });

  it("still treats a successful empty search as possible absence", async () => {
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue([]) });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "ghostSymbol" } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(0);
    expect(result.content).toContain("No matches");
    expect(result.warnings).toBeUndefined();
  });

  it("keeps the failed-search fallback inside the remaining budget", async () => {
    // A search failure late in a run must not push the run past its total byte
    // budget: the fallback answer is charged against what is left (dispatch#1451).
    const deps = makeDeps({
      searchCode: vi.fn().mockRejectedValue(new Error("Code search failed for org/repo: 502")),
    });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "enrich" } },
      { ...options, maxFileBytes: 4096, maxTotalBytesRemaining: 120 },
      deps,
    );
    expect(result.bytes).toBeLessThanOrEqual(120);
    expect(result.ok).toBe(false);
    // The outage signal survives the clamp; the fallback instructions give way.
    expect(result.content).toContain("not evidence the code is missing");
    expect(result.content).not.toContain("No matches");
  });

  it("still calls the failure an outage when the remaining budget is nearly gone", async () => {
    const deps = makeDeps({
      searchCode: vi.fn().mockRejectedValue(new Error("Code search failed for org/repo: 502")),
    });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "enrich" } },
      { ...options, maxTotalBytesRemaining: 50 },
      deps,
    );
    expect(result.bytes).toBeLessThanOrEqual(50);
    expect(result.ok).toBe(false);
    // Too little room for the full answer, but still an outage and never an
    // absence the model can act on.
    expect(result.content).toContain("search_code failed");
    expect(result.content).toContain("outage");
    expect(result.content).not.toContain("No matches");
  });

  it("keeps a tool error inside the remaining budget", async () => {
    // The shared error path is charged against the same budget: an upstream
    // failure that carries a whole error page must not overrun it either.
    const deps = makeDeps({
      readFile: vi.fn().mockRejectedValue(new Error("x".repeat(5000))),
    });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "a.ts" } },
      { ...options, maxTotalBytesRemaining: 100 },
      deps,
    );
    expect(result.bytes).toBeLessThanOrEqual(100);
    expect(result.ok).toBe(false);
  });

  it("keeps the failed-search fallback inside every budget it is given", async () => {
    // The clamp is a property, not a case: whatever the caller has left, the
    // answer fits, stays on one line, and never reads as absence.
    const deps = makeDeps({
      searchCode: vi.fn().mockRejectedValue(new Error("x".repeat(5000))),
    });
    for (let cap = 0; cap <= 400; cap += 1) {
      const result = await executeGroomerTool(
        { name: "search_code", arguments: { query: "enrich" } },
        { ...options, maxTotalBytesRemaining: cap },
        deps,
      );
      expect(result.bytes).toBeLessThanOrEqual(cap);
      expect(result.content).not.toContain("\n");
      expect(result.content).not.toContain("No matches");
      // The outage signal is what must survive a tight budget. The thresholds
      // are the byte lengths of the wording the answer falls back to.
      if (cap >= 1) expect(result.content.length).toBeGreaterThan(0);
      if (cap >= 18) expect(result.content).toContain("search_code failed");
      if (cap >= 26) expect(result.content).toContain("outage");
      if (cap >= 63) expect(result.content).toContain("not evidence the code is missing");
    }
  });

  it("renders the roomy-budget fallback exactly", async () => {
    // The wording the model reads when the budget is not tight is pinned: the
    // clamp only ever shortens it.
    const deps = makeDeps({
      searchCode: vi.fn().mockRejectedValue(new Error("Code search failed for org/repo: 502")),
    });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "enrich" } },
      options,
      deps,
    );
    expect(result.content).toBe(
      "search_code failed: Code search failed for org/repo: 502 This is a search outage or " +
        "timeout, not evidence the code is missing — repeating the search will not help. Finish " +
        "the investigation with bounded local reads: list_directory the directories the issue " +
        "names, then read_file the specific paths (use startLine/lineCount to reach sections of a " +
        "long file).",
    );
  });
});

describe("executeGroomerTool answers stay inside the caller's remaining budget (dispatch#1451)", () => {
  const manyMatches = Array.from({ length: 10 }, (_, i) => ({
    path: `src/lib/deeply/nested/module-${i}-with-a-long-name.ts`,
  }));

  it("charges a successful search to the remaining budget", async () => {
    // A successful search renders its match list; that list is charged against
    // what the caller has left, so a search late in a run cannot push the run
    // past its total byte budget.
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue(manyMatches) });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "PrismaPg" } },
      { ...options, maxTotalBytesRemaining: 200 },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(200);
    // The answer says what it left out instead of dropping matches silently.
    expect(result.content).toMatch(/match(es)? not shown \(byte budget exhausted\)/);
    // Only the paths the model actually saw are surfaced as sources.
    const shown = result.content
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(manyMatches.length);
    expect(result.sources).toEqual(shown);
  });

  it("tells the model a cut search was a spent budget, never that the code is missing", async () => {
    // Too little budget for even one path: the model still learns that the
    // matches exist and that the budget is what cut them.
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue(manyMatches) });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "PrismaPg" } },
      { ...options, maxTotalBytesRemaining: 120 },
      deps,
    );
    expect(result.bytes).toBeLessThanOrEqual(120);
    expect(result.content).toContain("matches not shown (byte budget exhausted)");
    expect(result.content).not.toContain("No matches");
    expect(result.sources).toEqual([]);
  });

  it("keeps a successful search inside every budget it is given", async () => {
    // The clamp is a property, not a case: whatever the caller has left, the
    // answer fits.
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue(manyMatches) });
    for (let cap = 0; cap <= 400; cap += 1) {
      const result = await executeGroomerTool(
        { name: "search_code", arguments: { query: "PrismaPg" } },
        { ...options, maxTotalBytesRemaining: cap },
        deps,
      );
      expect(result.bytes).toBeLessThanOrEqual(cap);
      // A search that found matches never reads as the negative-evidence
      // signature (`ok && bytes === 0`): that shape means "found nothing".
      expect(result.ok && result.bytes === 0).toBe(false);
    }
  });

  it("still shows every match when the budget is roomy", async () => {
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue(manyMatches) });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "PrismaPg" } },
      { ...options, maxTotalBytesRemaining: 4096 },
      deps,
    );
    expect(result.content).toBe(
      `Matches for "PrismaPg":\n${manyMatches.map((m) => `- ${m.path}`).join("\n")}`,
    );
    expect(result.sources).toEqual(manyMatches.map((m) => m.path));
  });

  it("keeps a past-the-end read inside the remaining budget", async () => {
    // Nothing was shown, but the answer is still charged to the budget the
    // caller has left: a long path must not overrun it.
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("a\nb\nc") });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "x".repeat(200), startLine: 9 } },
      { ...options, maxTotalBytesRemaining: 60 },
      deps,
    );
    expect(result.bytes).toBeLessThanOrEqual(60);
    // The signal the model needs survives; the path is what gives way.
    expect(result.content).toContain("past the end of the file (3 line(s))");
    // Nothing was shown, so no path is claimed read.
    expect(result.sources).toEqual([]);
    expect(result.file).toBeUndefined();
  });

  it("keeps a directory listing inside the remaining budget", async () => {
    const deps = makeDeps({
      listDir: vi.fn().mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          path: `src/deeply/nested/directory-entry-${i}.ts`,
          type: "file" as const,
          size: 1,
        })),
      ),
    });
    const result = await executeGroomerTool(
      { name: "list_directory", arguments: { path: "src" } },
      { ...options, maxTotalBytesRemaining: 200 },
      deps,
    );
    expect(result.bytes).toBeLessThanOrEqual(200);
    expect(result.content).toContain("… ");
  });

  it("keeps the zero-byte answers inside the remaining budget", async () => {
    // A successful empty search still reads as possible absence (bytes 0),
    // and every answer still fits the budget the caller has left.
    const emptySearch = makeDeps({ searchCode: vi.fn().mockResolvedValue([]) });
    const emptyFile = makeDeps({ readFile: vi.fn().mockResolvedValue("") });
    const emptyDir = makeDeps({ listDir: vi.fn().mockResolvedValue([]) });
    for (let cap = 0; cap <= 200; cap += 1) {
      const search = await executeGroomerTool(
        { name: "search_code", arguments: { query: "ghostSymbol" } },
        { ...options, maxTotalBytesRemaining: cap },
        emptySearch,
      );
      expect(search.bytes).toBe(0);
      expect(Buffer.byteLength(search.content, "utf8")).toBeLessThanOrEqual(cap);
      const file = await executeGroomerTool(
        { name: "read_file", arguments: { path: "x".repeat(300) } },
        { ...options, maxTotalBytesRemaining: cap },
        emptyFile,
      );
      expect(Buffer.byteLength(file.content, "utf8")).toBeLessThanOrEqual(cap);
      const dir = await executeGroomerTool(
        { name: "list_directory", arguments: { path: "x".repeat(300) } },
        { ...options, maxTotalBytesRemaining: cap },
        emptyDir,
      );
      expect(Buffer.byteLength(dir.content, "utf8")).toBeLessThanOrEqual(cap);
    }
  });

  it("still reads as absence when the no-match answer is squeezed", async () => {
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue([]) });
    const result = await executeGroomerTool(
      { name: "search_code", arguments: { query: "ghostSymbol" } },
      { ...options, maxTotalBytesRemaining: 40 },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(0);
    expect(result.content).toContain("No matches");
  });
});
