import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks, STATUS_LABELS } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn().mockResolvedValue([]),
  },
  // Mirrors the real STATUS_LABELS (src/types/index.ts — BOARD_COLUMNS ids).
  STATUS_LABELS: [
    "status/backlog",
    "status/ready",
    "status/in-progress",
    "status/in-review",
    "status/blocked",
    "status/done",
  ],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
  },
}));

vi.mock("@/types", () => ({
  STATUS_LABELS,
  AGENT_PREFIX: "agent/",
  OWNER_PREFIX: "owner/",
  isAgentLabel: (label: string) => label.startsWith("agent/"),
  isOwnerLabel: (label: string) => label.startsWith("owner/"),
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { buildRenovateIssueExclusionWhere } from "@/lib/issue-filters";

function request(urlString: string, includeAuth = true) {
  return authedRequest(urlString, { includeAuth });
}

interface FakeIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  state: string;
  createdAt: Date;
  updatedAt: Date;
  repository: { fullName: string };
}

function makeIssue(number: number, overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: `i${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/org/repo/issues/${number}`,
    labels: [],
    state: "open",
    createdAt: new Date(),
    updatedAt: new Date(),
    repository: { fullName: "org/repo" },
    ...overrides,
  };
}

/**
 * Status labels the query excludes, read back out of the route's own `where`
 * clause. Returns null when the route stops asking for the exclusion at all —
 * the fake then stops hiding status-labelled rows, so the behavioural
 * assertion fails instead of silently passing.
 */
function excludedStatusLabels(where: Record<string, unknown> | undefined): string[] | null {
  const and = where?.AND;
  const clauses: unknown[] = Array.isArray(and) ? and : and ? [and] : [];

  for (const clause of clauses) {
    const not = (clause as { NOT?: { labels?: { hasSome?: unknown } } }).NOT;
    const hasSome = not?.labels?.hasSome;
    if (Array.isArray(hasSome)) return hasSome as string[];
  }
  return null;
}

/**
 * Fake Prisma `findMany` that honours the predicates the route pushes into
 * the query (no `status/*` label, repository filter) and the `take` cap, so
 * the route is exercised against query-shaped behaviour instead of an
 * unbounded in-memory result set.
 */
function fakeIssueFindMany(rows: FakeIssue[]) {
  mocks.issueFindMany.mockImplementation(
    async (args: { where?: Record<string, unknown>; take?: number }) => {
      const where = args.where ?? {};
      const repository = where.repository as { fullName?: string } | undefined;
      const statusLabels = excludedStatusLabels(where);

      let result = rows.filter(
        (row) => !statusLabels || !row.labels.some((label) => statusLabels.includes(label)),
      );
      if (repository?.fullName) {
        result = result.filter((row) => row.repository.fullName === repository.fullName);
      }
      if (typeof args.take === "number") {
        result = result.slice(0, args.take);
      }
      return result;
    },
  );
}

describe("GET /api/issues/untriaged", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.issueFindMany.mockResolvedValue([]);
  });

  it("returns 401 without authentication", async () => {
    const res = await GET(request("http://localhost/api/issues/untriaged", false));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
  });

  it("returns untriaged issues with authentication", async () => {
    fakeIssueFindMany([
      makeIssue(42, {
        title: "New feature",
        labels: ["enhancement"],
      }),
    ]);

    const res = await GET(request("http://localhost/api/issues/untriaged"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ number: 42, title: "New feature" });
  });

  it("excludes issues with status labels", async () => {
    fakeIssueFindMany([
      makeIssue(1, { title: "Triaged issue", labels: ["status/backlog"] }),
      makeIssue(2, { title: "Untriaged issue", labels: ["enhancement"] }),
    ]);

    const res = await GET(request("http://localhost/api/issues/untriaged"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].number).toBe(2);

    // The exclusion is a query predicate, so `take` stays exact.
    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.where.AND).toEqual(
      expect.arrayContaining([{ NOT: { labels: { hasSome: STATUS_LABELS } } }]),
    );
  });

  it("defaults to limit 50", async () => {
    fakeIssueFindMany(Array.from({ length: 100 }, (_, i) => makeIssue(i)));

    const res = await GET(request("http://localhost/api/issues/untriaged"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(50);

    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it("caps limit at 200", async () => {
    fakeIssueFindMany(Array.from({ length: 300 }, (_, i) => makeIssue(i)));

    const res = await GET(request("http://localhost/api/issues/untriaged?limit=500"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(200);

    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.take).toBe(200);
  });

  it("carries an explicit limit into the query", async () => {
    fakeIssueFindMany(Array.from({ length: 50 }, (_, i) => makeIssue(i)));

    const res = await GET(request("http://localhost/api/issues/untriaged?limit=10"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(10);

    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  it("falls back to the default on a non-numeric limit instead of erroring", async () => {
    fakeIssueFindMany(Array.from({ length: 100 }, (_, i) => makeIssue(i)));

    const res = await GET(request("http://localhost/api/issues/untriaged?limit=abc"));

    expect(res.status).toBe(200);
    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it("falls back to the default on a zero limit", async () => {
    fakeIssueFindMany(Array.from({ length: 100 }, (_, i) => makeIssue(i)));

    const res = await GET(request("http://localhost/api/issues/untriaged?limit=0"));

    expect(res.status).toBe(200);
    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it("falls back to the default on a negative limit", async () => {
    fakeIssueFindMany(Array.from({ length: 100 }, (_, i) => makeIssue(i)));

    const res = await GET(request("http://localhost/api/issues/untriaged?limit=-5"));

    expect(res.status).toBe(200);
    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it("never issues an unbounded query", async () => {
    fakeIssueFindMany(Array.from({ length: 100 }, (_, i) => makeIssue(i)));

    await GET(request("http://localhost/api/issues/untriaged"));

    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(typeof call.take).toBe("number");
    expect(call.take).toBeGreaterThan(0);
    expect(call.take).toBeLessThanOrEqual(200);
  });

  it("filters by repo when repo param is provided", async () => {
    fakeIssueFindMany([
      makeIssue(1, { title: "Issue in repo A", repository: { fullName: "org/repoA" } }),
      makeIssue(2, { title: "Issue in repo B", repository: { fullName: "org/repoB" } }),
    ]);

    const res = await GET(request("http://localhost/api/issues/untriaged?repo=org/repoA"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].repository.fullName).toBe("org/repoA");

    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.where.repository).toEqual({ enabled: true, fullName: "org/repoA" });
  });

  it("excludes closed issues", async () => {
    fakeIssueFindMany([makeIssue(1), makeIssue(2, { state: "closed" })]);

    await GET(request("http://localhost/api/issues/untriaged"));

    // The route only fetches open issues via Prisma where clause
    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.where.state).toBe("open");
  });

  it("excludes Renovate issues in the query", async () => {
    fakeIssueFindMany([makeIssue(1)]);

    await GET(request("http://localhost/api/issues/untriaged"));

    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.where.AND).toEqual(
      expect.arrayContaining([buildRenovateIssueExclusionWhere()]),
    );
  });

  it("keeps the Renovate exclusion out of the query when excludeRenovate=false", async () => {
    fakeIssueFindMany([makeIssue(1)]);

    await GET(request("http://localhost/api/issues/untriaged?excludeRenovate=false"));

    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.where.AND).not.toEqual(
      expect.arrayContaining([buildRenovateIssueExclusionWhere()]),
    );
    // The untriaged exclusion stays in place either way.
    expect(call.where.AND).toEqual(
      expect.arrayContaining([{ NOT: { labels: { hasSome: STATUS_LABELS } } }]),
    );
  });

  it("returns 500 on database error", async () => {
    mocks.issueFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/issues/untriaged"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch untriaged issues");
  });
});
