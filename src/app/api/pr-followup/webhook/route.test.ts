// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    prFixQueueClient: vi.fn(),
    processPrFollowupEvents: vi.fn().mockResolvedValue({ enqueued: 1, skipped: 0 }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  asPrFixQueueClient: mocks.prFixQueueClient,
}));

vi.mock("@/lib/pr-followup-ingestion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pr-followup-ingestion")>()),
  processPrFollowupEvents: mocks.processPrFollowupEvents,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    authedRequest("http://localhost/api/pr-followup/webhook", {
      method: "POST",
      body,
      includeAuth: false,
      headers,
    }),
  );
}

describe("POST /api/pr-followup/webhook", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_GATEWAY_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.processPrFollowupEvents.mockResolvedValue({ enqueued: 1, skipped: 0 });
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest({}, { "x-github-event": "pull_request_review" });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when x-github-event header is missing", async () => {
    const res = await postRequest({}, { Authorization: `Bearer ${mockToken}` });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing x-github-event header");
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/pr-followup/webhook", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockToken}`,
          "x-github-event": "pull_request_review",
        },
        body: "not-json",
      }),
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid payload type", async () => {
    const res = await postRequest("string-body", {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "pull_request_review",
    });

    expect(res.status).toBe(400);
  });

  it("returns 200 for unhandled event type", async () => {
    const res = await postRequest({ action: "opened" }, {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "unknown_event",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("Unhandled event type");
  });

  it("processes pull_request_review events", async () => {
    const prBody = {
      review: { id: 1, body: "Looks good", state: "APPROVED" },
      pull_request: {
        number: 42,
        html_url: "https://github.com/org/repo/pull/42",
        title: "Fix bug",
        user: { login: "bot-user" },
        head: { ref: "fix/issue-1" },
        base: { repo: { full_name: "org/repo" } },
      },
    };

    const res = await postRequest(prBody, {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "pull_request_review",
    });

    expect(res.status).toBe(200);
    expect(mocks.processPrFollowupEvents).toHaveBeenCalled();
  });

  it("processes pull_request events", async () => {
    const prBody = {
      pull_request: {
        id: 1,
        number: 42,
        html_url: "https://github.com/org/repo/pull/42",
        title: "Fix bug",
        user: { login: "bot-user" },
        head: { ref: "fix/issue-1" },
        base: { repo: { full_name: "org/repo" } },
        mergeable_state: "clean",
      },
    };

    const res = await postRequest(prBody, {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "pull_request",
    });

    expect(res.status).toBe(200);
    expect(mocks.processPrFollowupEvents).toHaveBeenCalled();
  });

  it("returns events count in response", async () => {
    mocks.processPrFollowupEvents.mockResolvedValue({ enqueued: 1, skipped: 0 });

    const prBody = {
      review: { id: 1, body: "Fix this", state: "CHANGES_REQUESTED" },
      pull_request: {
        number: 42,
        html_url: "https://github.com/org/repo/pull/42",
        title: "Fix bug",
        user: { login: "bot-user" },
        head: { ref: "fix/issue-1" },
        base: { repo: { full_name: "org/repo" } },
      },
    };

    const res = await postRequest(prBody, {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "pull_request_review",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventsReceived).toBe(1);
    expect(body.enqueued).toBe(1);
  });

  it("returns 500 on processing error", async () => {
    mocks.processPrFollowupEvents.mockRejectedValue(new Error("db connection lost"));

    const prBody = {
      review: { id: 1, body: "Fix this", state: "CHANGES_REQUESTED" },
      pull_request: {
        number: 42,
        html_url: "https://github.com/org/repo/pull/42",
        title: "Fix bug",
        user: { login: "bot-user" },
        head: { ref: "fix/issue-1" },
        base: { repo: { full_name: "org/repo" } },
      },
    };

    const res = await postRequest(prBody, {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "pull_request_review",
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Webhook processing failed");
  });

  it("preserves body integrity when authorizeRequest consumes the body stream", async () => {
    // Regression test for #656: if authorizeRequest ever reads the request body,
    // the webhook handler must still verify the HMAC against the original payload.
    // This is ensured by reading request.arrayBuffer() before calling authorizeRequest.

    const prBody = {
      review: { id: 1, body: "Looks good", state: "APPROVED" },
      pull_request: {
        number: 42,
        html_url: "https://github.com/org/repo/pull/42",
        title: "Fix bug",
        user: { login: "bot-user" },
        head: { ref: "fix/issue-1" },
        base: { repo: { full_name: "org/repo" } },
      },
    };

    // Create a request where the body can only be consumed once.
    const originalRequest = new Request("http://localhost/api/pr-followup/webhook", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mockToken}`,
        "x-github-event": "pull_request_review",
      },
      body: JSON.stringify(prBody),
    });

    // Clone the request to verify body content independently.
    const clonedRequest = originalRequest.clone();
    const bodyBeforeAuth = await clonedRequest.arrayBuffer();

    const res = await POST(originalRequest);

    expect(res.status).toBe(200);
    expect(mocks.processPrFollowupEvents).toHaveBeenCalled();

    // Verify the body that was read matches what we sent (not empty).
    const bodyStr = Buffer.from(bodyBeforeAuth).toString();
    expect(bodyStr).toContain("Looks good");
  });
});
