import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn(),
    prFixFindMany: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    prFixQueueItem: { findMany: mocks.prFixFindMany },
  },
  asPrFixQueueClient: (client: any) => client,
}));

import { GET } from "./route";

describe("GET /api/agents/[agentName]/queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prFixFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
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
        labels: ["priority/p0", "status/backlog"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/saffron/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "saffron" }),
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

    const res = await GET(new Request("http://localhost/api/agents/saffron/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "saffron" }),
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
        labels: [],
        currentLane: "escalated",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/saffron/queue?lane=escalated"), {
      params: Promise.resolve({ agentName: "saffron" }),
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
        labels: [],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/saffron/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "saffron" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].type).toBe("pr-review-fix");
    expect(body[1].type).toBe("issue");
  });

  it("excludes claimed issues by default", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-claimed",
        number: 52,
        title: "Claimed issue",
        url: "https://github.com/org/repo/issues/52",
        labels: ["agent/saffron", "status/backlog"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-unclaimed",
        number: 53,
        title: "Unclaimed issue",
        url: "https://github.com/org/repo/issues/53",
        labels: ["status/backlog"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/saffron/queue?lane=normal"), {
      params: Promise.resolve({ agentName: "saffron" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((item: { number: number }) => item.number)).toEqual([53]);
  });

  it("includes claimed issues when includeClaimed=true", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-claimed",
        number: 52,
        title: "Claimed issue",
        url: "https://github.com/org/repo/issues/52",
        labels: ["agent/saffron", "status/backlog"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/agents/saffron/queue?lane=normal&includeClaimed=true"), {
      params: Promise.resolve({ agentName: "saffron" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toMatchObject({ number: 52, agentMatch: true });
  });
});
