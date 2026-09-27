// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssue } from "@/types";
import { fetchIssue, fetchIssueNativeBlockers, fetchIssues } from "./github-issues";

const fetchWithRetry = vi.fn();
const fetchPaginated = vi.fn();

vi.mock("./github-auth", () => ({
  GITHUB_API: "https://api.github.com",
  getHeadersAsync: async () => ({}),
  fetchPaginated: (...args: unknown[]) => fetchPaginated(...args),
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
}));

const okJson = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const notOk = { ok: false, status: 404, json: async () => ({}), text: async () => "" };

function makeIssue(
  overrides: Partial<GitHubIssue> & { number: number },
): GitHubIssue {
  return {
    title: `issue ${overrides.number}`,
    body: null,
    state: "open",
    html_url: `https://github.com/acme/app/issues/${overrides.number}`,
    labels: [],
    assignees: [],
    comments: 0,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    closed_at: null,
    ...overrides,
  };
}

const blockedByUrl = (n: number) =>
  `https://api.github.com/repos/acme/app/issues/${n}/dependencies/blocked_by`;

beforeEach(() => {
  vi.clearAllMocks();
  // Silence the [dispatch] native blocked_by warn noise from failure paths.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("fetchIssues native blocker ingestion", () => {
  it("makes no blocked_by call and sets no nativeBlockedBy without includeNativeBlockers", async () => {
    fetchPaginated.mockResolvedValue([
      // blocked_by = 2 must NOT trigger a fetch while enrichment is off.
      makeIssue({ number: 1, issue_dependencies_summary: { blocked_by: 2, blocking: 0 } }),
      makeIssue({ number: 2, issue_dependencies_summary: { blocked_by: 0, blocking: 0 } }),
      makeIssue({ number: 3 }),
    ]);
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("/dependencies/blocked_by")) {
        throw new Error("blocked_by endpoint should not be called");
      }
      throw new Error("unexpected fetch");
    });

    const issues = await fetchIssues("acme/app");

    const blockedByCalls = fetchWithRetry.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/dependencies/blocked_by"),
    );
    expect(blockedByCalls).toHaveLength(0);
    for (const issue of issues) {
      expect((issue as any).nativeBlockedBy).toBeUndefined();
    }
    expect(issues).toHaveLength(3);
  });

  it("with includeNativeBlockers, skips the call for zero/absent summaries and fetches once for blockers", async () => {
    fetchPaginated.mockResolvedValue([
      makeIssue({ number: 5, issue_dependencies_summary: { blocked_by: 1, blocking: 0 } }),
      makeIssue({ number: 6, issue_dependencies_summary: { blocked_by: 0, blocking: 0 } }),
      makeIssue({ number: 7 }),
    ]);
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("/dependencies/blocked_by")) {
        return okJson([
          {
            number: 7,
            repository_url: "https://api.github.com/repositories/123",
            html_url: "https://github.com/acme/other/issues/7",
          },
        ]);
      }
      throw new Error("unexpected fetch");
    });

    const issues = await fetchIssues("acme/app", { includeNativeBlockers: true });

    const blockedByCalls = fetchWithRetry.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/dependencies/blocked_by"),
    );
    expect(blockedByCalls).toHaveLength(1);
    expect(blockedByCalls[0][0]).toBe(blockedByUrl(5));

    expect(issues.find((i) => i.number === 5)?.nativeBlockedBy).toEqual(["acme/other#7"]);
    expect(issues.find((i) => i.number === 6)?.nativeBlockedBy).toEqual([]);
    expect(issues.find((i) => i.number === 7)?.nativeBlockedBy).toEqual([]);
  });
});

describe("fetchIssueNativeBlockers", () => {
  it("skips PR items and unparseable items, and dedupes", async () => {
    fetchWithRetry.mockResolvedValue(
      okJson([
        // html_url is slug form; repository_url is the id form (no slug).
        {
          number: 7,
          repository_url: "https://api.github.com/repositories/123",
          html_url: "https://github.com/acme/other/issues/7",
        },
        {
          number: 8,
          repository_url: "https://api.github.com/repositories/456",
          html_url: "https://github.com/acme/other/issues/8",
          pull_request: { url: "https://api.github.com/repos/acme/other/pull/8" },
        },
        // id-form repository_url only, no html_url → unparseable, dropped.
        { number: 9, repository_url: "https://api.github.com/repositories/789" },
        {
          number: 7,
          repository_url: "https://api.github.com/repositories/123",
          html_url: "https://github.com/acme/other/issues/7",
        },
        {
          number: 0,
          repository_url: "https://api.github.com/repositories/123",
          html_url: "https://github.com/acme/other/issues/0",
        },
      ]),
    );

    const keys = await fetchIssueNativeBlockers("acme/app", 1);

    expect(keys).toEqual(["acme/other#7"]);
  });

  it("returns null when the response is not ok", async () => {
    fetchWithRetry.mockResolvedValue(notOk);

    expect(await fetchIssueNativeBlockers("acme/app", 1)).toBeNull();
  });

  it("returns null when fetchWithRetry throws", async () => {
    fetchWithRetry.mockRejectedValue(new Error("network down"));

    expect(await fetchIssueNativeBlockers("acme/app", 1)).toBeNull();
  });

  it("returns [] when the response is ok with an empty list", async () => {
    fetchWithRetry.mockResolvedValue(okJson([]));

    expect(await fetchIssueNativeBlockers("acme/app", 1)).toEqual([]);
  });
});

describe("fetchIssue enrichment opt-in", () => {
  it("does not call blocked_by without the flag", async () => {
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("/dependencies/blocked_by")) {
        throw new Error("blocked_by endpoint should not be called");
      }
      return okJson(makeIssue({ number: 4 }));
    });

    const issue = await fetchIssue("acme/app", 4);

    expect(issue.number).toBe(4);
    expect(issue.nativeBlockedBy).toBeUndefined();
    const blockedByCalls = fetchWithRetry.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/dependencies/blocked_by"),
    );
    expect(blockedByCalls).toHaveLength(0);
  });

  it("attaches nativeBlockedBy when the flag is set and the fetch succeeds", async () => {
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("/dependencies/blocked_by")) {
        return okJson([
          {
            number: 7,
            repository_url: "https://api.github.com/repositories/123",
            html_url: "https://github.com/acme/other/issues/7",
          },
        ]);
      }
      return okJson(makeIssue({ number: 4 }));
    });

    const issue = await fetchIssue("acme/app", 4, { includeNativeBlockedBy: true });

    expect(issue.nativeBlockedBy).toEqual(["acme/other#7"]);
    const blockedByCalls = fetchWithRetry.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/dependencies/blocked_by"),
    );
    expect(blockedByCalls).toHaveLength(1);
    expect(blockedByCalls[0][0]).toBe(blockedByUrl(4));
  });

  it("leaves nativeBlockedBy unset when the blocked_by call fails", async () => {
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("/dependencies/blocked_by")) {
        return notOk;
      }
      return okJson(makeIssue({ number: 4 }));
    });

    const issue = await fetchIssue("acme/app", 4, { includeNativeBlockedBy: true });

    expect(issue.number).toBe(4);
    expect((issue as any).nativeBlockedBy).toBeUndefined();
  });
});
