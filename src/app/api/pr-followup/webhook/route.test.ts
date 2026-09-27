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
import { resetRateLimits } from "@/lib/rate-limit";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
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
    resetRateLimits();
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

function signedRequest(event: string, body: unknown, signature?: string) {
  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-github-event": event,
  };
  headers["x-hub-signature-256"] =
    signature ?? "sha256=" + crypto.createHmac("sha256", "test-secret").update(bodyStr).digest("hex");
  return POST(
    new Request("http://localhost/api/pr-followup/webhook", { method: "POST", headers, body: bodyStr }),
  );
}

function ingestedEvents() {
  expect(mocks.processPrFollowupEvents).toHaveBeenCalledTimes(1);
  return mocks.processPrFollowupEvents.mock.calls[0][1];
}

describe("POST /api/pr-followup/webhook — signature edge cases", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.WEBHOOK_GATEWAY_MODE;
    process.env.WEBHOOK_SECRET = "test-secret";
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.processPrFollowupEvents.mockResolvedValue({ enqueued: 1, skipped: 0 });
  });

  const payload = { action: "submitted", review: { state: "CHANGES_REQUESTED" } };

  it("rejects a sha1= signature even when the sha1 HMAC is correct", async () => {
    const sha1 = crypto.createHmac("sha1", "test-secret").update(JSON.stringify(payload)).digest("hex");
    const res = await signedRequest("pull_request_review", payload, `sha1=${sha1}`);

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid webhook signature");
  });

  it("rejects a truncated sha256 signature with 401 rather than throwing", async () => {
    const good = crypto.createHmac("sha256", "test-secret").update(JSON.stringify(payload)).digest("hex");
    const res = await signedRequest("pull_request_review", payload, `sha256=${good.slice(0, 40)}`);

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid webhook signature");
  });

  it("rejects an equal-length signature computed with the wrong secret", async () => {
    const wrong = crypto.createHmac("sha256", "other-secret").update(JSON.stringify(payload)).digest("hex");
    const res = await signedRequest("pull_request_review", payload, `sha256=${wrong}`);

    expect(res.status).toBe(401);
    expect(mocks.processPrFollowupEvents).not.toHaveBeenCalled();
  });

  it("rejects a valid signature when the body was altered after signing", async () => {
    const sig = "sha256=" + crypto.createHmac("sha256", "test-secret").update(JSON.stringify(payload)).digest("hex");
    const res = await signedRequest("pull_request_review", { ...payload, tampered: true }, sig);

    expect(res.status).toBe(401);
  });

  it("verifyWebhookSignature returns false without throwing for bad prefixes and lengths", () => {
    const body = Buffer.from("{}");
    const good = crypto.createHmac("sha256", "test-secret").update(body).digest("hex");

    expect(verifyWebhookSignature("test-secret", body, `sha256=${good}`)).toBe(true);
    expect(() => verifyWebhookSignature("test-secret", body, `sha1=${good}`)).not.toThrow();
    expect(verifyWebhookSignature("test-secret", body, `sha1=${good}`)).toBe(false);
    expect(verifyWebhookSignature("test-secret", body, good)).toBe(false);
    expect(verifyWebhookSignature("test-secret", body, `sha256=${good}00`)).toBe(false);
    expect(verifyWebhookSignature("test-secret", body, "sha256=")).toBe(false);
  });
});

describe("POST /api/pr-followup/webhook — event dispatch", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.WEBHOOK_GATEWAY_MODE;
    process.env.WEBHOOK_SECRET = "test-secret";
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.processPrFollowupEvents.mockResolvedValue({ enqueued: 1, skipped: 0 });
  });

  // Trimmed GitHub webhook payloads (shapes per the octokit/openapi-webhooks
  // schema). `repository` and `sender` are top-level on every event.
  const repository = {
    id: 1296269,
    name: "repo",
    full_name: "org/repo",
    owner: { login: "org" },
    html_url: "https://github.com/org/repo",
  };
  const sender = { login: "itsmiso-ai", type: "User" };

  const pullRequest = {
    id: 9001,
    number: 42,
    state: "open",
    html_url: "https://github.com/org/repo/pull/42",
    url: "https://api.github.com/repos/org/repo/pulls/42",
    title: "Fix bug (#7)",
    body: "Closes #7",
    user: { login: "itsmiso-ai" },
    merged_at: null,
    mergeable_state: "dirty",
    head: { ref: "fix/issue-7", sha: "abc123", repo: { full_name: "org/repo" } },
    base: { ref: "main", sha: "def456", repo: { full_name: "org/repo" } },
  };

  it("builds a review event from pull_request_review", async () => {
    const res = await signedRequest("pull_request_review", {
      action: "submitted",
      review: {
        id: 555,
        body: "Please fix",
        state: "changes_requested",
        user: { login: "reviewer" },
        commit_id: "abc123",
      },
      pull_request: pullRequest,
      repository,
      sender,
    });

    expect(res.status).toBe(200);
    expect(ingestedEvents()).toEqual([
      {
        eventType: "review",
        repoFullName: "org/repo",
        prNumber: 42,
        branch: "fix/issue-7",
        url: "https://github.com/org/repo/pull/42",
        title: "Fix bug (#7)",
        author: "itsmiso-ai",
        body: "Please fix",
        id: "555",
        state: "changes_requested",
        linkedIssue: 7,
        prState: "open",
        prMergedAt: null,
        headSha: "abc123",
      },
    ]);
  });

  it("builds a comment event from pull_request_review_comment", async () => {
    const res = await signedRequest("pull_request_review_comment", {
      action: "created",
      comment: {
        id: 777,
        body: "nit: rename this",
        path: "src/app.ts",
        line: 12,
        user: { login: "reviewer" },
      },
      pull_request: pullRequest,
      repository,
      sender,
    });

    expect(res.status).toBe(200);
    expect(ingestedEvents()).toEqual([
      {
        eventType: "comment",
        repoFullName: "org/repo",
        prNumber: 42,
        branch: "fix/issue-7",
        url: "https://github.com/org/repo/pull/42",
        title: "Fix bug (#7)",
        author: "itsmiso-ai",
        body: "nit: rename this",
        id: "777",
        linkedIssue: 7,
        headSha: "abc123",
      },
    ]);
  });

  // Regression for #1087: the issue object has no `repository` or `head`, so
  // the repo must come from the top-level `repository`.
  it("builds a comment event from issue_comment on a pull request", async () => {
    const res = await signedRequest("issue_comment", {
      action: "created",
      comment: {
        id: 888,
        body: "please rebase",
        user: { login: "reviewer" },
        html_url: "https://github.com/org/repo/pull/42#issuecomment-888",
      },
      issue: {
        id: 123,
        number: 42,
        state: "open",
        title: "Fix bug (#7)",
        body: "Closes #7",
        html_url: "https://github.com/org/repo/pull/42",
        repository_url: "https://api.github.com/repos/org/repo",
        user: { login: "itsmiso-ai" },
        pull_request: {
          url: "https://api.github.com/repos/org/repo/pulls/42",
          html_url: "https://github.com/org/repo/pull/42",
          merged_at: null,
        },
      },
      repository,
      sender,
    });

    expect(res.status).toBe(200);
    expect(ingestedEvents()).toEqual([
      {
        eventType: "comment",
        repoFullName: "org/repo",
        prNumber: 42,
        branch: null,
        url: "https://github.com/org/repo/pull/42",
        title: "Fix bug (#7)",
        author: "itsmiso-ai",
        body: "please rebase",
        id: "888",
        linkedIssue: 7,
        headSha: null,
      },
    ]);
  });

  it("ignores issue_comment on a plain issue (no pull_request)", async () => {
    const res = await signedRequest("issue_comment", {
      action: "created",
      comment: { id: 889, body: "hi", user: { login: "someone" } },
      issue: {
        number: 3,
        title: "Plain issue",
        html_url: "https://github.com/org/repo/issues/3",
        user: { login: "someone" },
      },
      repository,
      sender,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("No events to process");
    expect(mocks.processPrFollowupEvents).not.toHaveBeenCalled();
  });

  // Regression for #1087: pull_requests[] items are pull-request-minimal
  // objects whose `url` is the API URL (/pulls/N), with the number given
  // directly and no author; the repo is the top-level `repository`.
  it("builds a check_run event from the first associated pull request", async () => {
    const res = await signedRequest("check_run", {
      action: "completed",
      check_run: {
        id: 321,
        name: "lint",
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        url: "https://api.github.com/repos/org/repo/check-runs/321",
        html_url: "https://github.com/org/repo/runs/321",
        details_url: "https://github.com/org/repo/actions/runs/1/job/321",
        output: { title: "Lint failed", summary: "2 errors", text: null, annotations_count: 2 },
        check_suite: { id: 5, head_branch: "fix/issue-7", head_sha: "abc123" },
        app: { slug: "github-actions" },
        pull_requests: [
          {
            id: 9001,
            number: 42,
            url: "https://api.github.com/repos/org/repo/pulls/42",
            head: { ref: "fix/issue-7", sha: "abc123", repo: { id: 1296269, url: "https://api.github.com/repos/org/repo", name: "repo" } },
            base: { ref: "main", sha: "def456", repo: { id: 1296269, url: "https://api.github.com/repos/org/repo", name: "repo" } },
          },
        ],
      },
      repository,
      sender: { login: "github-actions[bot]", type: "Bot" },
    });

    expect(res.status).toBe(200);
    expect(ingestedEvents()).toEqual([
      {
        eventType: "check_run",
        repoFullName: "org/repo",
        prNumber: 42,
        branch: "fix/issue-7",
        url: "https://github.com/org/repo/runs/321",
        title: "lint",
        author: null,
        body: "2 errors",
        id: "321",
        conclusion: "failure",
        checkName: "lint",
        linkedIssue: null,
        headSha: "abc123",
      },
    ]);
  });

  it("falls back to check_suite.head_branch and check_run.head_sha when the PR head is absent", async () => {
    const res = await signedRequest("check_run", {
      action: "completed",
      check_run: {
        id: 322,
        name: "test",
        head_sha: "fff999",
        conclusion: "failure",
        html_url: "https://github.com/org/repo/runs/322",
        output: { summary: null },
        check_suite: { id: 6, head_branch: "fix/other" },
        pull_requests: [{ id: 9002, number: 43, url: "https://api.github.com/repos/org/repo/pulls/43" }],
      },
      repository,
      sender,
    });

    expect(res.status).toBe(200);
    expect(ingestedEvents()).toEqual([
      expect.objectContaining({ prNumber: 43, branch: "fix/other", headSha: "fff999", body: "" }),
    ]);
  });

  it("ignores check_run with no associated pull request", async () => {
    const res = await signedRequest("check_run", {
      action: "completed",
      check_run: {
        id: 323,
        name: "lint",
        head_sha: "abc123",
        conclusion: "failure",
        html_url: "https://github.com/org/repo/runs/323",
        check_suite: { id: 7, head_branch: "main" },
        pull_requests: [],
      },
      repository,
      sender,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("No events to process");
    expect(mocks.processPrFollowupEvents).not.toHaveBeenCalled();
  });

  it("builds a merge_state event from pull_request", async () => {
    const res = await signedRequest("pull_request", {
      action: "synchronize",
      number: 42,
      before: "000111",
      after: "abc123",
      pull_request: pullRequest,
      repository,
      sender,
    });

    expect(res.status).toBe(200);
    expect(ingestedEvents()).toEqual([
      {
        eventType: "merge_state",
        repoFullName: "org/repo",
        prNumber: 42,
        branch: "fix/issue-7",
        url: "https://github.com/org/repo/pull/42",
        title: "Fix bug (#7)",
        author: "itsmiso-ai",
        mergeStateStatus: "dirty",
        id: "9001",
        linkedIssue: 7,
        prState: "open",
        prMergedAt: null,
        headSha: "abc123",
      },
    ]);
  });

  it("returns 'No events to process' for a known event with no pull_request payload", async () => {
    const res = await signedRequest("pull_request_review", { action: "submitted", repository, sender });

    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("No events to process");
    expect(mocks.processPrFollowupEvents).not.toHaveBeenCalled();
  });

  it("treats the issues event as unhandled", async () => {
    const res = await signedRequest("issues", {
      action: "opened",
      issue: { number: 1, title: "x" },
      repository,
      sender,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("Unhandled event type: issues");
    expect(mocks.processPrFollowupEvents).not.toHaveBeenCalled();
  });
});

describe("POST /api/pr-followup/webhook — rate limit", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.WEBHOOK_GATEWAY_MODE;
    process.env.WEBHOOK_SECRET = "test-secret";
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.processPrFollowupEvents.mockResolvedValue({ enqueued: 1, skipped: 0 });
  });

  it("returns 429 with Retry-After once 30 deliveries land in the window", async () => {
    const body = {
      review: { id: 1, body: "Fix this", state: "CHANGES_REQUESTED" },
      pull_request: {
        number: 42,
        html_url: "https://github.com/org/repo/pull/42",
        title: "Fix bug",
        head: { ref: "fix/issue-1" },
        base: { repo: { full_name: "org/repo" } },
      },
    };

    for (let i = 0; i < 30; i++) {
      const res = await signedRequest("pull_request_review", body);
      expect(res.status).toBe(200);
    }
    expect(mocks.processPrFollowupEvents).toHaveBeenCalledTimes(30);

    const limited = await signedRequest("pull_request_review", body);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mocks.processPrFollowupEvents).toHaveBeenCalledTimes(30);
  });

  it("checks the signature before counting against the rate limit", async () => {
    for (let i = 0; i < 31; i++) {
      const res = await signedRequest("pull_request_review", {}, "sha256=bad");
      expect(res.status).toBe(401);
    }

    const res = await signedRequest("pull_request_review", { action: "submitted" });
    expect(res.status).toBe(200);
  });
});
