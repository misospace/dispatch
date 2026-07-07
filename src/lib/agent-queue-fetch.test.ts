import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findMany: vi.fn(),
    buildAgentQueue: vi.fn(),
    listQueuedPrFixItems: vi.fn(),
    toAgentQueuePrFixItem: vi.fn((x: unknown) => x),
    findLeasedIssueIds: vi.fn(),
    resolveRequestLane: vi.fn(),
    getLaneIds: vi.fn(() => ["local", "cloud", "frontier", "backlog"]),
    parseExcludedLabels: vi.fn(() => []),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { issue: { findMany: mocks.findMany } },
  asPrFixQueueClient: (c: unknown) => c,
}));
vi.mock("@/lib/agent-queue", () => ({ buildAgentQueue: mocks.buildAgentQueue }));
vi.mock("@/lib/pr-fix-queue", () => ({
  listQueuedPrFixItems: mocks.listQueuedPrFixItems,
  toAgentQueuePrFixItem: mocks.toAgentQueuePrFixItem,
}));
vi.mock("@/lib/lease", () => ({ findLeasedIssueIds: mocks.findLeasedIssueIds }));
vi.mock("@/lib/config", () => ({ parseExcludedLabels: mocks.parseExcludedLabels }));
vi.mock("@/lib/lane-config", () => ({ resolveRequestLane: mocks.resolveRequestLane, getLaneIds: mocks.getLaneIds }));

import { fetchAgentQueueData } from "./agent-queue-fetch";

function issue(id: string, over: Record<string, unknown> = {}) {
  return { id, number: 1, title: `#${id}`, url: "u", labels: [], currentLane: "local", decomposed: false, repository: { fullName: "org/repo" }, ...over };
}

function params(over: { agentName?: string; lane?: string | null } = {}) {
  return { agentName: "a", lane: null, excludeDecomposed: false, includeClaimed: false, includeRenovate: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.findLeasedIssueIds.mockResolvedValue([]);
  mocks.listQueuedPrFixItems.mockResolvedValue([]);
  mocks.buildAgentQueue.mockReturnValue([]);
  mocks.resolveRequestLane.mockReturnValue(null);
});

describe("fetchAgentQueueData", () => {
  it("marks the lane invalid when a lane is given but resolves to null", async () => {
    mocks.resolveRequestLane.mockReturnValue(null);
    const r = await fetchAgentQueueData(params({ lane: "bogus" }));
    expect(r.laneValid).toBe(false);
    expect(r.resolvedLane).toBeNull();
  });

  it("treats an absent lane as valid", async () => {
    const r = await fetchAgentQueueData(params());
    expect(r.laneValid).toBe(true);
  });

  it("treats a resolvable lane as valid and passes it to the ranker", async () => {
    mocks.resolveRequestLane.mockReturnValue("local");
    const r = await fetchAgentQueueData(params({ lane: "normal" }));
    expect(r.laneValid).toBe(true);
    expect(r.resolvedLane).toBe("local");
    expect(mocks.buildAgentQueue).toHaveBeenCalledWith(expect.any(Array), "a", expect.objectContaining({ lane: "local" }));
  });

  it("excludes issues with active leases from other agents before ranking", async () => {
    mocks.findMany.mockResolvedValue([issue("keep"), issue("leased")]);
    mocks.findLeasedIssueIds.mockResolvedValue(["leased"]);

    await fetchAgentQueueData(params());

    const ranked = mocks.buildAgentQueue.mock.calls[0][0] as Array<{ issueId: string }>;
    expect(ranked.map((i) => i.issueId)).toEqual(["keep"]);
  });

  it("does not filter Renovate issues at the DB level — buildAgentQueue owns that decision", async () => {
    await fetchAgentQueueData(params());

    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ state: "open", repository: { enabled: true } });
  });

  it("forwards includeRenovate to buildAgentQueue", async () => {
    await fetchAgentQueueData({ ...params(), includeRenovate: true });
    expect(mocks.buildAgentQueue).toHaveBeenCalledWith(expect.any(Array), "a", expect.objectContaining({ includeRenovate: true }));

    await fetchAgentQueueData(params());
    expect(mocks.buildAgentQueue).toHaveBeenLastCalledWith(expect.any(Array), "a", expect.objectContaining({ includeRenovate: false }));
  });

  it("returns the ranked queue, mapped pr-fix items, and available lanes", async () => {
    mocks.buildAgentQueue.mockReturnValue([{ issueId: "x" }]);
    mocks.listQueuedPrFixItems.mockResolvedValue([{ id: "pf1" }]);

    const r = await fetchAgentQueueData(params());

    expect(r.rankedQueue).toEqual([{ issueId: "x" }]);
    expect(r.prFixItems).toEqual([{ id: "pf1" }]);
    expect(r.availableLanes).toEqual(["local", "cloud", "frontier", "backlog"]);
  });
});
