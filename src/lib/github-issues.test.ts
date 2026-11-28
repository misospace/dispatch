// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssue } from "@/types";
import { fetchCollaboratorPermission, fetchIssue, fetchIssueLabels, fetchIssueNativeBlockers, fetchIssues, fetchReopenAfter, repoLabelExists } from "./github-issues";

const fetchWithRetry = vi.fn();
const fetchPaginated = vi.fn();

vi.mock("./github-auth", () => ({
  GITHUB_API: "https://api.github.com",
  getHeadersAsync: async () => ({}),
  fetchPaginated: (...args: unknown[]) => fetchPaginated(...args),
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
  getNextLink: (response: { headers: { get(name: string): string | null } }) => {
    const match = response.headers.get("Link")?.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  },
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
  `https://api.github.com/repos/acme/app/issues/${n}/dependencies/blocked_by?per_page=100`;

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
    // No summary → unknown, not none: nativeBlockedBy must stay unset.
    expect(issues.find((i) => i.number === 7)?.nativeBlockedBy).toBeUndefined();
  });

  it("treats absent and null issue_dependencies_summary as unknown (no call, no nativeBlockedBy)", async () => {
    fetchPaginated.mockResolvedValue([
      // No issue_dependencies_summary field at all.
      makeIssue({ number: 10 }),
      // Explicit null summary.
      makeIssue({ number: 11, issue_dependencies_summary: null }),
    ]);
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("/dependencies/blocked_by")) {
        throw new Error("blocked_by endpoint should not be called");
      }
      throw new Error("unexpected fetch");
    });

    const issues = await fetchIssues("acme/app", { includeNativeBlockers: true });

    const blockedByCalls = fetchWithRetry.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/dependencies/blocked_by"),
    );
    expect(blockedByCalls).toHaveLength(0);
    for (const issue of issues) {
      expect((issue as any).nativeBlockedBy).toBeUndefined();
    }
    expect(issues).toHaveLength(2);
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

  it("returns null when the response body is not an array", async () => {
    fetchWithRetry.mockResolvedValue(okJson({ message: "not an array" }));

    expect(await fetchIssueNativeBlockers("acme/app", 1)).toBeNull();
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

describe("fetchIssueLabels", () => {
  it("paginates to the end so a label past the first 100 is still seen", async () => {
    // Regression (review round 4, M3): a first-100 read could miss the single
    // agent label on a heavily labeled issue and break the enforced
    // single-agent-label invariant.
    fetchPaginated.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({ name: i === 100 ? "agent/foo" : `filler/${i}` })),
    );

    const labels = await fetchIssueLabels("acme/app", 9);

    expect(fetchPaginated).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/issues/9/labels?per_page=100",
    );
    expect(labels).toHaveLength(101);
    expect(labels?.at(-1)).toBe("agent/foo");
  });

  it("returns null when a page fetch throws", async () => {
    fetchPaginated.mockRejectedValue(new Error("GitHub API error: 502"));

    expect(await fetchIssueLabels("acme/app", 9)).toBeNull();
  });

  it("drops entries with a non-string name", async () => {
    fetchPaginated.mockResolvedValue([{ name: "status/ready" }, {}, { name: 7 }]);

    expect(await fetchIssueLabels("acme/app", 9)).toEqual(["status/ready"]);
  });
});

describe("fetchCollaboratorPermission", () => {
  it("prefers role_name when the permission field reports maintainers as write", async () => {
    // Regression (review round 4, M2): GitHub's collaborator-permission API
    // reports the maintain role through role_name while `permission` says
    // "write", so requiring permission === "maintain" rejected real maintainers.
    fetchWithRetry.mockResolvedValue(okJson({ permission: "write", role_name: "maintain" }));

    expect(await fetchCollaboratorPermission("acme/app", "maintainer")).toEqual({
      status: "ok",
      permission: "maintain",
    });
  });

  it("falls back to the permission field when role_name is absent", async () => {
    fetchWithRetry.mockResolvedValue(okJson({ permission: "write" }));

    expect(await fetchCollaboratorPermission("acme/app", "writer")).toEqual({
      status: "ok",
      permission: "write",
    });
  });

  it("falls back to the permission field for a custom role_name (org with custom roles)", async () => {
    fetchWithRetry.mockResolvedValue(okJson({ permission: "admin", role_name: "security_manager" }));

    expect(await fetchCollaboratorPermission("acme/app", "admin")).toEqual({
      status: "ok",
      permission: "admin",
    });
  });

  it("recognizes a custom-role maintainer through the user.permissions booleans", async () => {
    fetchWithRetry.mockResolvedValue(
      okJson({
        permission: "write",
        role_name: "security_manager",
        user: { login: "maintainer", permissions: { admin: false, maintain: true } },
      }),
    );

    expect(await fetchCollaboratorPermission("acme/app", "maintainer")).toEqual({
      status: "ok",
      permission: "maintain",
    });
  });

  it("prefers user.permissions.admin over a lower role_name", async () => {
    fetchWithRetry.mockResolvedValue(
      okJson({
        permission: "write",
        role_name: "maintain",
        user: { login: "owner", permissions: { admin: true, maintain: true } },
      }),
    );

    expect(await fetchCollaboratorPermission("acme/app", "owner")).toEqual({
      status: "ok",
      permission: "admin",
    });
  });

  it("returns an error when neither field carries a recognized permission", async () => {
    fetchWithRetry.mockResolvedValue(okJson({ permission: "banana", role_name: 42 }));

    const result = await fetchCollaboratorPermission("acme/app", "odd");
    expect(result.status).toBe("error");
  });

  it("returns an error for an unrecognized custom role_name with an unparseable permission", async () => {
    fetchWithRetry.mockResolvedValue(
      okJson({ role_name: "security_manager", user: { permissions: { admin: false, maintain: false } } }),
    );

    const result = await fetchCollaboratorPermission("acme/app", "odd");
    expect(result.status).toBe("error");
  });
});

describe("repoLabelExists", () => {
  it("returns true for an existing label (200)", async () => {
    fetchWithRetry.mockResolvedValue(okJson({ name: "agent/courier-hyper" }));
    await expect(repoLabelExists("acme/app", "agent/courier-hyper")).resolves.toBe(true);
    expect(fetchWithRetry.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/acme/app/labels/agent%2Fcourier-hyper",
    );
  });

  it("returns false for a missing label (404) — not an error", async () => {
    fetchWithRetry.mockResolvedValue({ ok: false, status: 404, text: async () => "Not Found" });
    await expect(repoLabelExists("acme/app", "agent/courier-missing")).resolves.toBe(false);
  });

  it("returns null (unavailable) on an API error — never false", async () => {
    fetchWithRetry.mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });
    await expect(repoLabelExists("acme/app", "agent/courier-hyper")).resolves.toBeNull();
  });

  it("returns null on a network failure", async () => {
    fetchWithRetry.mockRejectedValue(new Error("socket hang up"));
    await expect(repoLabelExists("acme/app", "agent/courier-hyper")).resolves.toBeNull();
  });
});

describe("fetchReopenAfter", () => {
  const since = new Date("2026-10-02T08:00:00Z");
  const timelineUrl = `https://api.github.com/repos/acme/app/issues/42/timeline?since=${since.toISOString()}&per_page=100`;
  const okTimeline = (data: unknown, nextUrl?: string) => ({
    ok: true,
    status: 200,
    json: async () => data,
    headers: {
      get: (name: string) =>
        name === "Link" && nextUrl ? `<${nextUrl}>; rel="next"` : null,
    },
  });

  it("returns the latest reopened activity strictly after `since`, ignoring other events", async () => {
    fetchWithRetry.mockResolvedValue(okTimeline([
      { event: "reopened", created_at: "2026-09-01T00:00:00Z" },
      { event: "commented", created_at: "2026-10-04T00:00:00Z" },
      { event: "reopened", created_at: "2026-10-03T00:00:00Z" },
      { event: "reopened", created_at: "2026-10-05T00:00:00Z" },
    ]));

    const result = await fetchReopenAfter("acme/app", 42, since);

    expect(fetchWithRetry.mock.calls[0][0]).toBe(timelineUrl);
    expect(result).toEqual(new Date("2026-10-05T00:00:00Z"));
  });

  it("returns null when the read holds no reopened activity after `since`", async () => {
    fetchWithRetry.mockResolvedValue(okTimeline([
      { event: "reopened", created_at: "2026-10-02T08:00:00Z" },
      { event: "labeled", created_at: "2026-10-04T00:00:00Z" },
      { event: "reopened" },
    ]));

    await expect(fetchReopenAfter("acme/app", 42, since)).resolves.toBeNull();
  });

  it("follows rel=next pages until the end", async () => {
    fetchWithRetry
      .mockResolvedValueOnce(okTimeline([{ event: "commented", created_at: "2026-10-03T00:00:00Z" }], "https://api.github.com/page-2"))
      .mockResolvedValueOnce(okTimeline([{ event: "reopened", created_at: "2026-10-06T00:00:00Z" }]));

    const result = await fetchReopenAfter("acme/app", 42, since);

    expect(result).toEqual(new Date("2026-10-06T00:00:00Z"));
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(fetchWithRetry.mock.calls[1][0]).toBe("https://api.github.com/page-2");
  });

  it("throws on a failed page — an unreadable timeline never proves 'no reopen'", async () => {
    fetchWithRetry.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    await expect(fetchReopenAfter("acme/app", 42, since)).rejects.toThrow(/403/);
  });

  it("throws when the timeline exceeds the bounded page window", async () => {
    fetchWithRetry.mockResolvedValue(okTimeline([], "https://api.github.com/next"));

    await expect(fetchReopenAfter("acme/app", 42, since)).rejects.toThrow(/bounded reopen-confirmation window/);
    expect(fetchWithRetry).toHaveBeenCalledTimes(5);
  });
});
