// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contributionStatusUrl,
  fetchContributionStatus,
  getCourierTrackingConfig,
  isAddressableRunName,
  parseContributionStatus,
} from "./courier-tracking";

// #1538: the Courier contribution status READ client — config gate (a missing
// read token names a missing capability, never a submission failure), the
// derived status URL, the strict allowlist parse, and the read outcomes
// (ok / notFound / refused / unavailable incl. Retry-After and shape refusal).

const READ_TOKEN = "courier-read-token";
const SURFACE = "https://courier.internal/v1/contributions";

function setEnv(overrides: Record<string, string | undefined> = {}) {
  process.env.DISPATCH_COURIER_ADMISSION_URL = overrides.DISPATCH_COURIER_ADMISSION_URL ?? SURFACE;
  process.env.DISPATCH_COURIER_READ_TOKEN = overrides.DISPATCH_COURIER_READ_TOKEN ?? READ_TOKEN;
  if ("DISPATCH_COURIER_ADMISSION_TIMEOUT_MS" in overrides) {
    process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS = overrides.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS;
  }
}

function clearEnv() {
  delete process.env.DISPATCH_COURIER_ADMISSION_URL;
  delete process.env.DISPATCH_COURIER_READ_TOKEN;
  delete process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS;
}

const OK_BODY = {
  run: "courier-3f2a",
  namespace: "team-alpha",
  lane: "contribution",
  baseRepo: "acme/widgets",
  workRepo: "acme/widgets-fork",
  phase: "Verifying",
  ciParked: false,
  observedAt: "2026-11-20T10:00:00.000Z",
};

function httpResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

const okConfig = {
  ok: true as const,
  statusBase: new URL(SURFACE),
  token: READ_TOKEN,
  timeoutMs: 30_000,
};

describe("getCourierTrackingConfig", () => {
  beforeEach(() => clearEnv());
  afterEach(() => clearEnv());

  it("is unavailable (with a named reason) when the read token is missing — submission untouched", () => {
    setEnv();
    delete process.env.DISPATCH_COURIER_READ_TOKEN;
    const config = getCourierTrackingConfig();
    expect(config.ok).toBe(false);
    if (!config.ok) {
      expect(config.reason).toMatch(/tracking is unavailable/i);
      expect(config.reason).toMatch(/DISPATCH_COURIER_READ_TOKEN/);
      expect(config.reason).not.toMatch(/submission is disabled/);
    }
  });

  it("is unavailable when the endpoint is missing or malformed", () => {
    setEnv();
    delete process.env.DISPATCH_COURIER_ADMISSION_URL;
    expect(getCourierTrackingConfig()).toMatchObject({ ok: false });
    setEnv({ DISPATCH_COURIER_ADMISSION_URL: "ftp://courier.internal/v1/contributions" });
    expect(getCourierTrackingConfig()).toMatchObject({ ok: false });
    setEnv({ DISPATCH_COURIER_ADMISSION_URL: "not a url" });
    expect(getCourierTrackingConfig()).toMatchObject({ ok: false });
  });

  it("drops a configured query and hash so no query credential rides the read path", () => {
    setEnv({ DISPATCH_COURIER_ADMISSION_URL: `${SURFACE}?auth=querysecret#frag` });
    const config = getCourierTrackingConfig();
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.statusBase.toString()).toBe(SURFACE);
      expect(config.statusBase.search).toBe("");
      expect(config.statusBase.hash).toBe("");
    }
  });

  it("resolves a valid configuration and normalizes trailing slashes on the surface", () => {
    setEnv({ DISPATCH_COURIER_ADMISSION_URL: `${SURFACE}///` });
    const config = getCourierTrackingConfig();
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.statusBase.pathname).toBe("/v1/contributions");
      expect(config.token).toBe(READ_TOKEN);
      expect(config.timeoutMs).toBe(30_000);
    }
  });
});

describe("isAddressableRunName / contributionStatusUrl", () => {
  it("rejects empty, oversized, control-character, slash, and whitespace run names", () => {
    expect(isAddressableRunName("courier-3f2a")).toBe(true);
    expect(isAddressableRunName("")).toBe(false);
    expect(isAddressableRunName("x".repeat(254))).toBe(false);
    expect(isAddressableRunName("bad\nname")).toBe(false);
    expect(isAddressableRunName("a/b")).toBe(false);
    expect(isAddressableRunName("a b")).toBe(false);
  });

  it("bounds by UTF-8 BYTES and refuses dot-only path segments", () => {
    // 200 two-byte characters = 400 bytes: over the 253-byte cap.
    expect(isAddressableRunName("é".repeat(200))).toBe(false);
    expect(isAddressableRunName("é".repeat(126))).toBe(true); // 252 bytes
    expect(isAddressableRunName(".")).toBe(false);
    expect(isAddressableRunName("..")).toBe(false);
    expect(isAddressableRunName("....")).toBe(false);
  });

  it("builds <surface>/<run>?namespace=<ns> with no query inheritance", () => {
    const config = { ...okConfig, statusBase: new URL(`${SURFACE}/`) };
    const url = contributionStatusUrl(config, "courier-3f2a", "team-alpha");
    expect(url.toString()).toBe("https://courier.internal/v1/contributions/courier-3f2a?namespace=team-alpha");
    // A configured surface query/hash never rides along into the read.
    const sticky = { ...okConfig, statusBase: new URL("https://courier.internal/v1/contributions?admin=1#frag") };
    expect(contributionStatusUrl(sticky, "run-1", "ns").toString()).toBe(
      "https://courier.internal/v1/contributions/run-1?namespace=ns",
    );
  });
});

describe("parseContributionStatus", () => {
  it("parses the full contract shape including publication, cause, and timestamps", () => {
    const body = JSON.stringify({
      ...OK_BODY,
      ciParked: true,
      publication: { branch: "courier/x", headRepo: "bot/widgets", headSha: "ab12", pr: "https://github.com/acme/widgets/pull/42" },
      cause: { category: "verifier-rejection", outcome: "changes" },
      phaseEnteredAt: "2026-11-20T09:00:00.000Z",
      finishedAt: "2026-11-20T09:30:00.000Z",
      // EXTRA fields are ignored — the allowlist is the frontend's protection.
      unexpected: { huge: "payload" },
    });
    const result = parseContributionStatus(body, 200, READ_TOKEN);
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.status.phase).toBe("Verifying");
      expect(result.status.ciParked).toBe(true);
      expect(result.status.publication?.pr).toBe("https://github.com/acme/widgets/pull/42");
      expect(result.status.cause?.category).toBe("verifier-rejection");
      expect(result.status.observedAt.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    }
  });

  it("refuses an incomplete or mistyped 2xx body as an incompatible shape (never guessed)", () => {
    for (const mutation of [
      "not-json",
      "null",
      "[]",
      JSON.stringify({ ...OK_BODY, phase: undefined }),
      JSON.stringify({ ...OK_BODY, ciParked: "true" }),
      JSON.stringify({ ...OK_BODY, observedAt: "nonsense" }),
      JSON.stringify({ ...OK_BODY, publication: "pr-url" }),
    ]) {
      const result = parseContributionStatus(mutation, 200, READ_TOKEN);
      expect(result.outcome).toBe("unavailable");
      if (result.outcome === "unavailable") {
        expect(result.diagnostic).toMatch(/unrecognized shape|refused rather than guessed/i);
      }
    }
  });

  it("bounds oversized projected strings instead of trusting the source", () => {
    const result = parseContributionStatus(JSON.stringify({ ...OK_BODY, lane: "L".repeat(5000) }), 200, READ_TOKEN);
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") expect(result.status.lane.length).toBeLessThanOrEqual(1025);
  });
});

describe("fetchContributionStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs the derived URL with the READ bearer, no redirects, no cache, and a timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(200, JSON.stringify(OK_BODY)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchContributionStatus("courier-3f2a", "team-alpha", okConfig);
    expect(result).toMatchObject({ outcome: "ok" });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://courier.internal/v1/contributions/courier-3f2a?namespace=team-alpha");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${READ_TOKEN}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never sends the read for a stored run name that is not addressable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchContributionStatus("bad name", "team-alpha", okConfig);
    expect(result).toMatchObject({ outcome: "refused", httpStatus: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the shared 404 to notFound (missing | foreign | reaped, never confirmed)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpResponse(404, JSON.stringify({ error: "contribution run not found" }))));
    const result = await fetchContributionStatus("run-1", "ns", okConfig);
    expect(result).toMatchObject({ outcome: "notFound" });
  });

  it("maps 401/403/405 to refused with a bounded, token-redacted diagnostic", async () => {
    for (const status of [401, 403, 405]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpResponse(status, JSON.stringify({ error: `nope ${READ_TOKEN}` }))));
      const result = await fetchContributionStatus("run-1", "ns", okConfig);
      expect(result).toMatchObject({ outcome: "refused", httpStatus: status });
      if (result.outcome === "refused") expect(result.diagnostic).not.toContain(READ_TOKEN);
    }
  });

  it("maps 503 with Retry-After to unavailable and carries the backoff", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpResponse(503, JSON.stringify({ error: "saturated" }), { "retry-after": "1" })));
    const result = await fetchContributionStatus("run-1", "ns", okConfig);
    expect(result).toMatchObject({ outcome: "unavailable", httpStatus: 503, timeout: false, retryAfterMs: 1000 });
  });

  it("maps timeouts and network failures to unavailable", async () => {
    const timeoutError = new Error("aborted");
    timeoutError.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError));
    expect(await fetchContributionStatus("run-1", "ns", okConfig)).toMatchObject({ outcome: "unavailable", timeout: true });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(`connect ${READ_TOKEN} refused`)));
    const result = await fetchContributionStatus("run-1", "ns", okConfig);
    expect(result).toMatchObject({ outcome: "unavailable", timeout: false });
    if (result.outcome === "unavailable") expect(result.diagnostic).not.toContain(READ_TOKEN);
  });

  it("settles a failed response-body read as unavailable (never a throw, never state)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.reject(new TypeError("connection reset")) } as unknown as Response),
    );
    const result = await fetchContributionStatus("run-1", "ns", okConfig);
    expect(result).toMatchObject({ outcome: "unavailable", httpStatus: 200, timeout: false });
  });

  // #1690: the read URL keeps the configured surface's userinfo, and a runtime
  // may echo it in a fetch error; the credential-bearing prefix must not survive.
  it("scrubs a credential-bearing surface URL echoed in a fetch failure", async () => {
    const credConfig = {
      ...okConfig,
      statusBase: new URL("https://user:secretpw@courier.internal:8443/v1/contributions?token=***"),
    };
    const echoed =
      "Failed to fetch https://user:secretpw@courier.internal:8443/v1/contributions/courier-3f2a?namespace=team-alpha";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(echoed)));
    const result = await fetchContributionStatus("courier-3f2a", "team-alpha", credConfig);
    expect(result).toMatchObject({ outcome: "unavailable", timeout: false });
    if (result.outcome === "unavailable") {
      expect(result.diagnostic).not.toContain("secretpw");
      expect(result.diagnostic).not.toContain("supersecret");
      expect(result.diagnostic).not.toContain("user:secretpw@");
      expect(result.diagnostic).toContain("[scrubbed-endpoint]");
    }
  });
});
