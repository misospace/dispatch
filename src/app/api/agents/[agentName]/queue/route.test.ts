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
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/backlog"],
        currentLane: "normal",
        decomposed: false,
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
});
