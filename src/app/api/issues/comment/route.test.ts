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
    addIssueComment: vi.fn(),
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
  addIssueComment: mocks.addIssueComment,
}));

import { POST } from "./route";

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "issue-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    body: "Please review this work.",
    ...overrides,
  };
}

function postRequest(payload = makePayload()) {
  return POST(
    authedRequest("http://localhost/api/issues/comment", {
      method: "POST",
      body: payload,
    }),
  );
}

describe("POST /api/issues/comment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "issue-1",
      labels: ["status/backlog"],
      number: 42,
      repository: { fullName: "org/repo" },
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueComment.mockResolvedValue({ url: "https://github.com/org/repo/issues/42#issuecomment-1" });
  });

  it("accepts the bridge issueNumber payload and adds the comment", async () => {
    const response = await postRequest();

    expect(response.status).toBe(200);
    expect((await response.json()).url).toContain("issuecomment-1");
    expect(mocks.addIssueComment).toHaveBeenCalledWith(
      "org/repo",
      42,
      "Please review this work.",
    );
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
