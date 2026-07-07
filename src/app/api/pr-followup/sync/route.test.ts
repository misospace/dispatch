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
    prFixQueueClient: vi.fn(),
    processPrFollowupEvents: vi.fn().mockResolvedValue({ enqueued: 0, skipped: 0 }),
    ingestMergeConflict: vi.fn().mockResolvedValue(null),
    clearResolvedConflictItems: vi.fn().mockResolvedValue(undefined),
    getTrackedRepos: vi.fn().mockResolvedValue([]),
    isAllowedBotAuthor: vi.fn(() => false),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  asPrFixQueueClient: mocks.prFixQueueClient,
}));

vi.mock("@/lib/pr-followup-ingestion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pr-followup-ingestion")>()),
  processPrFollowupEvents: mocks.processPrFollowupEvents,
  isAllowedBotAuthor: mocks.isAllowedBotAuthor,
  ingestMergeConflict: mocks.ingestMergeConflict,
  clearResolvedConflictItems: mocks.clearResolvedConflictItems,
}));

vi.mock("@/lib/config", () => ({
  getTrackedRepos: mocks.getTrackedRepos,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

// Cast Request as NextRequest for type compatibility in tests
function asNextRequest(r: Request): any { return r; }

function postRequest(includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return POST(asNextRequest(new Request("http://localhost/api/pr-followup/sync", { method: "POST", headers })));
}

describe("POST /api/pr-followup/sync", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.getTrackedRepos.mockResolvedValue([]);
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest(false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = { Authorization: "Bearer wrong-token" };
    const res = await POST(asNextRequest(new Request("http://localhost/api/pr-followup/sync", { method: "POST", headers })));

    expect(res.status).toBe(401);
  });

  it("returns 500 when GITHUB_TOKEN is not configured", async () => {
    delete process.env.GITHUB_TOKEN;

    const res = await postRequest(true);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("GITHUB_TOKEN not configured");
  });

  it("returns success when no tracked repos", async () => {
    process.env.GITHUB_TOKEN = "gh_fake_token";
    mocks.getTrackedRepos.mockResolvedValue([]);

    const res = await postRequest(true);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("No tracked repos configured");
  });

  it("unauthorized request does not call getTrackedRepos", async () => {
    await postRequest(false);

    expect(mocks.getTrackedRepos).not.toHaveBeenCalled();
  });

  it("queries check-runs with status=completed and enqueues a failing check as an event", async () => {
    process.env.GITHUB_TOKEN = "gh_fake_token";
    mocks.getTrackedRepos.mockResolvedValue(["misospace/KubeTix"]);
    mocks.isAllowedBotAuthor.mockReturnValue(true);

    const jsonRes = (data: unknown) => ({ ok: true, headers: new Headers(), json: async () => data, text: async () => "" });
    let checksUrl = "";
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/pulls?state=open")) {
        return jsonRes([{
          id: 1, number: 207, url: "https://gh/pr/207", title: "fix (#165)", body: "Fixes #165",
          state: "open", user: { login: "itsmiso-ai" }, head: { ref: "foreman/x/issue-165" },
          base: { ref: "main" }, merged_at: null, draft: false, mergeable_state: "clean",
        }]);
      }
      if (u.includes("/comments")) return jsonRes([]);
      if (u.includes("/reviews")) return jsonRes([]);
      if (u.includes("/check-runs")) {
        checksUrl = u;
        return jsonRes({ check_runs: [{ id: 99, name: "test", conclusion: "failure", html_url: "https://gh/run/99", output: { summary: "boom" } }] });
      }
      return jsonRes([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await postRequest(true);
    expect(res.status).toBe(200);

    // The bug: status=end returns zero check-runs, so failing CI is never seen.
    expect(checksUrl).toContain("status=completed");
    expect(checksUrl).not.toContain("status=end");

    // The failing check must reach the ingestion pipeline as a check_run event.
    const events = mocks.processPrFollowupEvents.mock.calls.at(-1)?.[1] ?? [];
    expect(events.some((e: { eventType?: string }) => e.eventType === "check_run")).toBe(true);

    vi.unstubAllGlobals();
  });
});
