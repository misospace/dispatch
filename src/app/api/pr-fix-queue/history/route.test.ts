import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUniqueItem: vi.fn(),
    findManyHistory: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    prFixQueueItem: { findUnique: mocks.findUniqueItem },
    prFixHistory: { findMany: mocks.findManyHistory },
  },
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function makeRequest(urlString: string, includeAuth = true) {
  return GET(authedRequest(urlString, { includeAuth }));
}

const ITEM = {
  id: "item-1",
  repo: "misospace/dispatch",
  pr: 44,
  lane: "NEEDS_HUMAN",
  status: "BLOCKED",
  type: "REVIEW_FEEDBACK",
  reason: "PR review: CHANGES_REQUESTED",
  queuedAt: new Date("2026-05-14T21:49:00Z"),
  updatedAt: new Date("2026-08-06T15:47:33Z"),
};

const HISTORY = [
  { at: new Date("2026-08-06T15:47:33Z"), action: "mark", status: "BLOCKED", lane: "NEEDS_HUMAN", reason: null, note: "attempts exhausted", evidenceKey: null },
  { at: new Date("2026-05-14T21:49:00Z"), action: "enqueue", status: null, lane: "NORMAL", reason: "PR review: CHANGES_REQUESTED", note: null, evidenceKey: "review:1:misospace/dispatch#44" },
];

describe("GET /api/pr-fix-queue/history", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.findUniqueItem.mockResolvedValue(ITEM);
    mocks.findManyHistory.mockResolvedValue(HISTORY);
  });

  it("returns 401 without auth", async () => {
    const res = await makeRequest("http://localhost/api/pr-fix-queue/history?repo=o/n&pr=1", false);
    expect(res.status).toBe(401);
    expect(mocks.findUniqueItem).not.toHaveBeenCalled();
  });

  it.each([
    ["missing repo", "http://localhost/api/pr-fix-queue/history?pr=1"],
    ["missing pr", "http://localhost/api/pr-fix-queue/history?repo=o/n"],
  ])("returns 400 on %s", async (_label, url) => {
    const res = await makeRequest(url);
    expect(res.status).toBe(400);
  });

  it.each(["abc", "0", "-2", "1.5"])("returns 400 for an invalid pr (%s)", async (pr) => {
    const res = await makeRequest(`http://localhost/api/pr-fix-queue/history?repo=o/n&pr=${pr}`);
    expect(res.status).toBe(400);
    expect(mocks.findUniqueItem).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid limit", async () => {
    const res = await makeRequest("http://localhost/api/pr-fix-queue/history?repo=o/n&pr=1&limit=nope");
    expect(res.status).toBe(400);
  });

  it("caps an oversized limit rather than rejecting it", async () => {
    await makeRequest("http://localhost/api/pr-fix-queue/history?repo=o/n&pr=1&limit=9999");
    expect(mocks.findManyHistory.mock.calls[0][0].take).toBe(200);
  });

  it("returns the item and its history newest-first", async () => {
    const res = await makeRequest("http://localhost/api/pr-fix-queue/history?repo=misospace/dispatch&pr=44");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.status).toBe("BLOCKED");
    expect(body.item.reason).toBe("PR review: CHANGES_REQUESTED");
    expect(body.history).toHaveLength(2);
    expect(mocks.findManyHistory.mock.calls[0][0].orderBy).toEqual({ at: "desc" });
  });

  it("surfaces the transition that would otherwise only exist in lost pod logs", async () => {
    // The whole point: which call flipped the item, and when.
    const res = await makeRequest("http://localhost/api/pr-fix-queue/history?repo=misospace/dispatch&pr=44");
    const body = await res.json();
    expect(body.history[0].action).toBe("mark");
    expect(body.history[0].status).toBe("BLOCKED");
    expect(body.history[0].lane).toBe("NEEDS_HUMAN");
    expect(body.history[0].note).toBe("attempts exhausted");
    expect(body.history[1].action).toBe("enqueue");
    expect(body.history[1].lane).toBe("NORMAL");
  });

  it("returns 404 when no item exists for that PR", async () => {
    mocks.findUniqueItem.mockResolvedValue(null);
    const res = await makeRequest("http://localhost/api/pr-fix-queue/history?repo=o/n&pr=999");
    expect(res.status).toBe(404);
    expect(mocks.findManyHistory).not.toHaveBeenCalled();
  });

  it("surfaces a database failure rather than an empty history", async () => {
    mocks.findManyHistory.mockRejectedValue(new Error("connection reset"));
    const res = await makeRequest("http://localhost/api/pr-fix-queue/history?repo=o/n&pr=1");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
