import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindUnique: vi.fn().mockResolvedValue(null),
    issueUpdate: vi.fn().mockResolvedValue({}),
    fetchPullRequests: vi.fn().mockResolvedValue([]),
    fetchLinkedPrHealthInput: vi.fn().mockResolvedValue({}),
    computeLinkedPrHealth: vi.fn(() => null),
    toPersistedLinkedPrHealth: vi.fn((v) => v ?? { linkedPrNumber: null, linkedPrState: null }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: mocks.issueFindUnique,
      update: mocks.issueUpdate,
    },
  },
}));

vi.mock("@/lib/github", () => ({
  fetchPullRequests: mocks.fetchPullRequests,
  fetchLinkedPrHealthInput: mocks.fetchLinkedPrHealthInput,
}));

vi.mock("@/lib/linked-pr-health", () => ({
  computeLinkedPrHealth: mocks.computeLinkedPrHealth,
  toPersistedLinkedPrHealth: mocks.toPersistedLinkedPrHealth,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

// Cast Request as NextRequest for type compatibility in tests
function asNextRequest(r: Request): any { return r; }

function postRequest(issueId: string, includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return POST(
    asNextRequest(new Request(`http://localhost/api/issues/${issueId}/pr-health/refresh`, { method: "POST", headers })),
    { params: Promise.resolve({ issueId }) },
  );
}

describe("POST /api/issues/[issueId]/pr-health/refresh", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.issueFindUnique.mockResolvedValue({
      id: "issue-1",
      number: 42,
      repository: { fullName: "org/repo" },
    });
    mocks.fetchPullRequests.mockResolvedValue([]);
    mocks.toPersistedLinkedPrHealth.mockReturnValue({ linkedPrNumber: null, linkedPrState: null });
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest("issue-1", false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = { Authorization: "Bearer wrong-token" };
    const res = await POST(
      asNextRequest(new Request("http://localhost/api/issues/issue-1/pr-health/refresh", { method: "POST", headers })),
      { params: Promise.resolve({ issueId: "issue-1" }) },
    );

    expect(res.status).toBe(401);
  });

  it("returns 404 when issue not found", async () => {
    mocks.issueFindUnique.mockResolvedValue(null);

    const res = await postRequest("nonexistent");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Issue not found in local cache");
  });

  it("refreshes PR health when issue exists", async () => {
    mocks.toPersistedLinkedPrHealth.mockReturnValue({ linkedPrNumber: null, linkedPrState: null });

    const res = await postRequest("issue-1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.issueUpdate).toHaveBeenCalled();
  });

  it("returns 500 on database error", async () => {
    mocks.issueFindUnique.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest("issue-1");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to refresh linked PR health");
  });

  it("unauthorized request does not call prisma", async () => {
    await postRequest("issue-1", false);

    expect(mocks.issueFindUnique).not.toHaveBeenCalled();
  });
});
