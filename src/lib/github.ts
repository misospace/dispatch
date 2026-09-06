// Public barrel for split GitHub domain modules
export {
  getGitHubToken,
  __resetGitHubAppState,
  fetchPaginated,
  validateGitHubToken,
} from "./github-auth";

export {
  fetchIssues,
  fetchIssue,
  updateIssueLabels,
  type GitHubIssueComment,
  fetchIssueComments,
  addIssueComment,
  createIssue,
  updateIssueComment,
  addIssueLabel,
  type UpdateIssueFields,
  updateIssueTitleAndBody,
  removeIssueLabel,
  syncStatusLabels,
  closeIssue,
} from "./github-issues";

export {
  type GithubWorkflow,
  fetchWorkflows,
  type GithubWorkflowRun,
  fetchWorkflowRuns,
  fetchRecentRunsAllWorkflows,
  type GithubJob,
  fetchRunJobs,
  type GithubRelease,
  fetchReleases,
  type GithubPackageInfo,
  fetchPackages,
  rerunWorkflow,
  triggerWorkflowDispatch,
  type GithubCommit,
  fetchLatestCommit,
  jobIdFromCheckRunUrl,
  extractLogExcerpt,
  fetchFailedJobLogExcerpt,
} from "./github-ci";

export {
  type GithubPR,
  fetchPullRequests,
  fetchClosedPullRequests,
  type PrHealthSignals,
  fetchPullRequestHealthSignals,
  fetchPullRequestState,
  fetchPullRequestMergeState,
  fetchPullRequestHeadSha,
  fetchPullRequestCheckFailures,
  fetchLinkedPrHealthInput,
  fetchPullRequestCommitMessages,
} from "./github-prs";

export {
  type GithubRepo,
  fetchRepo,
  type GitHubDirectoryEntry,
  listRepositoryDirectory,
  type GitHubRepoMetadata,
  fetchRepositoryMetadata,
  type GitHubCodeSearchResult,
  searchRepositoryCode,
  fetchRepositoryFileText,
} from "./github-code-search";
