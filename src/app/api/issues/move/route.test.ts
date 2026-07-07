import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted() runs at the very top of the file, before vi.mock() hoisting.
const { mocks } = vi.hoisted(() => ({
  mocks: {
    findIssue: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
    auth: vi.fn(),
  },
}));

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

// Mock dependencies — return the mock functions directly
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
  updateIssueLabels: vi.fn(),
  removeIssueLabel: mocks.removeIssueLabel,
  addIssueLabel: mocks.addIssueLabel,
}));

vi.mock("@/lib/auth-next", () => ({
  auth: mocks.auth,
}));

// Import the route after mocks are set up
import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

function makePayload(overrides = {}) {
  return {
    issueId: "issue-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    oldLabels: ["status/backlog"],
    newLabels: ["status/in-progress"],
    ...overrides,
  };
}

function postRequest(payload = makePayload(), extraHeaders = {}) {
  return POST(
    new Request("http://localhost/api/issues/move", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}`, ...extraHeaders },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/issues/move — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.auth.mockReset();
    mocks.findIssue.mockResolvedValue(null);
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.addIssueLabel.mockResolvedValue(undefined);
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload()),
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/move", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify(makePayload()),
      })
    );
    expect(res.status).toBe(401);
  });

  it("accepts valid Basic Auth in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    resetAuthCaches();

    const res = await postRequest(makePayload(), {
      Authorization: "Basic b3BlcmF0b3I6czNjcmV0",
    });

    expect(res.status).toBe(200);
  });

  it("accepts valid Bearer auth in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    resetAuthCaches();

    const res = await postRequest(makePayload());

    expect(res.status).toBe(200);
  });

  it("accepts valid OIDC session cookies in oidc mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    resetAuthCaches();
    mocks.auth.mockResolvedValue({ user: { email: "operator@example.com" } });

    const res = await POST(
      new Request("http://localhost/api/issues/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload()),
      })
    );

    expect(res.status).toBe(200);
  });

  it("accepts valid Bearer auth in oidc mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    resetAuthCaches();

    const res = await postRequest(makePayload());

    expect(res.status).toBe(200);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});

describe("POST /api/issues/move — validation", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.auth.mockReset();
    mocks.findIssue.mockResolvedValue(null);
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.addIssueLabel.mockResolvedValue(undefined);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await postRequest(makePayload({ issueNumber: undefined }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields");
  });

  it("returns 400 when issueNumber is null", async () => {
    const res = await postRequest(makePayload({ issueNumber: null }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is a string instead of number", async () => {
    const res = await postRequest(makePayload({ issueNumber: "42" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields");
  });

  it("accepts issueNumber zero (it is a number)", async () => {
    // 0 is typeof 'number', so it passes validation.
    // GitHub API would reject it, but that's out of scope for this fix.
    const res = await postRequest(makePayload({ issueNumber: 0 }));
    expect(res.status).toBe(200);
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await postRequest(makePayload({ repoFullName: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when oldLabels is missing", async () => {
    const res = await postRequest(makePayload({ oldLabels: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when newLabels is missing", async () => {
    const res = await postRequest(makePayload({ newLabels: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueId is missing", async () => {
    const res = await postRequest(makePayload({ issueId: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid old status label", async () => {
    const res = await postRequest(
      makePayload({
        oldLabels: ["status/unknown-state"],
        newLabels: ["status/in-progress"],
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid status label/);
  });

  it("returns 400 for invalid new status label", async () => {
    const res = await postRequest(
      makePayload({
        oldLabels: ["status/backlog"],
        newLabels: ["status/unknown-state"],
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid status label/);
  });

  it("accepts a valid move with all correct fields", async () => {
    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify github label operations were called
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith(
      "org/repo",
      42,
      "status/backlog"
    );
    expect(mocks.addIssueLabel).toHaveBeenCalledWith(
      "org/repo",
      42,
      "status/in-progress"
    );

    // Verify audit log was written (Prisma wraps create() args in { data: ... })
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "move_issue",
        repoFullName: "org/repo",
        issueNumber: 42,
        actor: "agent",
        success: true,
      }),
    });
  });

  it("uses Basic Auth username as audit actor", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    resetAuthCaches();

    const res = await postRequest(makePayload({ actor: "body-actor" }), {
      Authorization: "Basic b3BlcmF0b3I6czNjcmV0",
    });

    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({ actor: "operator", success: true }),
    });
  });

  it("uses OIDC email as audit actor", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    resetAuthCaches();
    mocks.auth.mockResolvedValue({ user: { email: "operator@example.com", name: "Operator" } });

    const res = await POST(
      new Request("http://localhost/api/issues/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload({ actor: "body-actor" })),
      })
    );

    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({ actor: "operator@example.com", success: true }),
    });
  });

  it("uses body actor as audit actor for Bearer auth fallback", async () => {
    const res = await postRequest(makePayload({ actor: "worker-1" }));

    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({ actor: "worker-1", success: true }),
    });
  });

  it("removes all real status labels from GitHub even if the client only sent one (approved fix)", async () => {
    mocks.findIssue.mockResolvedValue({ id: "issue-1", labels: ["status/backlog", "status/in-review"] });
    const res = await postRequest(
      makePayload({
        oldLabels: ["status/backlog"],
        newLabels: ["status/in-progress"],
      })
    );
    expect(res.status).toBe(200);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/backlog");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-review");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
  });

  it("does not call github when old and new status are the same", async () => {
    const res = await postRequest(
      makePayload({
        oldLabels: ["status/in-progress"],
        newLabels: ["status/in-progress"],
      })
    );
    expect(res.status).toBe(200);
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
  });

  it("accepts issueNumber as a float (it is a number)", async () => {
    // 42.5 is typeof 'number', so it passes validation.
    // GitHub API would reject it, but that's out of scope for this fix.
    const res = await postRequest(makePayload({ issueNumber: 42.5 }));
    expect(res.status).toBe(200);
  });

  it("handles payload with no status labels", async () => {
    const res = await postRequest(
      makePayload({
        oldLabels: ["type/bug"],
        newLabels: ["type/enhancement"],
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/move", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("writes an AuditLog entry with success=false when the GitHub mutation fails", async () => {
    mocks.removeIssueLabel.mockRejectedValueOnce(new Error("github 500"));

    const res = await postRequest(makePayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("github 500");

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "move_issue",
        repoFullName: "org/repo",
        issueNumber: 42,
        success: false,
        errorMessage: "github 500",
      }),
    });
  });

  it("returns 429 with Retry-After after exceeding the rate limit", async () => {
    // Exhaust the per-actor limit (60/min).
    for (let i = 0; i < 60; i++) {
      const res = await postRequest(makePayload());
      expect(res.status).toBe(200);
    }

    const res = await postRequest(makePayload());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toBe("Rate limit exceeded");
  });
});
