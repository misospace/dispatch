/**
 * Tests for POST /api/issues/label — applies or removes a GitHub label on an
 * issue and syncs the local cache.
 *
 * Covers:
 * - add: GitHub write + cache update + audit log
 * - remove: GitHub write + cache update + audit log
 * - idempotent add: label already present → no GitHub write, cache + audit still recorded
 * - missing issue: 404, no GitHub write
 * - unauthorized: 401
 * - rate limit: 429 after 30 requests in the window
 * - validation: 400 on missing required fields
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { addIssueLabel, removeIssueLabel } from "@/lib/github-issues";
import { resetRateLimits } from "@/lib/rate-limit";

vi.mock("@/lib/auth", () => ({
  authorizeRequest: vi.fn(),
  getAuthorizedActor: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/github-issues", () => ({
  addIssueLabel: vi.fn(),
  removeIssueLabel: vi.fn(),
}));

const mockAuthorize = vi.mocked(authorizeRequest);
const mockGetActor = vi.mocked(getAuthorizedActor);
const mockFindUnique = vi.mocked(prisma.issue.findUnique);
const mockUpdate = vi.mocked(prisma.issue.update);
const mockAuditCreate = vi.mocked(prisma.auditLog.create);
const mockAddLabel = vi.mocked(addIssueLabel);
const mockRemoveLabel = vi.mocked(removeIssueLabel);

const validIssue = {
  id: "issue-1",
  number: 42,
  title: "Test issue",
  state: "open",
  labels: ["bug"],
  assignee: null,
  repository: { fullName: "misospace/dispatch" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/issues/label", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const validBody = {
  issueId: "issue-1",
  repoFullName: "misospace/dispatch",
  issueNumber: 42,
  label: "needs-triage",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  mockAuthorize.mockResolvedValue({
    authorized: true,
    type: "bearer",
    actor: "test-user",
  } as never);
  mockGetActor.mockReturnValue("test-user");
  mockFindUnique.mockResolvedValue(validIssue as never);
  mockUpdate.mockResolvedValue(validIssue as never);
  mockAuditCreate.mockResolvedValue({ id: 1 } as never);
  mockAddLabel.mockResolvedValue(undefined);
  mockRemoveLabel.mockResolvedValue(undefined);
});

describe("POST /api/issues/label", () => {
  it("adds a label: writes to GitHub, updates cache, logs audit", async () => {
    const res = await POST(makeRequest({ ...validBody, action: "add" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.action).toBe("add");
    expect(data.label).toBe("needs-triage");
    expect(data.labels).toEqual(["bug", "needs-triage"]);

    expect(mockAddLabel).toHaveBeenCalledWith(
      "misospace/dispatch",
      42,
      "needs-triage",
    );
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({ labels: ["bug", "needs-triage"] }),
    });
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const audit = mockAuditCreate.mock.calls[0][0].data;
    expect(audit.actor).toBe("test-user");
    expect(audit.action).toBe("add_label");
    expect(audit.repoFullName).toBe("misospace/dispatch");
    expect(audit.issueNumber).toBe(42);
    expect(audit.beforeLabels).toEqual(["bug"]);
    expect(audit.afterLabels).toEqual(["bug", "needs-triage"]);
    expect(audit.success).toBe(true);
  });

  it("removes a label: writes to GitHub, updates cache, logs audit", async () => {
    const res = await POST(makeRequest({ ...validBody, label: "bug", action: "remove" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.action).toBe("remove");
    expect(data.label).toBe("bug");
    expect(data.labels).toEqual([]);

    expect(mockRemoveLabel).toHaveBeenCalledWith("misospace/dispatch", 42, "bug");
    expect(mockAddLabel).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({ labels: [] }),
    });
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const audit = mockAuditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe("remove_label");
    expect(audit.beforeLabels).toEqual(["bug"]);
    expect(audit.afterLabels).toEqual([]);
  });

  it("idempotent add: label already present → no GitHub write, cache + audit still recorded", async () => {
    const res = await POST(makeRequest({ ...validBody, label: "bug", action: "add" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.labels).toEqual(["bug"]);

    expect(mockAddLabel).not.toHaveBeenCalled();
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({ labels: ["bug"] }),
    });
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const audit = mockAuditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe("add_label");
    expect(audit.beforeLabels).toEqual(["bug"]);
    expect(audit.afterLabels).toEqual(["bug"]);
  });

  it("returns 404 when the issue is not in the local cache", async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest({ ...validBody, action: "add" }));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe(
      "Issue not found in local cache: misospace/dispatch#42 (issueId: issue-1)",
    );
    expect(mockAddLabel).not.toHaveBeenCalled();
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthorize.mockResolvedValue({ authorized: false } as never);
    const res = await POST(makeRequest({ ...validBody, action: "add" }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
    expect(mockAddLabel).not.toHaveBeenCalled();
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("returns 429 after exceeding the rate limit (30 per 10s)", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await POST(makeRequest({ ...validBody, action: "add" }));
      expect(res.status).toBe(200);
    }
    const res = await POST(makeRequest({ ...validBody, action: "add" }));
    expect(res.status).toBe(429);
    // The 31st request is rejected before any GitHub write.
    expect(mockAddLabel).toHaveBeenCalledTimes(30);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await POST(makeRequest({ issueId: "issue-1" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe(
      "Missing required fields: issueId, repoFullName, issueNumber, label",
    );
    expect(mockAddLabel).not.toHaveBeenCalled();
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
