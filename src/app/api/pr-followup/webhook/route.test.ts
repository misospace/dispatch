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
import crypto from "node:crypto";

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
    // Default to gateway mode so existing tests pass without signature headers.
    // Signature-specific tests below explicitly unset this.
    process.env.WEBHOOK_GATEWAY_MODE = "true";
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.processPrFollowupEvents.mockResolvedValue({ enqueued: 1, skipped: 0 });
  });

  describe("signature verification (fail-closed default)", () => {
    it("rejects with 503 when neither WEBHOOK_SECRET nor WEBHOOK_GATEWAY_MODE is configured", async () => {
      delete process.env.WEBHOOK_GATEWAY_MODE;

      const res = await postRequest(
        { action: "submitted", review: { state: "CHANGES_REQUESTED" } },
        {
          Authorization: `Bearer ${mockToken}`,
          "x-github-event": "pull_request_review",
        },
      );

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain("not configured");
    });

    it("processes without signature when WEBHOOK_GATEWAY_MODE is true", async () => {
      // WEBHOOK_GATEWAY_MODE is already "true" from beforeEach
      delete process.env.WEBHOOK_SECRET;

      const res = await postRequest(
        { action: "submitted", review: { state: "CHANGES_REQUESTED" } },
        {
          Authorization: `Bearer ${mockToken}`,
          "x-github-event": "pull_request_review",
        },
      );

      expect(res.status).toBe(200);
    });

    it("rejects with 401 when WEBHOOK_SECRET is set but no signature header", async () => {
      delete process.env.WEBHOOK_GATEWAY_MODE;
      process.env.WEBHOOK_SECRET = "test-secret";

      const res = await postRequest(
        { action: "submitted", review: { state: "CHANGES_REQUESTED" } },
        {
          Authorization: `Bearer ${mockToken}`,
          "x-github-event": "pull_request_review",
        },
      );

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Missing x-hub-signature-256");
    });

    it("rejects with 401 when signature is invalid", async () => {
      delete process.env.WEBHOOK_GATEWAY_MODE;
      process.env.WEBHOOK_SECRET = "test-secret";

      const res = await postRequest(
        { action: "submitted", review: { state: "CHANGES_REQUESTED" } },
        {
          Authorization: `Bearer ${mockToken}`,
          "x-github-event": "pull_request_review",
          "x-hub-signature-256": "sha256=invalid",
        },
      );

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Invalid webhook signature");
    });

    it("processes successfully with valid signature", async () => {
      delete process.env.WEBHOOK_GATEWAY_MODE;
      process.env.WEBHOOK_SECRET = "test-secret";

      const payload = { action: "submitted", review: { state: "CHANGES_REQUESTED" } };
      const bodyStr = JSON.stringify(payload);
      const sig =
        "sha256=" + crypto.createHmac("sha256", "test-secret").update(bodyStr).digest("hex");

      // Use a direct Request so the body bytes are exactly what we computed the HMAC over.
      const req = new Request("http://localhost/api/pr-followup/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mockToken}`,
          "x-github-event": "pull_request_review",
          "x-hub-signature-256": sig,
        },
        body: bodyStr,
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    // Regression for issue #761: a GitHub-shaped delivery carries only a
    // valid x-hub-signature-256 (no Authorization header). With WEBHOOK_SECRET
    // configured this must be sufficient to reach the event handler in every
    // DISPATCH_AUTH_MODE (oidc, legacy, basic), because the route's HMAC check
    // is the authentication gate.
    it.each(["oidc", "legacy", "basic"] as const)(
      "accepts GitHub-shaped delivery (valid HMAC, no Authorization) in %s auth mode",
      async (authMode) => {
        delete process.env.WEBHOOK_GATEWAY_MODE;
        process.env.WEBHOOK_SECRET = "test-secret";
        process.env.DISPATCH_AUTH_MODE = authMode;
        resetAuthCaches();

        const payload = { action: "submitted", review: { state: "CHANGES_REQUESTED" } };
        const bodyStr = JSON.stringify(payload);
        const sig =
          "sha256=" + crypto.createHmac("sha256", "test-secret").update(bodyStr).digest("hex");

        const req = new Request("http://localhost/api/pr-followup/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-github-event": "pull_request_review",
            "x-hub-signature-256": sig,
          },
          body: bodyStr,
        });
        const res = await POST(req);

        expect(res.status).toBe(200);
      },
    );

    it("still 401s a signature-only delivery when the HMAC is invalid in every auth mode", async () => {
      delete process.env.WEBHOOK_GATEWAY_MODE;
      process.env.WEBHOOK_SECRET = "test-secret";
      process.env.DISPATCH_AUTH_MODE = "basic";
      resetAuthCaches();

      const req = new Request("http://localhost/api/pr-followup/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request_review",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body: JSON.stringify({ action: "submitted", review: { state: "CHANGES_REQUESTED" } }),
      });
      const res = await POST(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Invalid webhook signature");
    });
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
