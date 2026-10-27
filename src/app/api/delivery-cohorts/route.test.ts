import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMockWithSafeEqual as makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    eventsFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    prFixItemFindMany: vi.fn(),
    agentRunFindMany: vi.fn(),
    auth: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    issueLifecycleEvent: { findMany: mocks.eventsFindMany },
    prFixQueueItem: { findMany: mocks.prFixItemFindMany },
    agentRun: { findMany: mocks.agentRunFindMany },
  },
}));

vi.mock("@/lib/auth-next", () => ({ auth: mocks.auth }));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const URL_ = "http://localhost/api/delivery-cohorts";
const SINCE = "2026-09-30T00:00:00.000Z";
const UNTIL = "2026-10-26T00:00:00.000Z";
const Q = `?since=${SINCE}&until=${UNTIL}`;

function asNextRequest(r: Request): any {
  return r;
}

function issue(over: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    number: 42,
    state: "closed",
    closedAt: new Date("2026-10-01T12:00:00.000Z"),
    labels: ["type/feature"],
    repository: { fullName: "org/repo" },
    ...over,
  };
}

function eventRow(over: Record<string, unknown> = {}) {
  return {
    id: "ev-1",
    issueId: "issue-1",
    kind: "claim",
    source: "api:claim",
    actor: "agent/alpha",
    agentName: "agent/alpha",
    fromStatus: "status/ready",
    toStatus: "status/in-progress",
    sourceEventId: null,
    occurredAt: new Date("2026-10-01T10:00:00.000Z"),
    observedAt: new Date("2026-10-01T10:00:00.000Z"),
    metadata: null,
    ...over,
  };
}

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    issueId: "issue-1",
    agentName: "agent/alpha",
    runType: "implement",
    status: "completed",
    startedAt: new Date("2026-10-01T10:10:00.000Z"),
    finishedAt: new Date("2026-10-01T11:00:00.000Z"),
    executionMetadata: null,
    prFixQueueItemId: null,
    prFixGeneration: null,
    ...over,
  };
}

const get = (query: string = Q, headers: Record<string, string> = {}) =>
  GET(asNextRequest(authedRequest(`${URL_}${query}`, { headers })));

beforeEach(() => {
  process.env.DISPATCH_AUTH_USERNAME = "jory";
  process.env.DISPATCH_AUTH_PASSWORD = "op-pass";
  process.env.DISPATCH_AUTH_MODE = "basic";
  resetAuthCaches();
  resetRateLimits();
  vi.clearAllMocks();
  mocks.eventsFindMany.mockImplementation(() => Promise.resolve([]));
  mocks.issueFindMany.mockImplementation(() => Promise.resolve([]));
  mocks.prFixItemFindMany.mockImplementation(() => Promise.resolve([]));
  mocks.agentRunFindMany.mockImplementation(() => Promise.resolve([]));
  mocks.auth.mockResolvedValue(null);
});

/** One merged cohort: claim T0, done/merge T0+2h, run with cohort+model metadata. */
function installMergedCohort() {
  const claim = new Date("2026-10-01T10:00:00.000Z");
  const done = new Date("2026-10-01T12:00:00.000Z");
  mocks.eventsFindMany.mockImplementation((args: any) => {
    if (args?.distinct) return Promise.resolve([{ issueId: "issue-1" }]);
    if (args?.where?.issueId) {
      return Promise.resolve([
        eventRow({ occurredAt: claim, observedAt: claim }),
        eventRow({
          id: "ev-2",
          kind: "completed",
          source: "api:tasks-report",
          fromStatus: "status/in-progress",
          toStatus: "status/done",
          occurredAt: done,
          observedAt: done,
        }),
        eventRow({
          id: "ev-3",
          kind: "pr_merged",
          source: "reconciler",
          actor: "reconciler",
          agentName: null,
          fromStatus: "status/in-review",
          toStatus: "status/done",
          sourceEventId: "pr-101",
          occurredAt: done,
          observedAt: done,
          metadata: {
            pullRequestNumber: 101,
            pullRequestUrl: "https://github.com/org/repo/pull/101",
          },
        }),
      ]);
    }
    return Promise.resolve([]);
  });
  mocks.issueFindMany.mockImplementation((args: any) => {
    if (args?.where?.id) return Promise.resolve([issue()]);
    return Promise.resolve([]);
  });
  mocks.agentRunFindMany.mockResolvedValue([
    runRow({
      startedAt: new Date("2026-10-01T10:10:00.000Z"),
      finishedAt: new Date("2026-10-01T11:00:00.000Z"),
      executionMetadata: { cohortLabel: "exp-xhigh", model: "gpt-5" },
    }),
  ]);
}

describe("GET /api/delivery-cohorts", () => {
  it("returns 401 without auth", async () => {
    const res = await GET(asNextRequest(new Request(`${URL_}${Q}`)));
    expect(res.status).toBe(401);
  });

  it("returns 400 for a bad groupBy, days, or since window", async () => {
    let res = await get(`${Q}&groupBy=bogus`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/groupBy/);

    res = await get("?days=0");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/days must be an integer between 1 and 365/);

    res = await get("?since=not-a-date&until=2026-10-26T00:00:00.000Z");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/since must be an ISO datetime/);

    res = await get("?since=2027-01-01T00:00:00.000Z");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/since must be before until/);
  });

  it("returns an empty report for an empty window", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema).toBe("dispatch.delivery-cohorts/v1");
    expect(body.groupBy).toBe("cohort");
    expect(body.window).toEqual({ since: SINCE, until: UNTIL });
    expect(body.cohorts).toEqual([]);
    expect(body.totals.sampleCount).toBe(0);
    expect(body.samples).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  it("builds one merged cohort with durations, throughput and first-pass evidence", async () => {
    installMergedCohort();

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.schema).toBe("dispatch.delivery-cohorts/v1");
    expect(body.definitions.units).toBe("milliseconds");
    expect(body.groupBy).toBe("cohort");
    expect(body.window).toEqual({ since: SINCE, until: UNTIL });
    expect(body.truncated).toBe(false);

    expect(body.cohorts).toHaveLength(1);
    expect(body.cohorts[0].key).toBe("exp-xhigh");
    expect(body.cohorts[0].sampleCount).toBe(1);
    expect(body.cohorts[0].delivery.merged).toBe(1);
    expect(body.cohorts[0].claimToDone.p50).toBe(2 * 3600000);
    expect(body.cohorts[0].mergedThroughputPerDay).toBeGreaterThan(0);

    expect(body.totals.sampleCount).toBe(1);
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].firstPass).toBe(true);
  });

  it("groups by taskType from the type/ label when requested", async () => {
    installMergedCohort();

    const res = await get(`${Q}&groupBy=taskType`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groupBy).toBe("taskType");
    expect(body.cohorts).toHaveLength(1);
    expect(body.cohorts[0].key).toBe("feature");
  });

  it("keeps an open item out of durations but in totals and openAges", async () => {
    mocks.eventsFindMany.mockImplementation((args: any) => {
      if (args?.distinct) return Promise.resolve([{ issueId: "issue-1" }]);
      if (args?.where?.issueId) return Promise.resolve([eventRow()]);
      return Promise.resolve([]);
    });
    mocks.issueFindMany.mockImplementation((args: any) => {
      if (args?.where?.id) return Promise.resolve([issue({ state: "open", closedAt: null })]);
      return Promise.resolve([]);
    });
    mocks.agentRunFindMany.mockResolvedValue([
      runRow({ executionMetadata: { cohortLabel: "B" } }),
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.cohorts).toHaveLength(1);
    expect(body.cohorts[0].key).toBe("B");
    expect(body.cohorts[0].delivery.open).toBe(1);
    expect(body.cohorts[0].claimToDone).toBeNull();
    expect(body.cohorts[0].openAges.count).toBe(1);
    expect(body.cohorts[0].completionRate).toBe(0);

    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].excludedFromDurations).toBe(true);
    expect(body.samples[0].ageMs).toBeGreaterThan(0);
  });

  it("scopes samples to the requested repo, case-insensitively", async () => {
    mocks.eventsFindMany.mockImplementation((args: any) => {
      if (args?.distinct) {
        return Promise.resolve([{ issueId: "issue-1" }, { issueId: "issue-2" }]);
      }
      if (args?.where?.issueId) {
        return Promise.resolve([eventRow(), eventRow({ id: "ev-2", issueId: "issue-2" })]);
      }
      return Promise.resolve([]);
    });
    mocks.issueFindMany.mockImplementation((args: any) => {
      if (args?.where?.id) {
        return Promise.resolve([
          issue(),
          issue({
            id: "issue-2",
            number: 43,
            state: "open",
            closedAt: null,
            labels: [],
            repository: { fullName: "Org/Other" },
          }),
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await get(`${Q}&repo=org/other`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.repo).toBe("org/other");
    expect(body.totals.sampleCount).toBe(1);
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].issueId).toBe("Org/Other#43");
    expect(body.samples[0].repoFullName).toBe("Org/Other");
  });

  it("includes a closed item with an unknown claim when its close evidence lands in the window", async () => {
    const closed = new Date("2026-10-05T09:00:00.000Z");
    mocks.eventsFindMany.mockImplementation((args: any) => {
      if (args?.distinct) return Promise.resolve([{ issueId: "issue-1" }]);
      if (args?.where?.issueId) {
        return Promise.resolve([
          eventRow({
            id: "ev-close",
            kind: "issue_closed",
            source: "sync",
            actor: "github",
            agentName: null,
            fromStatus: "status/in-progress",
            toStatus: null,
            occurredAt: closed,
            observedAt: closed,
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    mocks.issueFindMany.mockImplementation((args: any) => {
      if (args?.where?.id) return Promise.resolve([issue({ closedAt: closed })]);
      return Promise.resolve([]);
    });

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].firstClaimAt).toBeNull();
    expect(body.samples[0].delivery).toBe("closed-unmerged");
    expect(body.samples[0].missing).toContain("claim");
    expect(body.samples[0].firstPass).toBeNull();

    expect(body.cohorts).toHaveLength(1);
    expect(body.cohorts[0].key).toBe("unknown");
    expect(body.cohorts[0].delivery["closed-unmerged"]).toBe(1);
  });

  it("flags truncated when the candidate read hits its cap", async () => {
    const CAP = 401; // MAX_CANDIDATE_ISSUES + 1
    mocks.eventsFindMany.mockImplementation((args: any) => {
      if (args?.distinct) {
        return Promise.resolve(
          Array.from({ length: CAP }, (_, i) => ({ issueId: `issue-${i}` })),
        );
      }
      if (args?.where?.issueId) {
        const ids: string[] = args.where.issueId.in;
        return Promise.resolve(ids.map((id) => eventRow({ id: `ev-${id}`, issueId: id })));
      }
      return Promise.resolve([]);
    });
    mocks.issueFindMany.mockImplementation((args: any) => {
      if (args?.where?.id) {
        return Promise.resolve(
          args.where.id.in.map((id: string) =>
            issue({ id, number: Number(id.split("-")[1]) + 1, state: "open", closedAt: null }),
          ),
        );
      }
      return Promise.resolve([]);
    });

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.truncated).toBe(true);
    expect(body.notes).toContain(
      "Candidate issue read hit its cap; the cohort covers only part of the window.",
    );
    expect(body.totals.sampleCount).toBe(400);
  });

  it("does not attribute evidence-row truncation to the candidate-issue read (#1184 review)", async () => {
    installMergedCohort();
    mocks.eventsFindMany.mockImplementation((args: any) => {
      if (args?.distinct) {
        return Promise.resolve([{ issueId: "issue-1" }]);
      }
      if (args?.where?.issueId) {
        return Promise.resolve(
          Array.from({ length: 20_001 }, (_, i) =>
            eventRow({ id: `ev-${i}`, issueId: "issue-1" }),
          ),
        );
      }
      return Promise.resolve([]);
    });

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.truncated).toBe(true);
    expect(body.notes).toContain(
      "Event read hit its row cap; some items have partial event history.",
    );
    expect(body.notes).not.toContain(
      "Candidate issue read hit its cap; the cohort covers only part of the window.",
    );
  });

  it("orders the bulk event read with a unique id tie-break (#1184 review)", async () => {
    installMergedCohort();
    await get();

    const bulkCall = mocks.eventsFindMany.mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.where?.issueId);
    expect(bulkCall).toBeDefined();
    expect(bulkCall.orderBy).toEqual([
      { occurredAt: "asc" },
      { observedAt: "asc" },
      { id: "asc" },
    ]);
  });

  it("surfaces a per-item PR-fix history cap hit in truncated and notes (#1184 review)", async () => {
    installMergedCohort();
    mocks.prFixItemFindMany.mockResolvedValue([
      {
        id: "fi-1",
        repo: "org/repo",
        pr: 101,
        issue: 42,
        generation: 1,
        fixAttempts: 1,
        status: "FIXED",
        outcome: null,
        type: "CI_FAILURE",
        queuedAt: new Date("2026-10-01T11:30:00.000Z"),
        history: Array.from({ length: 101 }, (_, i) => ({
          id: `h-${i}`,
          at: new Date("2026-10-01T11:30:00.000Z"),
          action: "state",
          status: "FIXING",
          outcome: null,
          evidenceKey: null,
        })),
      },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.truncated).toBe(true);
    expect(body.notes).toContain(
      "At least one PR-fix item's status history exceeded its per-item cap; its fix-round evidence is partial.",
    );
  });

  it("surfaces the sample-list cap in truncated and notes (#1184 review)", async () => {
    const claim = new Date("2026-10-01T10:00:00.000Z");
    mocks.eventsFindMany.mockImplementation((args: any) => {
      if (args?.distinct) {
        return Promise.resolve([{ issueId: "issue-1" }, { issueId: "issue-2" }]);
      }
      if (args?.where?.issueId) {
        const ids: string[] = args.where.issueId.in;
        return Promise.resolve(
          ids.map((id) => eventRow({ id: `ev-${id}`, issueId: id, occurredAt: claim, observedAt: claim })),
        );
      }
      return Promise.resolve([]);
    });
    mocks.issueFindMany.mockImplementation((args: any) => {
      if (args?.where?.id) {
        return Promise.resolve(
          args.where.id.in.map((id: string, i: number) =>
            issue({ id, number: 40 + i, state: "open", closedAt: null }),
          ),
        );
      }
      return Promise.resolve([]);
    });

    const res = await get(`${Q}&limit=1`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sampleCount).toBe(2);
    expect(body.samples).toHaveLength(1);
    expect(body.truncated).toBe(true);
    expect(body.notes).toContain(
      "Sample listing hit its limit (1); sampleCount is the full matched count and the cohorts aggregate every sample, only the per-item list is partial.",
    );
  });

  it("does not flag the sample cap when the sample list is omitted", async () => {
    const claim = new Date("2026-10-01T10:00:00.000Z");
    mocks.eventsFindMany.mockImplementation((args: any) => {
      if (args?.distinct) {
        return Promise.resolve([{ issueId: "issue-1" }, { issueId: "issue-2" }]);
      }
      if (args?.where?.issueId) {
        const ids: string[] = args.where.issueId.in;
        return Promise.resolve(
          ids.map((id) => eventRow({ id: `ev-${id}`, issueId: id, occurredAt: claim, observedAt: claim })),
        );
      }
      return Promise.resolve([]);
    });
    mocks.issueFindMany.mockImplementation((args: any) => {
      if (args?.where?.id) {
        return Promise.resolve(
          args.where.id.in.map((id: string, i: number) =>
            issue({ id, number: 40 + i, state: "open", closedAt: null }),
          ),
        );
      }
      return Promise.resolve([]);
    });

    const res = await get(`${Q}&limit=1&includeSamples=0`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.samples).toBeUndefined();
    expect(body.sampleCount).toBe(2);
    expect(body.truncated).toBe(false);
  });

  it("carries dbIssueId on samples for per-item lifecycle drill-down", async () => {
    installMergedCohort();

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].dbIssueId).toBe("issue-1");
  });
});
