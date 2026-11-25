import { describe, expect, it } from "vitest";
import { isValidRepoName, parseRepoList } from "./config";
import { parseFollowupIdentityScopes } from "./config-parsers";

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

// ─── Follow-up identity scopes (#1665) ──────────────────────────────────────

describe("parseFollowupIdentityScopes", () => {
  it("parses a JSON object of logins to prefix lists", () => {
    expect(
      parseFollowupIdentityScopes(JSON.stringify({ "renovate[bot]": ["renovate/"], "dep-bot": ["dep-", "dep_"] })),
    ).toEqual([
      { login: "renovate[bot]", branchPrefixes: ["renovate/"] },
      { login: "dep-bot", branchPrefixes: ["dep-", "dep_"] },
    ]);
  });

  it("returns no scopes for unset or blank input", () => {
    expect(parseFollowupIdentityScopes(undefined)).toEqual([]);
    expect(parseFollowupIdentityScopes("")).toEqual([]);
    expect(parseFollowupIdentityScopes("   ")).toEqual([]);
  });

  it("returns no scopes for malformed or non-object JSON (fail closed)", () => {
    expect(parseFollowupIdentityScopes("not json")).toEqual([]);
    expect(parseFollowupIdentityScopes('["renovate[bot]"]')).toEqual([]);
    expect(parseFollowupIdentityScopes('"renovate[bot]"')).toEqual([]);
    expect(parseFollowupIdentityScopes("null")).toEqual([]);
    expect(parseFollowupIdentityScopes("42")).toEqual([]);
  });

  it("trims logins and prefixes, drops empty prefixes, and dedupes prefixes", () => {
    expect(
      parseFollowupIdentityScopes(JSON.stringify({ " scoped-bot ": [" task/ ", " task/", ""] })),
    ).toEqual([{ login: "scoped-bot", branchPrefixes: ["task/"] }]);
  });

  it("tolerates a bare string prefix as a one-element list", () => {
    expect(parseFollowupIdentityScopes(JSON.stringify({ "bot-1": "release-" }))).toEqual([
      { login: "bot-1", branchPrefixes: ["release-"] },
    ]);
  });

  it("keeps an entry whose prefixes are all empty as a match-nothing scope", () => {
    expect(parseFollowupIdentityScopes(JSON.stringify({ "bot-1": [] }))).toEqual([
      { login: "bot-1", branchPrefixes: [] },
    ]);
    expect(parseFollowupIdentityScopes(JSON.stringify({ "bot-1": [123, null] }))).toEqual([
      { login: "bot-1", branchPrefixes: [] },
    ]);
  });

  it("skips blank logins and keeps the first entry for a duplicated login", () => {
    expect(
      parseFollowupIdentityScopes('{"": ["a/"], "bot-1": ["first/"] , "  bot-1  ": ["second/"]}'),
    ).toEqual([{ login: "bot-1", branchPrefixes: ["first/"] }]);
  });
});
