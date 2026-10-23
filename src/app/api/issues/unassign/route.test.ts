import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

const { mocks, guardState } = vi.hoisted(() => ({
  // #1361: the guard fake's state — `stillHolds` decides whether the fenced
  // remote write runs, `busy` simulates another writer holding the anchor,
  // `foreignKey` simulates the anchor's guard row failing its issue foreign
  // key, `request` records the anchor request the route made, and `events`
  // records the order in which the anchor and the issue read happened.
  guardState: {
    stillHolds: true,
    busy: false,
    foreignKey: false,
    request: null as unknown,
    events: [] as string[],
  },
  mocks: {
    findIssue: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    updateIssueLabels: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: mocks.findIssue,
      update: mocks.updateIssue,
    },
    auditLog: {
      create: mocks.createAuditLog,
    },
  },
}));

vi.mock("@/lib/github", () => ({
  updateIssueLabels: mocks.updateIssueLabels,
}));

// #1361: the unassign path serializes on the per-issue mutation anchor; the
// fake grants the lock unless the test simulates a lost guard or a busy
// anchor.
vi.mock("@/lib/issue-mutation-guard", () => ({
  withIssueMutationGuard: async (
    req: unknown,
    cb: (
      tx: unknown,
      context: {
        resuming: boolean;
        stillHoldsGuard: () => Promise<boolean>;
        runFencedRemoteWrite: <T>(fn: () => Promise<T>) => Promise<{ status: string; value?: T }>;
      },
    ) => Promise<{ complete: boolean; value: unknown }>,
  ) => {
    guardState.request = req;
    if (guardState.foreignKey) {
      // The anchor's guard row references the issue: an unknown issueId fails
      // the foreign key before the callback ever runs.
      throw { code: "P2003", meta: { field_name: "IssueMutationGuard_issueId_fkey" } };
    }
    if (guardState.busy) {
      return { status: "busy", ownerToken: "owner-token", operation: "unassign" };
    }
    guardState.events.push("anchor-entered");
    return {
      status: "completed",
      value: (await cb(undefined, {
        resuming: false,
        stillHoldsGuard: async () => guardState.stillHolds,
        // #1361: the fenced remote write is ATOMIC with the guard check — a
        // stolen guard means the forge function is NEVER called.
        runFencedRemoteWrite: async (fn: any) => {
          if (!guardState.stillHolds) return { status: "guard-lost" };
          return { status: "written", value: await fn(undefined) };
        },
      })).value,
    };
  },
}));

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

import { resetRateLimits } from "@/lib/rate-limit";
import { POST } from "./route";

// Reset process-global per-actor rate-limit windows and the guard fake's
// state per test (see the claim/actions suites).
beforeEach(() => {
  guardState.stillHolds = true;
  guardState.busy = false;
  guardState.foreignKey = false;
  guardState.request = null;
  guardState.events = [];
  resetRateLimits();
});

function makePayload(overrides = {}) {
  return {
    issueId: "issue-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    action: "unassign_agent" as const,
    ...overrides,
  };
}

function postRequest(payload = makePayload(), includeAuth = true) {
  return POST(authedRequest("http://localhost/api/issues/unassign", { method: "POST", body: payload, includeAuth }));
}

describe("POST /api/issues/unassign — auth", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload()),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify(makePayload()),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when action is missing (with valid auth)", async () => {
    const res = await postRequest(makePayload({ action: undefined as unknown as "unassign_agent" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing required fields/);
  });

  it("returns 400 when issueId is missing", async () => {
    const res = await postRequest(makePayload({ issueId: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing required fields/);
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await postRequest(makePayload({ repoFullName: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing required fields/);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await postRequest(makePayload({ issueNumber: undefined as unknown as number }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing required fields/);
  });

  it("returns 400 for invalid action", async () => {
    const res = await postRequest(makePayload({ action: "invalid" as const }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid action/);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-object JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: JSON.stringify([1, 2]),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues/unassign — unassign_agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["status/backlog", "agent/worker"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("removes agent label and preserves other labels", async () => {
    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).not.toContain("agent/worker");
    expect(body.labels).toContain("status/backlog");
    expect(body.removed).toContain("agent/worker");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/backlog"]
    );
  });

  it("removes all agent labels when multiple exist", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["agent/dup1", "agent/dup2", "priority/p1"],
    });

    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).not.toContain("agent/dup1");
    expect(body.labels).not.toContain("agent/dup2");
    expect(body.labels).toContain("priority/p1");
  });

  it("preserves owner labels when unassigning agent", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["agent/worker", "owner/alice"],
    });

    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).not.toContain("agent/worker");
    expect(body.labels).toContain("owner/alice");
  });

  it("returns 400 when no agent label exists", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["status/backlog", "owner/alice"],
    });

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No agent label found/);
  });

  it("returns 404 when issue is not found", async () => {
    mocks.findIssue.mockResolvedValueOnce(null);

    const res = await postRequest();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Issue not found/);
  });
});

describe("POST /api/issues/unassign — unassign_owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["status/in-progress", "owner/alice"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("removes owner label and preserves other labels", async () => {
    const res = await postRequest(makePayload({ action: "unassign_owner" as const }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).not.toContain("owner/alice");
    expect(body.labels).toContain("status/in-progress");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/in-progress"]
    );
  });

  it("preserves agent labels when unassigning owner", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["agent/worker", "owner/alice"],
    });

    const res = await postRequest(makePayload({ action: "unassign_owner" as const }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).not.toContain("owner/alice");
  });

  it("returns 400 when no owner label exists", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["status/backlog", "agent/worker"],
    });

    const res = await postRequest(makePayload({ action: "unassign_owner" as const }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No owner label found/);
  });
});

describe("POST /api/issues/unassign — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["status/backlog", "agent/worker"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("writes AuditLog with success=false when GitHub mutation fails", async () => {
    mocks.updateIssueLabels.mockRejectedValueOnce(new Error("github 500"));

    const res = await postRequest();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("github 500");

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unassign_agent",
        repoFullName: "org/repo",
        issueNumber: 42,
        success: false,
        errorMessage: "github 500",
      }),
    });
  });
});

describe("POST /api/issues/unassign — #1361 mutation anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: ["status/backlog", "agent/worker"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("writes the remote label set under the anchor and mirrors the cache and the audit", async () => {
    // Record the order in which the anchor and the issue read happen: the
    // label snapshot the remote write applies must be taken WHILE the anchor
    // is held, not before it.
    mocks.findIssue.mockImplementation(async () => {
      guardState.events.push("issue-read");
      return {
        id: "issue-1",
        number: 42,
        repository: { fullName: "org/repo" },
        labels: ["status/backlog", "agent/worker"],
      };
    });

    const res = await postRequest();
    expect(res.status).toBe(200);

    // The anchor was engaged for this issue, as an unassign.
    expect(guardState.request).toEqual({ issueId: "issue-1", operation: "unassign" });

    // The issue was read INSIDE the anchor.
    expect(guardState.events).toEqual(["anchor-entered", "issue-read"]);

    // The remote write targets the ANCHOR's issue and carries the new label
    // set.
    expect(mocks.updateIssueLabels).toHaveBeenCalledWith("org/repo", 42, ["status/backlog"]);

    // The local cache is mirrored.
    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({ labels: ["status/backlog"] }),
    });

    // The success audit row records the canonical repo/number.
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unassign_agent",
        repoFullName: "org/repo",
        issueNumber: 42,
        issueId: "issue-1",
        beforeLabels: ["status/backlog", "agent/worker"],
        afterLabels: ["status/backlog"],
        success: true,
      }),
    });
  });

  it("answers 404 when the anchor's guard row cannot reference the issue", async () => {
    // The anchor's guard row has a foreign key on the issue: an unknown
    // issueId fails the foreign key before the route's own lookup runs. The
    // route's documented answer for a missing issue is 404, not a 500.
    guardState.foreignKey = true;

    const res = await postRequest();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Issue not found: issue-1");

    expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("does not write remotely and answers 409 when the guard was lost before the remote write", async () => {
    guardState.stillHolds = false;

    const res = await postRequest();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/superseded/);
    expect(body.error).toMatch(/retry shortly/);

    // No remote label write, no local cache write: the holder lost the guard.
    expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();

    // The guard loss is audited — the skipped unassignment must be visible.
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unassign_agent",
        repoFullName: "org/repo",
        issueNumber: 42,
        issueId: "issue-1",
        beforeLabels: ["status/backlog", "agent/worker"],
        afterLabels: [],
        success: false,
        errorMessage: expect.stringContaining("superseded"),
      }),
    });
  });

  it("answers 409 without any write when another writer holds the anchor", async () => {
    guardState.busy = true;

    const res = await postRequest();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/Issue mutation is in progress/);

    expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 without any write when the body does not match the anchored issue", async () => {
    const res = await postRequest(makePayload({ repoFullName: "other/repo" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("issueId does not match repoFullName/issueNumber; expected org/repo#42");

    expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 without any write when the body issue number does not match the anchored issue", async () => {
    const res = await postRequest(makePayload({ issueNumber: 99 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("issueId does not match repoFullName/issueNumber; expected org/repo#42");

    expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });
});
