// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    repoFindUnique: vi.fn(),
    issueFindUnique: vi.fn(),
    issueUpdate: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findUnique: mocks.repoFindUnique },
    issue: { findUnique: mocks.issueFindUnique, update: mocks.issueUpdate },
  },
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import crypto from "node:crypto";

const WEBHOOK_SECRET = "test-secret";

function makeIssuesEvent(overrides: Record<string, any> = {}) {
  return {
    action: "labeled",
    repository: { full_name: "org/repo" },
    issue: { number: 42 },
    label: { name: "type/bug" },
    ...overrides,
  };
}

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    authedRequest("http://localhost/api/issues/webhook", {
      method: "POST",
      body,
      includeAuth: false,
      headers,
    }),
  );
}

/**
 * Builds a Request whose body bytes are exactly what the HMAC was computed
 * over, plus a valid x-hub-signature-256 header.
 */
function signedRequest(body: unknown, rawBody?: string) {
  const bodyStr = rawBody ?? JSON.stringify(body);
  const sig =
    "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(bodyStr).digest("hex");

  return new Request("http://localhost/api/issues/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-event": "issues",
      "x-hub-signature-256": sig,
    },
    body: bodyStr,
  });
}

describe("POST /api/issues/webhook", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.WEBHOOK_SECRET;
    // Default to gateway mode so existing tests pass without signature headers.
    // Signature-specific tests below explicitly unset this.
    process.env.WEBHOOK_GATEWAY_MODE = "true";
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.repoFindUnique.mockResolvedValue({ id: "repo-1", fullName: "org/repo" });
    mocks.issueFindUnique.mockResolvedValue({
      id: "issue-1",
      number: 42,
      repositoryId: "repo-1",
      labels: ["status/backlog"],
    });
    mocks.issueUpdate.mockResolvedValue({ id: "issue-1", labels: ["status/backlog"] });
  });

  describe("signature verification (fail-closed default)", () => {
    it("rejects with 503 when neither WEBHOOK_SECRET nor WEBHOOK_GATEWAY_MODE is configured", async () => {
      delete process.env.WEBHOOK_GATEWAY_MODE;

      const res = await postRequest(makeIssuesEvent(), {
        Authorization: `Bearer ${mockToken}`,
        "x-github-event": "issues",
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain("not configured");
    });

    it("processes without signature when WEBHOOK_GATEWAY_MODE is true", async () => {
      // WEBHOOK_GATEWAY_MODE is already "true" from beforeEach
      delete process.env.WEBHOOK_SECRET;

      const res = await postRequest(makeIssuesEvent(), {
        Authorization: `Bearer ${mockToken}`,
        "x-github-event": "issues",
      });

      expect(res.status).toBe(200);
      expect(mocks.issueUpdate).toHaveBeenCalledTimes(1);
    });

    it("returns 401 when no auth header is present in gateway mode", async () => {
      const res = await postRequest(makeIssuesEvent(), { "x-github-event": "issues" });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("rejects with 401 when WEBHOOK_SECRET is set but no signature header", async () => {
      delete process.env.WEBHOOK_GATEWAY_MODE;
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;

      const res = await postRequest(makeIssuesEvent(), { "x-github-event": "issues" });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Missing x-hub-signature-256");
    });

    it("rejects with 401 when signature is invalid", async () => {
      delete process.env.WEBHOOK_GATEWAY_MODE;
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;

      const res = await POST(
        new Request("http://localhost/api/issues/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-github-event": "issues",
            "x-hub-signature-256": "sha256=invalid",
          },
          body: JSON.stringify(makeIssuesEvent()),
        }),
      );

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Invalid webhook signature");
    });
  });

  describe("label cache updates (valid signature)", () => {
    beforeEach(() => {
      delete process.env.WEBHOOK_GATEWAY_MODE;
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    });

    it("adds the label and bumps lastSyncedAt on a valid HMAC labeled delivery", async () => {
      const res = await POST(signedRequest(makeIssuesEvent({ action: "labeled" })));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.labels).toEqual(["status/backlog", "type/bug"]);
      expect(mocks.issueUpdate).toHaveBeenCalledWith({
        where: { repositoryId_number: { repositoryId: "repo-1", number: 42 } },
        data: expect.objectContaining({
          labels: ["status/backlog", "type/bug"],
          lastSyncedAt: expect.any(Date),
        }),
      });
    });

    it("removes the label on a valid HMAC unlabeled delivery", async () => {
      const res = await POST(
        signedRequest(
          makeIssuesEvent({ action: "unlabeled", label: { name: "status/backlog" } }),
        ),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.labels).toEqual([]);
      expect(mocks.issueUpdate).toHaveBeenCalledWith({
        where: { repositoryId_number: { repositoryId: "repo-1", number: 42 } },
        data: expect.objectContaining({ labels: [] }),
      });
    });

    it("is a no-op when labeled with a label already present", async () => {
      const res = await POST(
        signedRequest(makeIssuesEvent({ action: "labeled", label: { name: "status/backlog" } })),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.labels).toEqual(["status/backlog"]);
      // Idempotent: the stored label set is written back unchanged.
      expect(mocks.issueUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ labels: ["status/backlog"] }),
        }),
      );
    });

    it("ignores deliveries for untracked repos without touching the issue cache", async () => {
      mocks.repoFindUnique.mockResolvedValue(null);

      const res = await POST(signedRequest(makeIssuesEvent()));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe("Repo not tracked, ignored");
      expect(mocks.issueFindUnique).not.toHaveBeenCalled();
      expect(mocks.issueUpdate).not.toHaveBeenCalled();
    });

    it("ignores PR deliveries (issue.pull_request present) without touching the issue cache", async () => {
      const res = await POST(
        signedRequest(
          makeIssuesEvent({
            action: "labeled",
            issue: { number: 42, pull_request: { url: "https://github.com/org/repo/pull/42" } },
          }),
        ),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe("Pull request event, ignored");
      expect(mocks.issueFindUnique).not.toHaveBeenCalled();
      expect(mocks.issueUpdate).not.toHaveBeenCalled();
    });

    it("ignores deliveries for unknown issue numbers without updating the cache", async () => {
      mocks.issueFindUnique.mockResolvedValue(null);

      const res = await POST(signedRequest(makeIssuesEvent()));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe("Issue not cached, ignored");
      expect(mocks.issueUpdate).not.toHaveBeenCalled();
    });
  });

  it("returns 400 when x-github-event header is missing", async () => {
    const res = await postRequest(makeIssuesEvent(), {
      Authorization: `Bearer ${mockToken}`,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing x-github-event header");
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/webhook", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockToken}`,
          "x-github-event": "issues",
        },
        body: "not-json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 200 for unhandled event type", async () => {
    const res = await postRequest({ pull_request: { number: 42 } }, {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "pull_request",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("Unhandled event type");
    expect(mocks.repoFindUnique).not.toHaveBeenCalled();
  });

  it("ignores issues actions other than labeled/unlabeled", async () => {
    const res = await postRequest(makeIssuesEvent({ action: "opened" }), {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "issues",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("Only labeled/unlabeled");
    expect(mocks.repoFindUnique).not.toHaveBeenCalled();
    expect(mocks.issueUpdate).not.toHaveBeenCalled();
  });

  it("returns 500 on processing error without leaking internals", async () => {
    mocks.repoFindUnique.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest(makeIssuesEvent(), {
      Authorization: `Bearer ${mockToken}`,
      "x-github-event": "issues",
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Webhook processing failed");
  });
});
