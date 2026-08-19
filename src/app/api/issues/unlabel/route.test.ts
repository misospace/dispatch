import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedRequest,
  makeDispatchEnvMock,
  TEST_AGENT_TOKEN as mockToken,
} from "@/test/route-helpers";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    updateIssue: vi.fn(),
    createAuditLog: vi.fn(),
    removeIssueLabel: vi.fn(),
  },
}));

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findUnique: mocks.findUnique, update: mocks.updateIssue },
    auditLog: { create: mocks.createAuditLog },
  },
}));

vi.mock("@/lib/github-issues", () => ({
  removeIssueLabel: mocks.removeIssueLabel,
}));

import { POST } from "./route";

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "issue-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    label: "needs-human",
    ...overrides,
  };
}

function postRequest(payload = makePayload()) {
  return POST(
    authedRequest("http://localhost/api/issues/unlabel", {
      method: "POST",
      body: payload,
    }),
  );
}

describe("POST /api/issues/unlabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "issue-1",
      labels: ["status/backlog", "needs-human"],
      number: 42,
      repository: { fullName: "org/repo" },
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.removeIssueLabel.mockResolvedValue(undefined);
  });

  it("accepts the bridge issueNumber payload and removes the label", async () => {
    const response = await postRequest();

    expect(response.status).toBe(200);
    expect((await response.json()).labels).not.toContain("needs-human");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "needs-human");
  });

  it("rejects the legacy number payload", async () => {
    const response = await postRequest(makePayload({ issueNumber: undefined, number: 42 }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("issueNumber");
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a payload without issueNumber", async () => {
    const response = await postRequest(makePayload({ issueNumber: undefined }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("issueNumber");
  });
});
