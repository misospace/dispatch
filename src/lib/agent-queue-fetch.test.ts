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
    prFixLaneForRequest: vi.fn((l: string | null | undefined) => (!l ? undefined : l === "frontier" ? "ESCALATED" : l === "local" ? "NORMAL" : null)),
    parseExcludedLabels: vi.fn(() => []),
    // #1506: the terminal no-PR conclusion park ledger read/cleanup.
    noPrFindMany: vi.fn().mockResolvedValue([]),
    noPrDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.findMany },
    noPrConclusion: { findMany: mocks.noPrFindMany, deleteMany: mocks.noPrDeleteMany },
  },
  asPrFixQueueClient: (c: unknown) => c,
}));
vi.mock("@/lib/agent-queue", () => ({ buildAgentQueue: mocks.buildAgentQueue }));
vi.mock("@/lib/pr-fix-queue", () => ({
  listQueuedPrFixItems: mocks.listQueuedPrFixItems,
  toAgentQueuePrFixItem: mocks.toAgentQueuePrFixItem,
}));
vi.mock("@/lib/lease", () => ({ findLeasedIssueIds: mocks.findLeasedIssueIds }));
vi.mock("@/lib/config", () => ({ parseExcludedLabels: mocks.parseExcludedLabels }));
vi.mock("@/lib/lane-config", () => ({ resolveRequestLane: mocks.resolveRequestLane, getLaneIds: mocks.getLaneIds, prFixLaneForRequest: mocks.prFixLaneForRequest }));

import { fetchAgentQueueData } from "./agent-queue-fetch";
import { computeConclusionContentFingerprint } from "@/lib/no-pr-conclusion";

function issue(id: string, over: Record<string, unknown> = {}) {
  return { id, number: 1, title: `#${id}`, url: "u", labels: [], currentLane: "local", decomposed: false, repository: { fullName: "org/repo" }, ...over };
}

function params(over: { agentName?: string; lane?: string | null } = {}) {
  return { agentName: "a", lane: null, excludeDecomposed: false, includeClaimed: false, includeRenovate: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DISPATCH_NO_PR_CONCLUSION_MODE;
  delete process.env.DISPATCH_QUEUE_ADMISSION_MODE;
  mocks.findMany.mockResolvedValue([]);
  mocks.findLeasedIssueIds.mockResolvedValue([]);
  mocks.listQueuedPrFixItems.mockResolvedValue([]);
  mocks.buildAgentQueue.mockReturnValue([]);
  mocks.resolveRequestLane.mockReturnValue(null);
  mocks.noPrFindMany.mockResolvedValue([]);
  mocks.noPrDeleteMany.mockResolvedValue({ count: 0 });
});

describe("fetchAgentQueueData", () => {
  it("marks the lane invalid when a lane is given but resolves to null", async () => {
    mocks.resolveRequestLane.mockReturnValue(null);
    const r = await fetchAgentQueueData(params({ lane: "bogus" }));
    expect(r.laneValid).toBe(false);
    expect(r.resolvedLane).toBeNull();
    expect(mocks.listQueuedPrFixItems).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("treats an absent lane as valid and leaves PR-fix work unfiltered", async () => {
    const r = await fetchAgentQueueData(params());
    expect(r.laneValid).toBe(true);
    expect(mocks.listQueuedPrFixItems).toHaveBeenCalledWith(expect.anything(), { lane: undefined });
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

  it("derives the PR-fix lane from the resolved request lane (#1046)", async () => {
    // Normal configured lane → NORMAL PR-fix filter
    mocks.resolveRequestLane.mockReturnValue("local");
    await fetchAgentQueueData(params({ lane: "normal" }));
    expect(mocks.listQueuedPrFixItems).toHaveBeenLastCalledWith(expect.anything(), { lane: "NORMAL" });

    // Escalation lane → ESCALATED PR-fix filter
    mocks.resolveRequestLane.mockReturnValue("frontier");
    await fetchAgentQueueData(params({ lane: "escalated" }));
    expect(mocks.listQueuedPrFixItems).toHaveBeenLastCalledWith(expect.anything(), { lane: "ESCALATED" });

    mocks.listQueuedPrFixItems.mockClear();
    mocks.resolveRequestLane.mockReturnValue("backlog");
    expect((await fetchAgentQueueData(params({ lane: "backlog" }))).prFixItems).toEqual([]);
    mocks.resolveRequestLane.mockReturnValue("cloud");
    expect((await fetchAgentQueueData(params({ lane: "cloud" }))).prFixItems).toEqual([]);
    expect(mocks.listQueuedPrFixItems).not.toHaveBeenCalled();
  });
});

describe("fetchAgentQueueData — terminal no-PR conclusion park (#1506)", () => {
  // Build a live park row for issue `id`: its fingerprint matches the issue's
  // current title/body, so `loadLiveNoPrConclusions` treats it as live.
  function parkFor(id: string, over: Record<string, unknown> = {}) {
    return {
      id: `park-${id}`,
      issueId: id,
      agentName: "worker",
      outcome: "no_changes_needed",
      contentFingerprint: computeConclusionContentFingerprint({ title: `#${id}`, body: null }),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      summary: "no PR needed",
      ...over,
    };
  }

  it("enforce: a live park withholds the issue into withheldQueue and out of rankedQueue", async () => {
    process.env.DISPATCH_NO_PR_CONCLUSION_MODE = "enforce";
    mocks.findMany.mockResolvedValue([issue("parked")]);
    mocks.noPrFindMany.mockResolvedValue([parkFor("parked")]);
    mocks.buildAgentQueue.mockReturnValue([{ issueId: "parked", title: "#parked", labels: [] }]);

    const r = await fetchAgentQueueData(params());

    expect(r.rankedQueue).toEqual([]);
    expect(r.withheldQueue).toEqual([
      expect.objectContaining({
        issueId: "parked",
        claimable: false,
        noPrConclusion: expect.objectContaining({ agentName: "worker", outcome: "no_changes_needed" }),
      }),
    ]);
    // fullQueue retains the parked issue for linked-PR follow-up routing.
    expect(r.fullQueue.map((i) => i.issueId)).toEqual(["parked"]);
  });

  it("audit mode: a live park attaches the mark but withholds nothing", async () => {
    process.env.DISPATCH_NO_PR_CONCLUSION_MODE = "audit";
    mocks.findMany.mockResolvedValue([issue("parked")]);
    mocks.noPrFindMany.mockResolvedValue([parkFor("parked")]);
    mocks.buildAgentQueue.mockReturnValue([{ issueId: "parked", title: "#parked", labels: [] }]);

    const r = await fetchAgentQueueData(params());

    expect(r.withheldQueue).toEqual([]);
    expect(r.rankedQueue).toEqual([
      expect.objectContaining({
        issueId: "parked",
        noPrConclusion: expect.objectContaining({ agentName: "worker", outcome: "no_changes_needed" }),
      }),
    ]);
    expect(r.fullQueue.map((i) => i.issueId)).toEqual(["parked"]);
  });

  it("admission-audit + conclusion-enforce: the park still withholds (#1506 knob independence)", async () => {
    process.env.DISPATCH_NO_PR_CONCLUSION_MODE = "enforce";
    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "audit";
    // labels [] keeps grooming admission "not_gated": the withheld entry can
    // only come from the park, proving the two knobs are independent.
    mocks.findMany.mockResolvedValue([issue("parked")]);
    mocks.noPrFindMany.mockResolvedValue([parkFor("parked")]);
    mocks.buildAgentQueue.mockReturnValue([{ issueId: "parked", title: "#parked", labels: [] }]);

    const r = await fetchAgentQueueData(params());

    expect(r.admissionMode).toBe("audit");
    // Admission audit annotates without filtering, but the enforce park split
    // must still run: the parked issue is not implementation pickup.
    expect(r.rankedQueue).toEqual([]);
    expect(r.withheldQueue).toEqual([
      expect.objectContaining({
        issueId: "parked",
        claimable: false,
        noPrConclusion: expect.objectContaining({ agentName: "worker" }),
      }),
    ]);
    expect(r.fullQueue.map((i) => i.issueId)).toEqual(["parked"]);
  });

  it("a ledger read failure degrades the poll open instead of halting pickup", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DISPATCH_NO_PR_CONCLUSION_MODE = "enforce";
    mocks.findMany.mockResolvedValue([issue("parked")]);
    mocks.noPrFindMany.mockRejectedValue(new Error("table missing"));
    mocks.buildAgentQueue.mockReturnValue([{ issueId: "parked", title: "#parked", labels: [] }]);

    const r = await fetchAgentQueueData(params());

    expect(r.rankedQueue.map((i) => i.issueId)).toEqual(["parked"]);
    expect(r.withheldQueue).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("off: no park ledger read and no mark is attached", async () => {
    process.env.DISPATCH_NO_PR_CONCLUSION_MODE = "off";
    mocks.findMany.mockResolvedValue([issue("parked")]);
    mocks.noPrFindMany.mockResolvedValue([parkFor("parked")]);
    mocks.buildAgentQueue.mockReturnValue([{ issueId: "parked", title: "#parked", labels: [] }]);

    const r = await fetchAgentQueueData(params());

    expect(mocks.noPrFindMany).not.toHaveBeenCalled();
    expect(r.rankedQueue).toEqual([{ issueId: "parked", title: "#parked", labels: [] }]);
    expect(r.withheldQueue).toEqual([]);
    expect(r.rankedQueue[0].noPrConclusion).toBeUndefined();
  });

  it("an expired park (fingerprint mismatch) is not live: nothing withheld, stale row cleaned up", async () => {
    process.env.DISPATCH_NO_PR_CONCLUSION_MODE = "enforce";
    mocks.findMany.mockResolvedValue([issue("edited")]);
    // Recorded against old content; the issue's title has since moved, so the
    // fingerprint no longer matches — the park ended the moment the edit landed.
    const staleRow = parkFor("edited", {
      contentFingerprint: computeConclusionContentFingerprint({ title: "#edited-OLD", body: null }),
    });
    mocks.noPrFindMany.mockResolvedValue([staleRow]);
    mocks.buildAgentQueue.mockReturnValue([{ issueId: "edited", title: "#edited", labels: [] }]);

    const r = await fetchAgentQueueData(params());

    expect(r.rankedQueue.map((i) => i.issueId)).toEqual(["edited"]);
    expect(r.withheldQueue).toEqual([]);
    expect(r.rankedQueue[0].noPrConclusion).toBeUndefined();
    expect(mocks.noPrDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["park-edited"] } } });
  });
});
