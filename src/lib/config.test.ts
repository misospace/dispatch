import { describe, expect, it } from "vitest";
import { isValidRepoName, parseRepoList } from "./config";

describe("parseRepoList", () => {
  it("parses comma-separated repos", () => {
    expect(parseRepoList("org/api,org/web")).toEqual(["org/api", "org/web"]);
  });

  it("parses newline-separated repos", () => {
    expect(parseRepoList("org/api\norg/web")).toEqual(["org/api", "org/web"]);
  });

  it("parses mixed comma and newline input", () => {
    expect(parseRepoList("org/api,org/web\norg/worker")).toEqual(["org/api", "org/web", "org/worker"]);
  });

  it("trims spaces and ignores blank lines", () => {
    expect(parseRepoList(" org/api ,\n\n org/web ")).toEqual(["org/api", "org/web"]);
  });

  it("dedupes repos while preserving order", () => {
    expect(parseRepoList("org/api,org/web,org/api")).toEqual(["org/api", "org/web"]);
  });

  it("ignores invalid repo strings", () => {
    expect(parseRepoList("org/api,no-slash,owner only/repo,bad/repo/name,/missing-owner,missing-repo/")).toEqual([
      "org/api",
    ]);
  });
});

describe("isValidRepoName", () => {
  it("validates owner/repo shape", () => {
    expect(isValidRepoName("org/api")).toBe(true);
    expect(isValidRepoName("org/api/extra")).toBe(false);
    expect(isValidRepoName("org only/api")).toBe(false);
    expect(isValidRepoName("org/api only")).toBe(false);
  });
});
