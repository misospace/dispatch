import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findFirstIssue: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findFirst: mocks.findFirstIssue },
  },
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function makeRequest(urlString: string, includeAuth = true) {
  return GET(authedRequest(urlString, { includeAuth }));
}

const OPEN_ISSUE = {
  id: "issue-1",
  number: 38,
  state: "open",
  labels: ["status/ready", "agent/foreman-coder"],
  closedAt: null,
  repository: { fullName: "misospace/llmkube-images" },
};

describe("GET /api/issues/state", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(OPEN_ISSUE);
  });

  it("returns 401 without auth", async () => {
    const res = await makeRequest("http://localhost/api/issues/state?repo=o/n&number=1", false);
    expect(res.status).toBe(401);
    expect(mocks.findFirstIssue).not.toHaveBeenCalled();
  });

  it("returns 400 when repo is missing", async () => {
    const res = await makeRequest("http://localhost/api/issues/state?number=1");
    expect(res.status).toBe(400);
  });

  it("returns 400 when number is missing", async () => {
    const res = await makeRequest("http://localhost/api/issues/state?repo=o/n");
    expect(res.status).toBe(400);
  });

  it.each(["abc", "0", "-3", "1.5"])("returns 400 for a non-positive-integer number (%s)", async (n) => {
    const res = await makeRequest(`http://localhost/api/issues/state?repo=o/n&number=${n}`);
    expect(res.status).toBe(400);
    expect(mocks.findFirstIssue).not.toHaveBeenCalled();
  });

  it("looks up by repo + number with no exclusion filters applied", async () => {
    // The point of this endpoint: unlike GET /api/issues, absence here means the
    // issue is genuinely not cached — not that a Renovate or excluded-label filter
    // removed it. A caller must be able to distinguish those.
    await makeRequest("http://localhost/api/issues/state?repo=misospace/llmkube-images&number=38");

    const call = mocks.findFirstIssue.mock.calls[0][0];
    expect(call.where).toEqual({ number: 38, repository: { fullName: "misospace/llmkube-images" } });
    expect(JSON.stringify(call.where)).not.toContain("labels");
    expect(JSON.stringify(call.where)).not.toContain("enabled");
  });

  it("returns the open state", async () => {
    const res = await makeRequest("http://localhost/api/issues/state?repo=misospace/llmkube-images&number=38");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("open");
    expect(body.number).toBe(38);
    expect(body.repoFullName).toBe("misospace/llmkube-images");
    expect(body.labels).toContain("status/ready");
  });

  it("returns the closed state with closedAt", async () => {
    mocks.findFirstIssue.mockResolvedValue({
      ...OPEN_ISSUE,
      state: "closed",
      closedAt: new Date("2026-08-06T14:40:00Z"),
    });
    const res = await makeRequest("http://localhost/api/issues/state?repo=misospace/llmkube-images&number=38");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("closed");
    expect(body.closedAt).toBeTruthy();
  });

  it("returns 404 when the issue is absent from the cache", async () => {
    // 404 means "unknown", so a caller can fail open instead of inferring closure.
    mocks.findFirstIssue.mockResolvedValue(null);
    const res = await makeRequest("http://localhost/api/issues/state?repo=o/n&number=999");
    expect(res.status).toBe(404);
  });

  it("surfaces a database failure as an error rather than a false answer", async () => {
    mocks.findFirstIssue.mockRejectedValue(new Error("connection reset"));
    const res = await makeRequest("http://localhost/api/issues/state?repo=o/n&number=1");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
