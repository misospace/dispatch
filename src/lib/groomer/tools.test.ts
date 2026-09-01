import { describe, expect, it, vi } from "vitest";
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
    ...overrides,
  };
}

describe("buildGroomerToolDefinitions", () => {
  it("exposes search, read, list and submit", () => {
    const names = buildGroomerToolDefinitions().map(
      (t) => (t.function as { name: string }).name,
    );
    expect(names).toEqual(["search_code", "read_file", "list_directory", "submit_findings"]);
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
    expect(deps.readFile).toHaveBeenCalledWith("org/repo", "src/lib/prisma.ts");
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
