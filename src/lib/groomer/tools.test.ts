import { describe, expect, it, vi } from "vitest";
import { RelatedWorkNotFoundError } from "@/lib/github-related-work";
import {
  buildGroomerToolDefinitions,
  executeGroomerTool,
  normalizeRepoPath,
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
      { evidenceKey: "issue:org/repo#101", title: "Original sslmode report" },
      { evidenceKey: "pr:org/repo#102", title: "Attempted fix" },
    ];
    const deps = makeDeps({ searchRelatedWork: vi.fn().mockResolvedValue(hits) });
    const result = await executeGroomerTool(
      { name: "search_related_work", arguments: { query: "sslmode" } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toEqual(hits);
    expect(result.sources).toEqual(["issue:org/repo#101", "pr:org/repo#102"]);
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
        .mockResolvedValue({ number: 7, title: "Dependency", state: "closed", evidenceKey: "issue:org/repo#7" }),
    });
    const result = await executeGroomerTool(
      { name: "read_related_issue", arguments: { number: 7 } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ number: 7, state: "closed" });
    expect(result.sources).toEqual(["issue:org/repo#7"]);
    expect(deps.fetchRelatedIssue).toHaveBeenCalledWith("org/repo", 7);
  });

  it("read_related_pr reports a merged PR as merged", async () => {
    const deps = makeDeps({
      fetchRelatedPullRequest: vi
        .fn()
        .mockResolvedValue({ number: 42, title: "Fix", state: "merged", evidenceKey: "pr:org/repo#42" }),
    });
    const result = await executeGroomerTool(
      { name: "read_related_pr", arguments: { number: 42 } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ number: 42, state: "merged" });
    expect(result.sources).toEqual(["pr:org/repo#42"]);
  });

  it("read_related_pr reports an open PR as open", async () => {
    const deps = makeDeps({
      fetchRelatedPullRequest: vi
        .fn()
        .mockResolvedValue({ number: 43, title: "WIP", state: "open", evidenceKey: "pr:org/repo#43" }),
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
        .mockResolvedValue({ sha: "abc123", message: "Fix the login bug", evidenceKey: "commit:abc123" }),
    });
    const result = await executeGroomerTool(
      { name: "read_related_commit", arguments: { ref: "abc123" } },
      options,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ sha: "abc123", message: "Fix the login bug" });
    expect(result.sources).toEqual(["commit:abc123"]);
    expect(deps.fetchRelatedCommit).toHaveBeenCalledWith("org/repo", "abc123");
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
      fetchRelatedPullRequest: vi.fn().mockRejectedValue(new Error("GitHub API 500")),
    });
    const result = await executeGroomerTool(
      { name: "read_related_pr", arguments: { number: 42 } },
      options,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ error: true });
    expect(result.warnings).toEqual(["related-work: pr lookup failed"]);
    expect(result.sources).toEqual([]);
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
    // "…" is three UTF-8 bytes; cutting at 4 lands mid-character.
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("ab…cd") });
    const result = await executeGroomerTool(
      { name: "read_file", arguments: { path: "a.ts" } },
      { ...options, maxFileBytes: 4 },
      deps,
    );
    expect(result.content).not.toContain("�");
    expect(result.content).toContain("(truncated)");
  });
});
