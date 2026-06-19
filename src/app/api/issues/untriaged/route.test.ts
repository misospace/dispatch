import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
  },
}));

vi.mock("@/types", () => ({
  STATUS_LABELS: ["status/backlog", "status/ready", "status/in-progress", "status/in-review", "status/done"],
  AGENT_PREFIX: "agent/",
  OWNER_PREFIX: "owner/",
  isAgentLabel: (label: string) => label.startsWith("agent/"),
  isOwnerLabel: (label: string) => label.startsWith("owner/"),
}));

vi.mock("@/lib/agent-queue", () => ({
  isRenovateIssue: vi.fn(() => false),
}));

import { GET } from "./route";

function request(urlString: string) {
  return new Request(urlString, { headers: {} });
}

describe("GET /api/issues/untriaged", () => {
  // NOTE: This route is intentionally unauthenticated. It returns open issues
  // with no status/* label to any caller. This is an intake view for grooming.
  // In production deployments behind a firewall or auth gateway this is acceptable.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issueFindMany.mockResolvedValue([]);
  });

  it("returns untriaged issues without authentication", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "i1",
        number: 42,
        title: "New feature",
        url: "https://github.com/org/repo/issues/42",
        labels: ["enhancement"],
        state: "open",
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(request("http://localhost/api/issues/untriaged"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ number: 42, title: "New feature" });
  });

  it("excludes issues with status labels", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "i1",
        number: 1,
        title: "Triaged issue",
        url: "https://github.com/org/repo/issues/1",
        labels: ["status/backlog"],
        state: "open",
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { fullName: "org/repo" },
      },
      {
        id: "i2",
        number: 2,
        title: "Untriaged issue",
        url: "https://github.com/org/repo/issues/2",
        labels: ["enhancement"],
        state: "open",
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(request("http://localhost/api/issues/untriaged"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].number).toBe(2);
  });

  it("defaults to limit 50", async () => {
    mocks.issueFindMany.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({
      id: `i${i}`,
      number: i,
      title: `Issue ${i}`,
      url: `https://github.com/org/repo/issues/${i}`,
      labels: [],
      state: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
      repository: { fullName: "org/repo" },
    })));

    const res = await GET(request("http://localhost/api/issues/untriaged"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(50);
  });

  it("caps limit at 200", async () => {
    mocks.issueFindMany.mockResolvedValue(Array.from({ length: 300 }, (_, i) => ({
      id: `i${i}`,
      number: i,
      title: `Issue ${i}`,
      url: `https://github.com/org/repo/issues/${i}`,
      labels: [],
      state: "open",
      createdAt: new Date(),
      updatedAt: new Date(),
      repository: { fullName: "org/repo" },
    })));

    const res = await GET(request("http://localhost/api/issues/untriaged?limit=500"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(200);
  });

  it("filters by repo when repo param is provided", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "i1",
        number: 1,
        title: "Issue in repo A",
        url: "https://github.com/org/repoA/issues/1",
        labels: [],
        state: "open",
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { fullName: "org/repoA" },
      },
      {
        id: "i2",
        number: 2,
        title: "Issue in repo B",
        url: "https://github.com/org/repoB/issues/2",
        labels: [],
        state: "open",
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { fullName: "org/repoB" },
      },
    ]);

    const res = await GET(request("http://localhost/api/issues/untriaged?repo=org/repoA"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].repository.fullName).toBe("org/repoA");
  });

  it("excludes closed issues", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "i1",
        number: 1,
        title: "Open issue",
        url: "https://github.com/org/repo/issues/1",
        labels: [],
        state: "open",
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { fullName: "org/repo" },
      },
      {
        id: "i2",
        number: 2,
        title: "Closed issue",
        url: "https://github.com/org/repo/issues/2",
        labels: [],
        state: "closed",
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { fullName: "org/repo" },
      },
    ]);

    await GET(request("http://localhost/api/issues/untriaged"));

    // The route only fetches open issues via Prisma where clause
    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.where.state).toBe("open");
  });

  it("returns 500 on database error", async () => {
    mocks.issueFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/issues/untriaged"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch untriaged issues");
  });
});
