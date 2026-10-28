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
      [
        "GITHUB_API",
        "GITHUB_FETCH_MAX_ATTEMPTS",
        "GITHUB_RETRY_MAX_DELAY_MS",
        "__resetGitHubAppState",
        "fetchPaginated",
        "fetchWithRetry",
        "getGitHubToken",
        "getHeadersAsync",
        "githubCallBudgetMs",
        "githubFetchTimeoutMs",
        "validateGitHubToken",
      ].sort(),
    );
  });

  it("github-issues exports issue/label/comment symbols", () => {
    expect(Object.keys(Issues).sort()).toEqual([
      "addIssueComment",
      "addIssueLabel",
      "closeIssue",
      "createIssue",
      "fetchCollaboratorPermission",
      "fetchIssue",
      "fetchIssueComments",
      "fetchIssueNativeBlockers",
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
  "RELEASE_BASELINE_SEARCH_MAX",
  "extractLogExcerpt",
      "fetchCommitDate",
      "fetchCompare",
      "fetchFailedJobLogExcerpt",
      "fetchLatestCommit",
      "fetchPackages",
"fetchRecentRunsAllWorkflows",
  "fetchReleases",
  "fetchRunJobs",
  "fetchStableBaselineRelease",
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
      "fetchPullRequestCommitMessages",
      "fetchPullRequestHeadSha",
      "fetchPullRequestHealthSignals",
      "fetchPullRequestLabels",
      "fetchPullRequestMergeState",
      "fetchPullRequestReviewThreadStates",
      "fetchPullRequestState",
      "fetchPullRequests",
    ]);
  });

  it("github-code-search exports repo metadata/search/contents symbols", () => {
    expect(Object.keys(CodeSearch).sort()).toEqual([
      "COMPARE_MAX_FILES",
      "compareCommits",
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
      "fetchStableBaselineRelease",
      "triggerWorkflowDispatch", "fetchLatestCommit", "fetchCompare", "jobIdFromCheckRunUrl",
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
