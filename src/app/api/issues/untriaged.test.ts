// @vitest-environment node
import { describe, expect, it, beforeEach, vi } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

// Mock prisma FIRST — simulate Prisma's where/orderBy behavior
interface MockIssue {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  labels?: string[];
  state?: string;
  createdAt?: Date;
  updatedAt?: Date;
  repository?: { fullName: string };
}
let mockFindManyData: MockIssue[] = [];
vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findMany: vi.fn((args?: { where?: Record<string, unknown>; orderBy?: Record<string, string> }) => {
        // Simulate Prisma state filter (where.state === "open")
        let results = mockFindManyData.filter((i) => i.state === "open");

        // Simulate Prisma repo filter (where.repository.fullName)
        if (args?.where?.repository && typeof args.where.repository === "object" && "fullName" in args.where.repository) {
          const repoName = (args.where.repository as Record<string, string>).fullName;
          results = results.filter((i) => i.repository?.fullName === repoName);
        }

        // Simulate Prisma orderBy (updatedAt: "desc")
        if (args?.orderBy?.updatedAt === "desc") {
          results.sort((a, b) => (b.updatedAt ?? new Date(0)).getTime() - (a.updatedAt ?? new Date(0)).getTime());
        }

        return Promise.resolve(results);
      }),
    },
  },
}));

vi.doMock("@/lib/agent-queue", () => ({
  isRenovateIssue: vi.fn((issue: { title: string; labels: string[] }) => {
    const title = issue.title.toLowerCase();
    return title.includes("dependency dashboard") || title.includes("renovate dashboard");
  }),
}));

vi.doMock("@/types", () => ({
  STATUS_LABELS: ["status/backlog", "status/ready", "status/in-progress", "status/in-review", "status/done"],
  PRIORITY_LABELS: ["priority/p0", "priority/p1", "priority/p2", "priority/p3"],
  AGENT_PREFIX: "agent/",
  OWNER_PREFIX: "owner/",
  PROJECT_PREFIX: "project/",
  BOARD_COLUMNS: [
    { id: "status/backlog" },
    { id: "status/ready" },
    { id: "status/in-progress" },
    { id: "status/in-review" },
    { id: "status/done" },
  ],
  VALID_LANES: ["normal", "escalated", "backlog"],
  VALID_CONFIDENCE: ["high", "medium", "low"],
  isAgentLabel: (label: string) => label.startsWith("agent/"),
  isOwnerLabel: (label: string) => label.startsWith("owner/"),
  getStatusFromLabels: (_labels: string[]) => null,
  getAgentFromLabels: (_labels: string[]) => null,
  getOwnerFromLabels: (_labels: string[]) => null,
  getPriorityFromLabels: (_labels: string[]) => null,
}));

// Dynamic imports after doMock setup.
const { prisma } = await import("@/lib/prisma");
const { resetAuthCaches } = await import("@/lib/auth");
const mockFindMany = vi.mocked(prisma.issue.findMany);

// Import route AFTER all mocks are set up
import { GET } from "./untriaged/route";

const makeIssue = (overrides: Partial<MockIssue> = {}) => ({
  id: overrides.id ?? "issue_1",
  number: overrides.number ?? 1,
  title: overrides.title ?? "Test issue",
  url: overrides.url ?? "https://github.com/test/repo/issues/1",
  labels: overrides.labels ?? [],
  state: overrides.state ?? "open",
  createdAt: overrides.createdAt ?? new Date("2026-01-01"),
  updatedAt: overrides.updatedAt ?? new Date("2026-01-01"),
  repository: { fullName: overrides.repository?.fullName ?? "test/repo" },
}) satisfies MockIssue;

function request(urlString: string, includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return new Request(urlString, { headers });
}

beforeEach(() => {
  delete process.env.DISPATCH_AUTH_MODE;
  resetAuthCaches();
  vi.clearAllMocks();
  mockFindManyData = [];
});

describe("GET /api/issues/untriaged", () => {
  it("returns 401 without authentication", async () => {
    const response = await GET(request("http://localhost/api/issues/untriaged", false));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns only issues with no status/* label", async () => {
    mockFindManyData = [
      makeIssue({ number: 1, labels: ["bug", "priority/p1"] }), // untriaged
      makeIssue({ number: 2, labels: ["status/ready", "priority/p1"] }), // has status — excluded
      makeIssue({ number: 3, labels: ["priority/p2"] }), // untriaged
      makeIssue({ number: 4, labels: ["status/backlog"] }), // has status — excluded
    ];

    const response = await GET(request("http://localhost/api/issues/untriaged"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body.map((i: { number: number }) => i.number)).toEqual([1, 3]);
  });


  it("excludes closed issues", async () => {
    mockFindManyData = [
      makeIssue({ number: 1, labels: ["bug"], state: "open" }),
      makeIssue({ number: 2, labels: ["bug"], state: "closed" }),
    ];

    const response = await GET(request("http://localhost/api/issues/untriaged"));
    const body = await response.json();

    expect(body).toHaveLength(1);
    expect(body[0].number).toBe(1);
  });


  it("excludes issues with any status label", async () => {
    mockFindManyData = [
      makeIssue({ number: 1, labels: ["status/done"] }),
      makeIssue({ number: 2, labels: ["status/in-progress"] }),
      makeIssue({ number: 3, labels: ["status/in-review"] }),
      makeIssue({ number: 4, labels: [] }), // truly unlabelled — should be included
    ];

    const response = await GET(request("http://localhost/api/issues/untriaged"));
    const body = await response.json();

    expect(body).toHaveLength(1);
    expect(body[0].number).toBe(4);
  });


  it("respects limit parameter (default 50)", async () => {
    mockFindManyData = Array.from({ length: 100 }, (_, i) => makeIssue({ number: i + 1, labels: ["bug"] }));

    const response = await GET(request("http://localhost/api/issues/untriaged"));
    const body = await response.json();

    expect(body).toHaveLength(50); // default limit
  });


  it("respects custom limit parameter", async () => {
    mockFindManyData = Array.from({ length: 100 }, (_, i) => makeIssue({ number: i + 1, labels: ["bug"] }));

    const response = await GET(request("http://localhost/api/issues/untriaged?limit=10"));
    const body = await response.json();

    expect(body).toHaveLength(10);
  });


  it("caps limit at 200", async () => {
    mockFindManyData = Array.from({ length: 500 }, (_, i) => makeIssue({ number: i + 1, labels: ["bug"] }));

    const response = await GET(request("http://localhost/api/issues/untriaged?limit=999"));
    const body = await response.json();

    expect(body).toHaveLength(200); // hard cap
  });


  it("filters by repo when specified", async () => {
    mockFindManyData = [
      makeIssue({ number: 1, labels: ["bug"], repository: { fullName: "test/repo" } }),
      makeIssue({ number: 2, labels: ["bug"], repository: { fullName: "other/repo" } }),
    ];

    const response = await GET(request("http://localhost/api/issues/untriaged?repo=test/repo"));
    const body = await response.json();

    expect(body).toHaveLength(1);
    expect(body[0].number).toBe(1);
  });


  it("excludes Renovate issues by default", async () => {
    mockFindManyData = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["bug"] }),
      makeIssue({ number: 2, title: "Fix critical bug", labels: ["bug"] }),
    ];

    const response = await GET(request("http://localhost/api/issues/untriaged"));
    const body = await response.json();

    expect(body).toHaveLength(1);
    expect(body[0].number).toBe(2);
  });


  it("includes Renovate issues when excludeRenovate=false", async () => {
    mockFindManyData = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["bug"] }),
      makeIssue({ number: 2, title: "Fix critical bug", labels: ["bug"] }),
    ];

    const response = await GET(request("http://localhost/api/issues/untriaged?excludeRenovate=false"));
    const body = await response.json();

    expect(body).toHaveLength(2);
  });


  it("returns empty array when no untriaged issues exist", async () => {
    mockFindManyData = [
      makeIssue({ number: 1, labels: ["status/ready"] }),
      makeIssue({ number: 2, labels: ["status/backlog"] }),
    ];

    const response = await GET(request("http://localhost/api/issues/untriaged"));
    const body = await response.json();

    expect(body).toEqual([]);
  });


  it("returns correct issue shape with all fields", async () => {
    mockFindManyData = [makeIssue({ number: 42, title: "Untriaged bug", labels: ["bug"] })];

    const response = await GET(request("http://localhost/api/issues/untriaged"));
    const body = await response.json();

    expect(body).toHaveLength(1);
    const issue = body[0];
    expect(issue).toHaveProperty("id");
    expect(issue).toHaveProperty("number", 42);
    expect(issue).toHaveProperty("title", "Untriaged bug");
    expect(issue).toHaveProperty("url");
    expect(issue).toHaveProperty("labels");
    expect(issue).toHaveProperty("state", "open");
    expect(issue).toHaveProperty("repository", { fullName: "test/repo" });
  });


  it("orders by updatedAt descending", async () => {
    const baseDate = new Date("2026-01-01");
    mockFindManyData = [
      makeIssue({ number: 1, labels: ["bug"], updatedAt: new Date(baseDate.getTime() + 1000) }),
      makeIssue({ number: 2, labels: ["bug"], updatedAt: baseDate }),
      makeIssue({ number: 3, labels: ["bug"], updatedAt: new Date(baseDate.getTime() + 2000) }),
    ];

    const response = await GET(request("http://localhost/api/issues/untriaged"));
    const body = await response.json();

    expect(body.map((i: { number: number }) => i.number)).toEqual([3, 1, 2]);
  });
});
