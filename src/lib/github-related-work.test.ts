// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  RelatedWorkNotFoundError,
  fetchRelatedCommit,
  fetchRelatedIssue,
  fetchRelatedPullRequest,
  searchRelatedWork,
  type RelatedWorkIssue,
} from "./github-related-work";

// GITHUB_TOKEN is read by getHeadersAsync (github-auth) on every request; the
// GitHub App env vars stay unset so the PAT path is exercised.
process.env.GITHUB_TOKEN = "test-token-for-related-work";

function mockResponse(
  data: unknown,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(typeof data === "string" ? data : JSON.stringify(data)),
    headers: new Headers(headers),
  } as Response;
}

describe("github-related-work", () => {
  let fetchSpy: Mock<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("fetchRelatedIssue", () => {
    it("keeps the newest comments (desc request) and returns them ascending", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({
            number: 10,
            title: "A closed issue",
            body: "the body",
            state: "closed",
            html_url: "https://github.com/org/repo/issues/10",
            labels: [{ name: "status/done" }, { name: "type/bug" }],
            updated_at: "2026-01-01T00:00:00Z",
          }),
        )
        // Newest first, as GitHub returns with direction=desc.
        .mockResolvedValueOnce(
          mockResponse([
            {
              user: { login: "carol" },
              author_association: "MEMBER",
              body: "resolved it",
              html_url: "https://github.com/org/repo/issues/10#comment-3",
              created_at: "2026-01-03T00:00:00Z",
            },
            {
              user: { login: "dependabot[bot]" },
              author_association: "BOT",
              body: "bump",
              html_url: "https://github.com/org/repo/issues/10#comment-2",
              created_at: "2026-01-02T00:00:00Z",
            },
            {
              user: { login: "alice" },
              author_association: "MEMBER",
              body: "hello",
              html_url: "https://github.com/org/repo/issues/10#comment-1",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]),
        );

      const issue = (await fetchRelatedIssue("org/repo", 10, { maxComments: 2 })) as RelatedWorkIssue;

      expect(issue.kind).toBe("issue");
      expect(issue.state).toBe("closed");
      expect(issue.merged).toBe(false);
      expect(issue.labels).toEqual(["status/done", "type/bug"]);
      expect(issue.source).toBe("github-issue");
      expect(issue.evidenceKey).toBe("github:issue:org/repo#10");
      // The comments request is newest-first...
      expect(String(fetchSpy.mock.calls[1]![0])).toContain("direction=desc");
      // ...the two newest are kept (oldest "alice" dropped), re-sorted ascending.
      expect(issue.comments.map((c) => c.author)).toEqual(["dependabot[bot]", "carol"]);
      // BOT association -> bot
      expect(issue.comments[0].isBot).toBe(true);
      expect(issue.comments[0].author).toBe("dependabot[bot]");
      expect(issue.comments[0].authorType).toBe("BOT");
      // MEMBER -> not a bot
      expect(issue.comments[1].isBot).toBe(false);
      expect(issue.comments[1].authorType).toBe("MEMBER");
    });

    it("flags a [bot]-suffixed login as a bot even when author_association is not BOT", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({
            number: 11,
            title: "t",
            body: null,
            state: "open",
            html_url: "https://github.com/org/repo/issues/11",
            labels: [],
            updated_at: null,
          }),
        )
        .mockResolvedValueOnce(
          mockResponse([
            {
              user: { login: "github-actions[bot]" },
              author_association: "NONE",
              body: "ci",
              html_url: "u",
              created_at: null,
            },
          ]),
        );

      const issue = (await fetchRelatedIssue("org/repo", 11)) as RelatedWorkIssue;

      expect(issue.comments[0].isBot).toBe(true);
      expect(issue.comments[0].authorType).toBe("NONE");
    });

    it("caps issue body and comment bodies to maxBodyBytes with an ellipsis", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({
            number: 12,
            title: "t",
            body: "x".repeat(100),
            state: "open",
            html_url: "https://github.com/org/repo/issues/12",
            labels: [],
            updated_at: null,
          }),
        )
        .mockResolvedValueOnce(
          mockResponse([
            {
              user: { login: "a" },
              author_association: "MEMBER",
              body: "y".repeat(100),
              html_url: "u",
              created_at: null,
            },
          ]),
        );

      const issue = (await fetchRelatedIssue("org/repo", 12, { maxBodyBytes: 20 })) as RelatedWorkIssue;

      // Byte-correct cap: a 100-byte ASCII body at 20 bytes leaves a 17-byte
      // prefix (20 - 3-byte ellipsis) plus the ellipsis = 20 bytes / 18 chars.
      expect(issue.bodyExcerpt).toBe(`${"x".repeat(17)}…`);
      expect(issue.bodyExcerpt.length).toBe(18);
      expect(issue.comments[0].bodyExcerpt).toBe(`${"y".repeat(17)}…`);
    });

    it("caps the comment list to maxComments", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({
            number: 13,
            title: "t",
            body: null,
            state: "open",
            html_url: "https://github.com/org/repo/issues/13",
            labels: [],
            updated_at: null,
          }),
        )
        .mockResolvedValueOnce(
          mockResponse(
            Array.from({ length: 7 }, (_, i) => ({
              user: { login: `u${i}` },
              author_association: "MEMBER",
              body: `c${i}`,
              html_url: "u",
              created_at: null,
            })),
          ),
        );

      const issue = (await fetchRelatedIssue("org/repo", 13, { maxComments: 3 })) as RelatedWorkIssue;

      expect(issue.comments).toHaveLength(3);
    });

    it("throws RelatedWorkNotFoundError on a 404", async () => {
      fetchSpy.mockResolvedValue(mockResponse({ message: "Not Found" }, { status: 404 }));

      const err = await fetchRelatedIssue("org/repo", 999).catch((e) => e);

      expect(err).toBeInstanceOf(RelatedWorkNotFoundError);
      expect(err.kind).toBe("issue");
      expect(err.ref).toBe("org/repo#999");
    });

    it("delegates to the PR fetch when the /issues response has a pull_request marker", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({
            number: 30,
            title: "A PR via the issues endpoint",
            body: "pr body",
            state: "closed",
            html_url: "https://github.com/org/repo/pull/30",
            updated_at: "2026-02-02T00:00:00Z",
            pull_request: { url: "https://api.github.com/repos/org/repo/pulls/30" },
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            number: 30,
            title: "A PR via the issues endpoint",
            body: "pr body",
            state: "closed",
            html_url: "https://github.com/org/repo/pull/30",
            updated_at: "2026-02-02T00:00:00Z",
            merged: true,
            merged_at: "2026-02-02T00:00:00Z",
            merge_commit_sha: "abc123",
            base: { ref: "main" },
            head: { ref: "feature", sha: "def456" },
          }),
        );

      const result = await fetchRelatedIssue("org/repo", 30);

      // The /issues response is recognized as a PR and delegated to /pulls.
      expect(result.kind).toBe("pull_request");
      expect(result.state).toBe("merged");
      expect(result.merged).toBe(true);
      // The delegation hit the authoritative pulls endpoint.
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/pulls/30"))).toBe(true);
    });

    it("caps a multi-byte body to maxBodyBytes without splitting a character", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({
            number: 31,
            title: "t",
            // 10 x U+1F600 = 40 UTF-8 bytes.
            body: "😀".repeat(10),
            state: "open",
            html_url: "https://github.com/org/repo/issues/31",
            labels: [],
            updated_at: null,
          }),
        )
        .mockResolvedValueOnce(mockResponse([]));

      const issue = (await fetchRelatedIssue("org/repo", 31, { maxBodyBytes: 20 })) as RelatedWorkIssue;

      // The 17-byte budget (20 - 3) cuts mid-sequence at the 5th emoji; the
      // partial char is dropped, so the excerpt stays whole and within budget.
      expect(Buffer.byteLength(issue.bodyExcerpt, "utf8")).toBeLessThanOrEqual(20);
      expect(issue.bodyExcerpt).not.toContain("�");
      expect(issue.bodyExcerpt.endsWith("…")).toBe(true);
    });
  });

  describe("fetchRelatedPullRequest", () => {
    it("maps a merged PR with merge metadata", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          number: 20,
          title: "A merged PR",
          body: "pr body",
          state: "closed",
          html_url: "https://github.com/org/repo/pull/20",
          updated_at: "2026-02-01T00:00:00Z",
          merged: true,
          merged_at: "2026-02-02T00:00:00Z",
          merge_commit_sha: "abc123",
          base: { ref: "main" },
          head: { ref: "feature", sha: "def456" },
        }),
      );

      const pr = await fetchRelatedPullRequest("org/repo", 20);

      expect(pr.kind).toBe("pull_request");
      expect(pr.state).toBe("merged");
      expect(pr.merged).toBe(true);
      expect(pr.mergeCommitSha).toBe("abc123");
      expect(pr.mergedAt).toBe("2026-02-02T00:00:00Z");
      expect(pr.baseRef).toBe("main");
      expect(pr.headRef).toBe("feature");
      expect(pr.headSha).toBe("def456");
      expect(pr.source).toBe("github-pull-request");
      expect(pr.evidenceKey).toBe("github:pr:org/repo#20");
    });

    it("maps an open PR", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          number: 21,
          title: "An open PR",
          body: null,
          state: "open",
          html_url: "https://github.com/org/repo/pull/21",
          updated_at: "2026-02-01T00:00:00Z",
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          base: { ref: "main" },
          head: { ref: "feature", sha: "def456" },
        }),
      );

      const pr = await fetchRelatedPullRequest("org/repo", 21);

      expect(pr.state).toBe("open");
      expect(pr.merged).toBe(false);
      expect(pr.mergeCommitSha).toBeNull();
      expect(pr.mergedAt).toBeNull();
    });

    it("treats a closed PR with merged_at as merged", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          number: 22,
          title: "t",
          body: null,
          state: "closed",
          html_url: "https://github.com/org/repo/pull/22",
          updated_at: null,
          merged: null,
          merged_at: "2026-02-02T00:00:00Z",
          merge_commit_sha: null,
          base: { ref: "main" },
          head: { ref: "feature", sha: null },
        }),
      );

      const pr = await fetchRelatedPullRequest("org/repo", 22);

      expect(pr.state).toBe("merged");
      expect(pr.merged).toBe(true);
      expect(pr.headSha).toBeNull();
    });

    it("throws RelatedWorkNotFoundError on a 404", async () => {
      fetchSpy.mockResolvedValue(mockResponse({ message: "Not Found" }, { status: 404 }));

      const err = await fetchRelatedPullRequest("org/repo", 999).catch((e) => e);

      expect(err).toBeInstanceOf(RelatedWorkNotFoundError);
      expect(err.kind).toBe("pull_request");
      expect(err.ref).toBe("org/repo#999");
    });
  });

  describe("fetchRelatedCommit", () => {
    it("maps a commit by SHA", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          sha: "abc123def",
          html_url: "https://github.com/org/repo/commit/abc123def",
          author: { login: "alice" },
          commit: {
            message: "fix: the thing",
            author: { name: "Alice", date: "2026-03-01T00:00:00Z" },
            committer: { name: "Alice", date: "2026-03-02T00:00:00Z" },
          },
        }),
      );

      const commit = await fetchRelatedCommit("org/repo", "abc123def");

      expect(commit.kind).toBe("commit");
      expect(commit.sha).toBe("abc123def");
      expect(commit.message).toBe("fix: the thing");
      expect(commit.author).toBe("alice");
      expect(commit.committedAt).toBe("2026-03-02T00:00:00Z");
      expect(commit.source).toBe("github-commit");
      expect(commit.evidenceKey).toBe("github:commit:org/repo@abc123def");
    });

    it("throws RelatedWorkNotFoundError on a 404", async () => {
      fetchSpy.mockResolvedValue(mockResponse({ message: "Not Found" }, { status: 404 }));

      const err = await fetchRelatedCommit("org/repo", "deadbeef").catch((e) => e);

      expect(err).toBeInstanceOf(RelatedWorkNotFoundError);
      expect(err.kind).toBe("commit");
      expect(err.ref).toBe("org/repo@deadbeef");
    });
  });

  describe("searchRelatedWork", () => {
    it("injects repo: scoping plus type and state qualifiers into the query", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ total_count: 0, items: [] }));

      await searchRelatedWork("org/repo", "auth bug", { type: "pr", state: "open" });

      const url = new URL(String(fetchSpy.mock.calls[0]![0]));
      expect(url.searchParams.get("q")).toBe("auth bug repo:org/repo is:pr is:open");
    });

    it("omits type and state qualifiers by default (all)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ total_count: 0, items: [] }));

      await searchRelatedWork("org/repo", "auth bug");

      const url = new URL(String(fetchSpy.mock.calls[0]![0]));
      expect(url.searchParams.get("q")).toBe("auth bug repo:org/repo");
    });

    it("caps results at maxResults", async () => {
      const items = Array.from({ length: 15 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
        state: "open",
        html_url: `https://github.com/org/repo/issues/${i + 1}`,
        repository: { full_name: "org/repo" },
      }));
      fetchSpy.mockResolvedValueOnce(mockResponse({ total_count: 15, items }));

      const hits = await searchRelatedWork("org/repo", "bug", { maxResults: 5 });

      expect(hits).toHaveLength(5);
      expect(hits[0].kind).toBe("issue");
      expect(hits[0].evidenceKey).toBe("github:issue:org/repo#1");
    });

    it("derives kind from the pull_request marker and collapses merged PRs to 'merged'", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          total_count: 3,
          items: [
            { number: 1, title: "an issue", state: "open", html_url: "https://github.com/org/repo/issues/1", repository: { full_name: "org/repo" } },
            { number: 2, title: "open pr", state: "open", html_url: "https://github.com/org/repo/pull/2", repository: { full_name: "org/repo" }, pull_request: { merged_at: null } },
            { number: 3, title: "merged pr", state: "closed", html_url: "https://github.com/org/repo/pull/3", repository: { full_name: "org/repo" }, pull_request: { merged_at: "2026-01-01T00:00:00Z" } },
          ],
        }),
      );

      const hits = await searchRelatedWork("org/repo", "x");

      expect(hits.map((h) => [h.kind, h.state, h.evidenceKey])).toEqual([
        ["issue", "open", "github:issue:org/repo#1"],
        ["pull_request", "open", "github:pr:org/repo#2"],
        ["pull_request", "merged", "github:pr:org/repo#3"],
      ]);
    });

    it("strips repo/org/owner/user/type/is qualifiers from the model query", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ total_count: 0, items: [] }));

      await searchRelatedWork(
        "org/repo",
        "fix repo:evil/repo org:evil user:evil owner:evil is:pr type:bug",
      );

      const url = new URL(String(fetchSpy.mock.calls[0]![0]));
      expect(url.searchParams.get("q")).toBe("fix repo:org/repo");
    });

    it("drops hits whose owning repository does not match", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          total_count: 2,
          items: [
            { number: 1, title: "ours", state: "open", html_url: "https://github.com/org/repo/issues/1", repository: { full_name: "org/repo" } },
            { number: 2, title: "theirs", state: "open", html_url: "https://github.com/evil/other/issues/2", repository: { full_name: "evil/other" } },
          ],
        }),
      );

      const hits = await searchRelatedWork("org/repo", "x");

      expect(hits).toHaveLength(1);
      expect(hits[0].evidenceKey).toBe("github:issue:org/repo#1");
    });
  });
});
