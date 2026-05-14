import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted() runs at the very top of the file, before vi.mock() hoisting.
const { mocks } = vi.hoisted(() => ({
  mocks: {
    findIssue: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
  },
}));

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

// Import the route after mocks are set up
import { POST } from "./route";

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

function postRequest(payload = makePayload()) {
  return POST(
    new Request("http://localhost/api/issues/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/issues/move — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        success: true,
      }),
    });
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
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });
});
