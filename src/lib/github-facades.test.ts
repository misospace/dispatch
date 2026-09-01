// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as Auth from "./github-auth";
import * as Ci from "./github-ci";
import * as CodeSearch from "./github-code-search";
import * as Issues from "./github-issues";
import * as Prs from "./github-prs";
import * as Barrel from "./github";

describe("github domain modules expose expected exports", () => {
  it("github-auth exports token + pagination symbols", () => {
    expect(Object.keys(Auth).sort()).toEqual(
      ["GITHUB_API", "__resetGitHubAppState", "fetchPaginated", "fetchWithRetry", "getGitHubToken", "getHeadersAsync", "validateGitHubToken"].sort(),
    );
  });

  it("github-issues exports issue/label/comment symbols", () => {
    expect(Object.keys(Issues).sort()).toEqual([
      "addIssueComment",
      "addIssueLabel",
      "closeIssue",
      "fetchIssue",
      "fetchIssueComments",
      "fetchIssues",
      "removeIssueLabel",
      "syncStatusLabels",
      "updateIssueComment",
      "updateIssueLabels",
      "updateIssueTitleAndBody",
    ]);
  });

  it("github-ci exports CI/workflows/runs/jobs/releases/packages/commits/logs symbols", () => {
    expect(Object.keys(Ci).sort()).toEqual([
      "extractLogExcerpt",
      "fetchFailedJobLogExcerpt",
      "fetchLatestCommit",
      "fetchPackages",
      "fetchRecentRunsAllWorkflows",
      "fetchReleases",
      "fetchRunJobs",
      "fetchWorkflowRuns",
      "fetchWorkflows",
      "jobIdFromCheckRunUrl",
      "rerunWorkflow",
      "triggerWorkflowDispatch",
    ]);
  });

  it("github-prs exports PR/review/health symbols", () => {
    expect(Object.keys(Prs).sort()).toEqual([
      "fetchClosedPullRequests",
      "fetchLinkedPrHealthInput",
      "fetchPullRequestCheckFailures",
      "fetchPullRequestHealthSignals",
      "fetchPullRequestMergeState",
      "fetchPullRequestState",
      "fetchPullRequests",
    ]);
  });

  it("github-code-search exports repo metadata/search/contents symbols", () => {
    expect(Object.keys(CodeSearch).sort()).toEqual([
      "fetchRepo",
      "fetchRepositoryFileText",
      "fetchRepositoryMetadata",
      "listRepositoryDirectory",
      "searchRepositoryCode",
    ]);
  });

  it("barrel re-exports all public symbols from domain modules", () => {
    const barrelKeys = Object.keys(Barrel).sort();
    const expected = [
      "getGitHubToken", "__resetGitHubAppState", "fetchPaginated", "validateGitHubToken",
      "fetchIssues", "fetchIssue", "updateIssueLabels", "fetchIssueComments",
      "addIssueComment", "addIssueLabel", "updateIssueComment",
      "updateIssueTitleAndBody", "removeIssueLabel", "syncStatusLabels", "closeIssue",
      "fetchRepo", "fetchWorkflows", "fetchWorkflowRuns", "fetchRecentRunsAllWorkflows",
      "fetchRunJobs", "fetchReleases", "fetchPackages", "rerunWorkflow",
      "triggerWorkflowDispatch", "fetchLatestCommit", "jobIdFromCheckRunUrl",
      "extractLogExcerpt", "fetchFailedJobLogExcerpt",
      "fetchPullRequests", "fetchClosedPullRequests", "fetchPullRequestHealthSignals",
      "fetchPullRequestState", "fetchPullRequestMergeState", "fetchPullRequestCheckFailures",
      "fetchLinkedPrHealthInput",
      "fetchRepositoryMetadata", "searchRepositoryCode", "fetchRepositoryFileText",
    ];
    for (const name of expected) {
      expect(barrelKeys).toContain(name);
    }
  });

  it("barrel does not leak GITHUB_API or getHeadersAsync", () => {
    const barrelKeys = Object.keys(Barrel);
    expect(barrelKeys).not.toContain("GITHUB_API");
    expect(barrelKeys).not.toContain("getHeadersAsync");
  });

  it("barrel re-exports are identity references", () => {
    expect(Barrel.getGitHubToken).toBe(Auth.getGitHubToken);
    expect(Barrel.fetchIssues).toBe(Issues.fetchIssues);
    expect(Barrel.fetchPullRequests).toBe(Prs.fetchPullRequests);
  });
});
