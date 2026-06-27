import type { GitHubCodeSearchResult, GitHubRepoMetadata } from "@/lib/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRepositoryContext,
  type RepositoryContextConfig,
  type RepositoryContextDeps,
  type RepositoryContextInput,
} from "./repository-context";

const defaultConfig: RepositoryContextConfig = {
  enabled: true,
  maxSearches: 5,
  maxFiles: 10,
  maxFileBytes: 4096,
  maxTotalBytes: 32768,
};

const defaultInput: RepositoryContextInput = {
  repoFullName: "org/repo",
  issueTitle: "Fix authentication timeout handling",
  issueBody: "Users get a 504 when the auth service is slow to respond.",
};

function makeDeps(): RepositoryContextDeps & {
  fetchRepo: ReturnType<typeof vi.fn<(repoFullName: string) => Promise<GitHubRepoMetadata>>>;
  searchCode: ReturnType<typeof vi.fn<(repoFullName: string, query: string, limit: number) => Promise<GitHubCodeSearchResult[]>>>;
  fetchFile: ReturnType<typeof vi.fn<(repoFullName: string, path: string, ref?: string) => Promise<string>>>;
} {
  return {
    fetchRepo: vi.fn<(repoFullName: string) => Promise<GitHubRepoMetadata>>(),
    searchCode: vi.fn<(repoFullName: string, query: string, limit: number) => Promise<GitHubCodeSearchResult[]>>(),
    fetchFile: vi.fn<(repoFullName: string, path: string, ref?: string) => Promise<string>>(),
  };
}

describe("buildRepositoryContext", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("disabled config", () => {
    it("returns empty result and makes no GitHub calls", async () => {
      const result = await buildRepositoryContext(
        defaultInput,
        { ...defaultConfig, enabled: false },
        deps,
      );

      expect(result.text).toBe("");
      expect(result.sources).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.bytes).toBe(0);
      expect(result.queries).toEqual([]);
      expect(deps.fetchRepo).not.toHaveBeenCalled();
      expect(deps.searchCode).not.toHaveBeenCalled();
      expect(deps.fetchFile).not.toHaveBeenCalled();
    });
  });

  describe("enabled config", () => {
    it("fetches repo metadata and includes it in text", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: "A test repository",
      });
      deps.searchCode.mockResolvedValue([]);

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.text).toContain("Repository context:");
      expect(result.text).toContain("- repo: org/repo");
      expect(result.text).toContain("- default branch: main");
      expect(result.text).toContain("- description: A test repository");
      expect(deps.fetchRepo).toHaveBeenCalledWith("org/repo");
    });

    it("includes repo metadata without description when null", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([]);

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.text).toContain("- repo: org/repo");
      expect(result.text).not.toContain("description:");
    });

    it("derives search queries from title and body", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([]);

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.queries).toContain("authentication");
      expect(result.queries).toContain("timeout");
      expect(result.queries).toContain("handling");
      // Stop words should be filtered
      expect(result.queries).not.toContain("the");
      expect(result.queries).not.toContain("when");
    });

    it("respects maxSearches limit on queries", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([]);

      const result = await buildRepositoryContext(
        defaultInput,
        { ...defaultConfig, maxSearches: 2 },
        deps,
      );

      expect(result.queries.length).toBeLessThanOrEqual(2);
    });

    it("searches code for each query and fetches files", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "src/auth.ts", url: "https://github.com/org/repo/blob/main/src/auth.ts" },
      ]);
      deps.fetchFile.mockResolvedValue("export const auth = true;");

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.text).toContain("File: src/auth.ts");
      expect(result.text).toContain("export const auth = true;");
      expect(result.sources).toContain("src/auth.ts");
    });

    it("respects maxFiles limit", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "a.ts", url: "1" },
        { path: "b.ts", url: "2" },
        { path: "c.ts", url: "3" },
      ]);
      deps.fetchFile.mockResolvedValue("content");

      const result = await buildRepositoryContext(
        defaultInput,
        { ...defaultConfig, maxFiles: 2 },
        deps,
      );

      expect(result.sources.length).toBeLessThanOrEqual(2);
    });

    it("respects maxFileBytes per file", async () => {
      const largeContent = "x".repeat(5000);
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "big.ts", url: "1" },
      ]);
      deps.fetchFile.mockResolvedValue(largeContent);

      const result = await buildRepositoryContext(
        defaultInput,
        { ...defaultConfig, maxFileBytes: 1024 },
        deps,
      );

      expect(result.text).toContain("[truncated]");
      expect(result.sources).toContain("big.ts");
    });

    it("respects maxTotalBytes across all files", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "a.ts", url: "1" },
        { path: "b.ts", url: "2" },
        { path: "c.ts", url: "3" },
      ]);
      deps.fetchFile.mockResolvedValue("x".repeat(500));

      const result = await buildRepositoryContext(
        defaultInput,
        { ...defaultConfig, maxTotalBytes: 1200 },
        deps,
      );

      // With ~514 bytes per file entry (including "File: path\n...\n"),
      // maxTotalBytes=1200 should allow at most 2 files
      expect(result.sources.length).toBeLessThanOrEqual(2);
    });

    it("skips non-text-like extensions", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "image.png", url: "1" },
        { path: "data.bin", url: "2" },
        { path: "valid.ts", url: "3" },
      ]);
      deps.fetchFile.mockResolvedValue("text content");

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.sources).not.toContain("image.png");
      expect(result.sources).not.toContain("data.bin");
      expect(result.sources).toContain("valid.ts");
      // fetchFile should only be called for text-like paths
      expect(deps.fetchFile).toHaveBeenCalledWith("org/repo", "valid.ts", "main");
      expect(deps.fetchFile).not.toHaveBeenCalledWith("org/repo", "image.png", expect.anything());
    });

    it("skips files without extension", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "Dockerfile", url: "1" },
        { path: "src/app.ts", url: "2" },
      ]);
      deps.fetchFile.mockResolvedValue("content");

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.sources).not.toContain("Dockerfile");
      expect(result.sources).toContain("src/app.ts");
    });

    it("tracks bytes correctly", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "a.ts", url: "1" },
      ]);
      deps.fetchFile.mockResolvedValue("hello world");

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.bytes).toBeGreaterThan(0);
    });
  });

  describe("soft failures", () => {
    it("records warning on fetchRepo failure and continues without metadata", async () => {
      deps.fetchRepo.mockRejectedValue(new Error("repo not found"));
      deps.searchCode.mockResolvedValue([]);

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Failed to fetch repo metadata");
      // Should still return a result, not throw
      expect(result.text).toBe("");
    });

    it("records warning on searchCode failure and continues", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockRejectedValue(new Error("rate limited"));

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.warnings.some((w) => w.includes("Code search failed"))).toBe(true);
      // Repo metadata should still be in the text
      expect(result.text).toContain("- repo: org/repo");
    });

    it("records warning on fetchFile failure and continues to next file", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "bad.ts", url: "1" },
        { path: "good.ts", url: "2" },
      ]);
      deps.fetchFile
        .mockRejectedValueOnce(new Error("not found"))
        .mockResolvedValueOnce("works");

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.warnings.some((w) => w.includes("Failed to fetch bad.ts"))).toBe(true);
      expect(result.sources).toContain("good.ts");
      expect(result.sources).not.toContain("bad.ts");
    });
  });

  describe("duplicate paths", () => {
    it("does not fetch the same path twice across queries", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "shared.ts", url: "1" },
      ]);
      deps.fetchFile.mockResolvedValue("content");

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(deps.fetchFile).toHaveBeenCalledTimes(1);
      expect(result.sources).toEqual(["shared.ts"]);
    });

    it("does not fetch the same path returned by multiple search results", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "dup.ts", url: "1" },
        { path: "dup.ts", url: "2" },
        { path: "unique.ts", url: "3" },
      ]);
      deps.fetchFile.mockResolvedValue("content");

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(deps.fetchFile).toHaveBeenCalledTimes(2);
      expect(result.sources).toContain("dup.ts");
      expect(result.sources).toContain("unique.ts");
    });
  });

  describe("edge cases", () => {
    it("handles empty issue title and body", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });

      const result = await buildRepositoryContext(
        { ...defaultInput, issueTitle: "", issueBody: null },
        defaultConfig,
        deps,
      );

      expect(result.queries).toEqual([]);
      expect(deps.searchCode).not.toHaveBeenCalled();
      // Should still have repo metadata
      expect(result.text).toContain("- repo: org/repo");
    });

    it("handles empty search results gracefully", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([]);

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.sources).toEqual([]);
      expect(result.text).toContain("- repo: org/repo");
    });

    it("handles empty file content gracefully", async () => {
      deps.fetchRepo.mockResolvedValue({
        fullName: "org/repo",
        defaultBranch: "main",
        description: null,
      });
      deps.searchCode.mockResolvedValue([
        { path: "empty.ts", url: "1" },
      ]);
      deps.fetchFile.mockResolvedValue("");

      const result = await buildRepositoryContext(defaultInput, defaultConfig, deps);

      expect(result.sources).not.toContain("empty.ts");
    });
  });
});
