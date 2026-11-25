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

    it("attributes a verified delivery by its GitHub delivery GUID (#1698)", async () => {
      const { request, payload } = signedDelivery(undefined, {
        headers: { "x-github-delivery": "0f9d7d10-b3ea-4f28-8f6e-2f5f21d3a111" },
      });

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(true);
      if (!result.authenticated) throw new Error("expected authentication");
      expect(result.actor).toBe("delivery:0f9d7d10-b3ea-4f28-8f6e-2f5f21d3a111");
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

    // Gateway mode keeps the per-credential bucket unchanged (#1698): only
    // verify-mode actor resolution moved to per-delivery keying.
    it("still 429s the same credential after 30 gateway-mode deliveries", async () => {
      for (let i = 0; i < 30; i++) {
        const { request, payload } = signedDelivery(undefined, {
          headers: { Authorization: `Bearer ${mockToken}`, "x-github-delivery": crypto.randomUUID() },
        });
        const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");
        expect(result.authenticated).toBe(true);
      }

      const { request, payload } = signedDelivery(undefined, {
        headers: { Authorization: `Bearer ${mockToken}`, "x-github-delivery": crypto.randomUUID() },
      });
      const limited = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(limited.authenticated).toBe(false);
      if (limited.authenticated) throw new Error("expected rejection");
      expect(limited.response.status).toBe(429);
    });
  });

  describe("rate limiting", () => {
    beforeEach(() => {
      process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    });

    // These deliveries carry no x-github-delivery GUID, so they are not
    // shaped like real GitHub deliveries and keep the shared fallback
    // bucket (#1698).
    it("returns 429 with Retry-After once 30 GUID-less deliveries land in the window", async () => {
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

    it("keys each distinct delivery on its GitHub GUID, so a burst of valid signed deliveries is not throttled (#1698)", async () => {
      for (let i = 0; i < 35; i++) {
        const { request, payload } = signedDelivery({ n: i }, {
          headers: { "x-github-delivery": crypto.randomUUID() },
        });
        const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");
        expect(result.authenticated).toBe(true);
      }
    });

    it("caps GUID rotation of one captured signed delivery at the aggregate ceiling (#1698)", async () => {
      // A captured (body, signature) pair replayed under fresh GUIDs must
      // not mint unlimited fresh buckets: the aggregate ceiling (keyed on
      // the secret's fingerprint) is what bounds that path.
      const captured = signedDelivery({ ok: true });
      const capturedSignature = captured.request.headers.get("x-hub-signature-256") as string;

      for (let i = 0; i < 1000; i++) {
        const { request, payload } = signedDelivery({ ok: true }, {
          signature: capturedSignature,
          headers: { "x-github-delivery": crypto.randomUUID() },
        });
        const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");
        expect(result.authenticated).toBe(true);
      }

      const { request, payload } = signedDelivery({ ok: true }, {
        signature: capturedSignature,
        headers: { "x-github-delivery": crypto.randomUUID() },
      });
      const capped = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(capped.authenticated).toBe(false);
      if (capped.authenticated) throw new Error("expected rejection");
      expect(capped.response.status).toBe(429);
    });

    it("accepts a GUID at the length-cap boundary (Headers already strips header OWS)", async () => {
      const capped = "a".repeat(128);
      const { request, payload } = signedDelivery(undefined, {
        headers: { "x-github-delivery": `  ${capped}  ` },
      });

      const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(result.authenticated).toBe(true);
      if (!result.authenticated) throw new Error("expected authentication");
      expect(result.actor).toBe(`delivery:${capped}`);
    });

    it("throttles a same-GUID replay flood together (GitHub redeliveries reuse the GUID)", async () => {
      const guid = "11111111-2222-3333-4444-555555555555";
      for (let i = 0; i < 30; i++) {
        const { request, payload } = signedDelivery(undefined, {
          headers: { "x-github-delivery": guid },
        });
        const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");
        expect(result.authenticated).toBe(true);
      }

      const { request, payload } = signedDelivery(undefined, {
        headers: { "x-github-delivery": guid },
      });
      const replay = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(replay.authenticated).toBe(false);
      if (replay.authenticated) throw new Error("expected rejection");
      expect(replay.response.status).toBe(429);
    });

    it("falls back to the shared bucket when the GUID header is unusable (oversized)", async () => {
      const oversized = "g".repeat(129);
      for (let i = 0; i < 30; i++) {
        const { request, payload } = signedDelivery(undefined, {
          headers: { "x-github-delivery": oversized },
        });
        const result = await authenticateWebhookDelivery(request, payload, "issues-webhook");
        expect(result.authenticated).toBe(true);
      }

      // A GUID-less delivery contends on the same fallback bucket.
      const { request, payload } = signedDelivery();
      const limited = await authenticateWebhookDelivery(request, payload, "issues-webhook");

      expect(limited.authenticated).toBe(false);
      if (limited.authenticated) throw new Error("expected rejection");
      expect(limited.response.status).toBe(429);
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
