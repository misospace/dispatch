import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn(),
    prFixFindMany: vi.fn(),
    findLeasedIssueIds: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    prFixQueueItem: { findMany: mocks.prFixFindMany },
  },
  asPrFixQueueClient: (client: any) => client,
}));

vi.mock("@/lib/lease", () => ({
  findLeasedIssueIds: mocks.findLeasedIssueIds,
}));

import { GET } from "./route";

describe("GET /api/agents/[agentName]/queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prFixFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.findLeasedIssueIds.mockResolvedValue([]);
  });

  it("prioritizes queued PR review-fix items before new issue work", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: 67,
        branch: "fix/issue-67",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix issue 67",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["please update tests"],
        evidenceKeys: ["review:1"],
        author: "itsmiso-ai",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-abc",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toMatchObject({ type: "pr-review-fix", repo: "org/repo", pr: 12 });
    expect(body[1]).toMatchObject({ number: 99, title: "Regular issue" });
    expect(mocks.prFixFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "QUEUED", lane: "NORMAL" }) }));
  });

  it("returns issueId and repoFullName on issue items", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-def",
        number: 50,
        title: "Another issue",
        url: "https://github.com/org/repo/issues/50",
        labels: ["priority/p1"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toHaveProperty("issueId", "issue-def");
    expect(body[0]).toHaveProperty("repoFullName", "org/repo");
  });

  it("returns type: issue on issue items", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-ghi",
        number: 51,
        title: "Test issue",
        url: "https://github.com/org/repo/issues/51",
        labels: ["priority/p1"],
        currentLane: "escalated",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=escalated"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toHaveProperty("type", "issue");
  });

  it("keeps PR-fix items first when both types are present", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-2",
        repo: "org/repo",
        pr: 20,
        issue: 10,
        branch: "fix/issue-10",
        url: "https://github.com/org/repo/pull/20",
        title: "Fix PR",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review requested",
        feedback: [],
        evidenceKeys: [],
        author: "bot",
        queuedAt: new Date("2026-01-02T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-jkl",
        number: 5,
        title: "Issue work",
        url: "https://github.com/org/repo/issues/5",
        labels: ["enhancement"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].type).toBe("pr-review-fix");
    expect(body[1].type).toBe("issue");
  });

  it("includes same-agent claimed issues by default and excludes unlabelled orphans", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-claimed",
        number: 52,
        title: "Claimed issue",
        url: "https://github.com/org/repo/issues/52",
        labels: ["agent/example-agent"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-unclaimed",
        number: 53,
        title: "Unclaimed issue",
        url: "https://github.com/org/repo/issues/53",
        labels: [],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Same-agent claimed work is now included (fix #291), unlabelled orphans are excluded
    expect(body.map((item: { number: number }) => item.number)).toEqual([52]);
  });

  it("includes claimed issues when includeClaimed=true", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-claimed",
        number: 52,
        title: "Claimed issue",
        url: "https://github.com/org/repo/issues/52",
        labels: ["agent/example-agent"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal&includeClaimed=true"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toMatchObject({ number: 52, agentMatch: true });
  });

  // ── Lease-aware filtering tests (issue #166) ───────────────────────

  it("excludes issues leased by other agents", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-leased",
        number: 54,
        title: "Leased issue",
        url: "https://github.com/org/repo/issues/54",
        labels: ["agent/opencode"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-open",
        number: 55,
        title: "Open issue",
        url: "https://github.com/org/repo/issues/55",
        labels: ["bug"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);
    // issue-leased is leased by another agent
    mocks.findLeasedIssueIds.mockResolvedValue(["issue-leased"]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((item: { number: number }) => item.number)).toEqual([55]);
  });

  it("includes issues when the requesting agent holds the lease", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-my-lease",
        number: 56,
        title: "My leased issue",
        url: "https://github.com/org/repo/issues/56",
        labels: ["agent/example-agent"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);
    // example-agent holds the lease, so findLeasedIssueIds returns empty for them
    mocks.findLeasedIssueIds.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal&includeClaimed=true"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((item: { number: number }) => item.number)).toEqual([56]);
  });

  it("calls findLeasedIssueIds with the requesting agent name", async () => {
    mocks.issueFindMany.mockResolvedValue([]);

    await GET(new Request("http://localhost/api/agents/saffron/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "saffron" }),
    });

    expect(mocks.findLeasedIssueIds).toHaveBeenCalledWith("saffron");
  });

  // ── Renovate exclusion tests ──────────────────────────────────────

  it("excludes Renovate issues from agent queue by default", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-renovate",
        number: 10,
        title: "Dependency Dashboard",
        url: "https://github.com/org/repo/issues/10",
        labels: ["priority/p1"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-normal",
        number: 20,
        title: "Fix login bug",
        url: "https://github.com/org/repo/issues/20",
        labels: ["priority/p1"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((item: { number: number }) => item.number)).toEqual([20]);
  });

  it("includes Renovate issues when includeRenovate=true", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-renovate",
        number: 10,
        title: "Dependency Dashboard",
        url: "https://github.com/org/repo/issues/10",
        labels: ["priority/p1"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-normal",
        number: 20,
        title: "Fix login bug",
        url: "https://github.com/org/repo/issues/20",
        labels: ["priority/p1"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal&includeRenovate=true"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const numbers = body.map((item: { number: number }) => item.number);
    expect(numbers).toContain(10);
    expect(numbers).toContain(20);
  });

  it("excludes Renovate issues with renovate label by default", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-renovate",
        number: 10,
        title: "Bump lodash",
        url: "https://github.com/org/repo/issues/10",
        labels: ["renovate"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-normal",
        number: 20,
        title: "Fix crash",
        url: "https://github.com/org/repo/issues/20",
        labels: ["bug"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((item: { number: number }) => item.number)).toEqual([20]);
  });

  it("excludes Renovate issues with Update dependency title by default", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-renovate",
        number: 10,
        title: "Update dependency lodash to v4.18.0",
        url: "https://github.com/org/repo/issues/10",
        labels: [],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-normal",
        number: 20,
        title: "Add dark mode",
        url: "https://github.com/org/repo/issues/20",
        labels: ["enhancement"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((item: { number: number }) => item.number)).toEqual([20]);
  });

  it("does not exclude non-Renovate issues", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-normal",
        number: 20,
        title: "Update README",
        url: "https://github.com/org/repo/issues/20",
        labels: ["documentation"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/example-agent/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((item: { number: number }) => item.number)).toEqual([20]);
  });
});
