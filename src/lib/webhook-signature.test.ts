// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;
vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { create: vi.fn() } },
}));

import { authenticateWebhookDelivery } from "./webhook-signature";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const WEBHOOK_SECRET = "test-secret";
const NOT_CONFIGURED_ERROR =
  "Webhook signature verification is not configured. Set WEBHOOK_SECRET or enable WEBHOOK_GATEWAY_MODE.";

/** Build a request plus the raw payload bytes the HMAC is computed over. */
function signedDelivery(
  body: unknown = { ok: true },
  opts: { secret?: string; signature?: string | null; headers?: Record<string, string> } = {},
) {
  const raw = JSON.stringify(body);
  const secret = opts.secret ?? WEBHOOK_SECRET;
  const computed = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const signature = opts.signature === undefined ? `sha256=${computed}` : opts.signature;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-github-event": "issues",
    ...opts.headers,
  };
  if (signature !== null) headers["x-hub-signature-256"] = signature;

  const request = new Request("http://localhost/api/issues/webhook", {
    method: "POST",
    headers,
    body: raw,
  });
  return { request, payload: Buffer.from(raw) };
}

describe("authenticateWebhookDelivery", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_GATEWAY_MODE;
    resetAuthCaches();
    resetRateLimits();
  });

  afterEach(() => {
    // Do not leak webhook env into other test files sharing this worker.
    delete process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_GATEWAY_MODE;
  });

  describe("fail-closed mode selection", () => {
    it("rejects 503 when neither WEBHOOK_SECRET nor WEBHOOK_GATEWAY_MODE is configured", async () => {
      const { request, payload } = signedDelivery();

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error("expected rejection");
      expect(result.response.status).toBe(503);
      expect((await result.response.json()).error).toBe(NOT_CONFIGURED_ERROR);
    });
  });

  describe("signature verification", () => {
    beforeEach(() => {
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    });

    it("rejects 401 when the x-hub-signature-256 header is missing", async () => {
      const { request, payload } = signedDelivery(undefined, { signature: null });

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error("expected rejection");
      expect(result.response.status).toBe(401);
      expect((await result.response.json()).error).toBe("Missing x-hub-signature-256 header");
    });

    it("rejects 401 when the signature does not match the payload", async () => {
      const { request, payload } = signedDelivery(undefined, { signature: "sha256=deadbeef" });

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error("expected rejection");
      expect(result.response.status).toBe(401);
      expect((await result.response.json()).error).toBe("Invalid webhook signature");
    });

    it("authenticates a signature-only delivery with no Authorization header", async () => {
      const { request, payload } = signedDelivery();

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(true);
      if (!result.authenticated) throw new Error("expected authentication");
      expect(result.actor).toBe("webhook");
    });

    it("rejects a signature computed over a different payload", async () => {
      const { request, payload } = signedDelivery({ ok: true });
      const other = signedDelivery({ ok: false });

      const result = await authenticateWebhookDelivery(request, other.payload, "issues-webhook");

      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error("expected rejection");
      expect(result.response.status).toBe(401);
    });

    it("does not fall back to the auth layer when the signature is invalid", async () => {
      const { request, payload } = signedDelivery(undefined, {
        signature: "sha256=deadbeef",
        headers: { Authorization: `Bearer ${mockToken}` },
      });

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error("expected rejection");
      expect(result.response.status).toBe(401);
      expect((await result.response.json()).error).toBe("Invalid webhook signature");
    });
  });

  describe("authorizeRequest fallback (gateway mode)", () => {
    beforeEach(() => {
      process.env.WEBHOOK_GATEWAY_MODE = "true";
    });

    it("rejects 401 when no credential is presented", async () => {
      const { request, payload } = signedDelivery();

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error("expected rejection");
      expect(result.response.status).toBe(401);
    });

    it("authenticates a credentialed delivery and keys the actor on the credential", async () => {
      const { request, payload } = signedDelivery(undefined, {
        headers: { Authorization: `Bearer ${mockToken}` },
      });

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(true);
      if (!result.authenticated) throw new Error("expected authentication");
      // Credential-derived, never caller-supplied.
      expect(result.actor).toMatch(/^maintainer-cred:[0-9a-f]{32}$/);
    });

    it("never takes the caller-supplied agent name as the actor", async () => {
      const { request, payload } = signedDelivery(undefined, {
        headers: { Authorization: `Bearer ${mockToken}`, "x-agent-name": "spoofed-agent" },
      });

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(true);
      if (!result.authenticated) throw new Error("expected authentication");
      expect(result.actor).not.toContain("spoofed-agent");
    });
  });

  describe("rate limiting", () => {
    beforeEach(() => {
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    });

    it("returns 429 with Retry-After once 30 deliveries land in the window", async () => {
      for (let i = 0; i < 30; i++) {
        const { request, payload } = signedDelivery();
        const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");
        expect(result.authenticated).toBe(true);
      }

      const { request, payload } = signedDelivery();
      const limited = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(limited.authenticated).toBe(false);
      if (limited.authenticated) throw new Error("expected rejection");
      expect(limited.response.status).toBe(429);
      expect((await limited.response.json()).error).toBe("Rate limit exceeded");
      const retryAfter = Number(limited.response.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      // The window is 10 seconds, so the wait can never exceed it.
      expect(retryAfter).toBeLessThanOrEqual(10);
    });

    it("keeps each route's bucket separate", async () => {
      for (let i = 0; i < 30; i++) {
        const { request, payload } = signedDelivery();
        await authenticateWebhookDelivery(request, payload, "issues-webhook");
      }

      const { request, payload } = signedDelivery();
      const other = await authenticateWebhookDelivery(request, payload, "pr-followup-webhook");

      expect(other.authenticated).toBe(true);
    });
  });
});
