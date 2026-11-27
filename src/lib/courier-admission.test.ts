// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAdmissionPayload,
  courierAdmissionTimeoutMs,
  getCourierAdmissionConfig,
  redactSecret,
  scrubEndpoint,
  submitAdmission,
  type AdmissionRequestFields,
} from "./courier-admission";

// #1537: the Courier HTTP admission client — configuration gate, credential
// boundary, redirect refusal, and the three delivery outcomes (created /
// resumed, rejected, uncertain).

const TOKEN = "courier-test-token";
const ENDPOINT = "https://courier.internal/v1/contributions";

function setConfigEnv(overrides: Record<string, string | undefined> = {}) {
  process.env.DISPATCH_COURIER_ADMISSION_URL = overrides.DISPATCH_COURIER_ADMISSION_URL ?? ENDPOINT;
  process.env.DISPATCH_COURIER_ADMISSION_TOKEN = overrides.DISPATCH_COURIER_ADMISSION_TOKEN ?? TOKEN;
  process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES =
    overrides.DISPATCH_COURIER_ADMISSION_NAMESPACES ?? "team-alpha, team-beta";
  if ("DISPATCH_COURIER_ADMISSION_TIMEOUT_MS" in overrides) {
    process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS = overrides.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS;
  }
}

function clearConfigEnv() {
  delete process.env.DISPATCH_COURIER_ADMISSION_URL;
  delete process.env.DISPATCH_COURIER_ADMISSION_TOKEN;
  delete process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES;
  delete process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS;
}

const FIELDS: AdmissionRequestFields = {
  namespace: "team-alpha",
  lane: "contribution",
  baseRepo: "acme/widgets",
  baseRef: "main",
  workRepo: "acme/widgets-fork",
  goal: "Add a widget",
  upstreamIssue: "https://github.com/acme/widgets/issues/12",
  idempotencyKey: "key-1",
};

function httpResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("getCourierAdmissionConfig", () => {
  beforeEach(() => clearConfigEnv());
  afterEach(() => clearConfigEnv());

  it("disables submission (fail-closed) when any required piece is missing", () => {
    process.env.DISPATCH_COURIER_ADMISSION_URL = ENDPOINT;
    process.env.DISPATCH_COURIER_ADMISSION_TOKEN = TOKEN;
    delete process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES;
    const noNamespaces = getCourierAdmissionConfig();
    expect(noNamespaces).toMatchObject({ ok: false });
    if (!noNamespaces.ok) expect(noNamespaces.reason).toMatch(/namespaces/i);

    process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES = "team-alpha";
    delete process.env.DISPATCH_COURIER_ADMISSION_TOKEN;
    expect(getCourierAdmissionConfig()).toMatchObject({ ok: false });

    delete process.env.DISPATCH_COURIER_ADMISSION_URL;
    process.env.DISPATCH_COURIER_ADMISSION_TOKEN = TOKEN;
    expect(getCourierAdmissionConfig()).toMatchObject({ ok: false });
  });

  it("disables submission on a non-http(s) endpoint or a URL with no host", () => {
    setConfigEnv({ DISPATCH_COURIER_ADMISSION_URL: "ftp://courier.internal/v1/contributions" });
    expect(getCourierAdmissionConfig()).toMatchObject({ ok: false });
    setConfigEnv({ DISPATCH_COURIER_ADMISSION_URL: "not a url" });
    expect(getCourierAdmissionConfig()).toMatchObject({ ok: false });
  });

  it("resolves a valid configuration with parsed namespaces", () => {
    setConfigEnv();
    const config = getCourierAdmissionConfig();
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.endpoint.toString()).toBe(ENDPOINT);
      expect(config.token).toBe(TOKEN);
      expect(config.namespaces).toEqual(["team-alpha", "team-beta"]);
    }
  });

  it("floors the configured timeout at 1s and defaults to 30s", () => {
    delete process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS;
    expect(courierAdmissionTimeoutMs()).toBe(30_000);
    process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS = "250";
    expect(courierAdmissionTimeoutMs()).toBe(1_000);
    process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS = "5000";
    expect(courierAdmissionTimeoutMs()).toBe(5_000);
  });
});

describe("buildAdmissionPayload", () => {
  it("sends exactly the contract fields and never fresh/debug", () => {
    const payload = JSON.parse(buildAdmissionPayload(FIELDS)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "baseRef",
      "baseRepo",
      "goal",
      "idempotencyKey",
      "lane",
      "namespace",
      "upstreamIssue",
      "workRepo",
    ]);
    expect(payload.fresh).toBeUndefined();
    expect(payload.debug).toBeUndefined();
  });

  it("omits a null upstreamIssue", () => {
    const payload = JSON.parse(buildAdmissionPayload({ ...FIELDS, upstreamIssue: null })) as Record<string, unknown>;
    expect(payload.upstreamIssue).toBeUndefined();
  });
});

describe("redactSecret", () => {
  it("removes every occurrence of the credential and bounds length", () => {
    const leaky = `boom at https://x Bearer ${TOKEN} then ${TOKEN} again`;
    const redacted = redactSecret(leaky, TOKEN);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain("[redacted]");
    expect(redacted.length).toBeLessThanOrEqual(500 + "[truncated]…".length);
    expect(redactSecret("x".repeat(900), "s")).toMatch(/\[truncated\]$/);
  });
});

describe("scrubEndpoint", () => {
  it("removes origin, userinfo, and query from an echoed request URL", () => {
    const endpoint = new URL("https://user:secretpw@courier.internal:8443/v1/contributions?token=***");
    const echo = `TypeError: fetch failed: could not load ${endpoint.href} (ECONNREFUSED)`;
    const scrubbed = scrubEndpoint(echo, endpoint);
    expect(scrubbed).not.toContain("secretpw");
    expect(scrubbed).not.toContain("supersecret");
    expect(scrubbed).not.toContain("user:secretpw@");
    expect(scrubbed).not.toContain("courier.internal");
    expect(scrubbed).toContain("[scrubbed-endpoint]");
    expect(scrubbed).toContain("ECONNREFUSED");
  });

  it("scrubs a scheme-less-authority and origin echo", () => {
    const endpoint = new URL("https://user:secretpw@courier.internal:8443/v1/contributions");
    expect(scrubEndpoint("auth rejected for user:secretpw@courier.internal:8443", endpoint)).not.toContain("secretpw");
    expect(scrubEndpoint("via https://courier.internal:8443 only", endpoint)).not.toContain("courier.internal");
  });

  it("keeps a bare host a connect error names (not a secret) but scrubs the scheme origin", () => {
    // A DNS/connect error names only the host; that is not credential-bearing,
    // and scrubbing a bare `localhost` would mangle unrelated diagnostics.
    const endpoint = new URL("http://localhost:3000/v1/contributions");
    expect(scrubEndpoint("connect ECONNREFUSED localhost:3000", endpoint)).toBe("connect ECONNREFUSED localhost:3000");
    expect(scrubEndpoint("could not reach http://localhost:3000", endpoint)).not.toContain("localhost");
  });

  it("covers the raw (decoded) userinfo the operator typed", () => {
    const endpoint = new URL("https://user:p%40ss@courier.internal/v1/contributions");
    expect(scrubEndpoint("failed for user:p@ss@courier.internal", endpoint)).not.toContain("p@ss");
  });

  it("leaves unrelated text untouched, is idempotent, and no-ops on empty", () => {
    const endpoint = new URL("https://courier.internal/v1/contributions");
    const plain = "courier admission rejected with HTTP 422: lane unknown";
    expect(scrubEndpoint(plain, endpoint)).toBe(plain);
    const once = scrubEndpoint("at https://courier.internal/v1/contributions boom", endpoint);
    expect(once).toContain("[scrubbed-endpoint]");
    expect(scrubEndpoint(once, endpoint)).toBe(once);
    expect(scrubEndpoint("", endpoint)).toBe("");
  });
});

describe("redactSecret with an endpoint", () => {
  it("scrubs the endpoint URL and the bearer secret together", () => {
    const endpoint = new URL("https://user:secretpw@courier.internal/v1/contributions?token=***");
    const leaky = `request to ${endpoint.href} with ${TOKEN} failed`;
    const redacted = redactSecret(leaky, TOKEN, endpoint);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain("secretpw");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("[scrubbed-endpoint]");
  });
});

describe("submitAdmission", () => {
  const config = {
    ok: true as const,
    endpoint: new URL(ENDPOINT),
    token: TOKEN,
    namespaces: ["team-alpha"],
    timeoutMs: 30_000,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the payload with the bearer credential, no redirects, and a timeout (201 created)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      httpResponse(201, JSON.stringify({ run: "run-1", namespace: "team-alpha", workItemId: "wi-1", resumed: false })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitAdmission(FIELDS, config);

    expect(result).toMatchObject({ outcome: "created", run: "run-1", namespace: "team-alpha", workItemId: "wi-1", resumed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    // Credential guard: never follow a redirect with credentials attached.
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ idempotencyKey: "key-1", namespace: "team-alpha" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a 200 resume response to outcome resumed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        httpResponse(200, JSON.stringify({ run: "run-1", namespace: "team-alpha", workItemId: "wi-1", resumed: true })),
      ),
    );
    const result = await submitAdmission(FIELDS, config);
    expect(result).toMatchObject({ outcome: "resumed", resumed: true });
  });

  it("treats a malformed 2xx body as uncertain (identity may exist)", async () => {
    for (const body of ["not-json", JSON.stringify({ run: "run-1" }), "null"]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpResponse(201, body)));
      const result = await submitAdmission(FIELDS, config);
      expect(result).toMatchObject({ outcome: "uncertain", httpStatus: 201 });
      if (result.outcome === "uncertain") expect(result.diagnostic).toMatch(/unknown/i);
    }
  });

  it("maps 4xx responses to an explicit rejection with a bounded diagnostic", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpResponse(422, JSON.stringify({ error: "lane unknown" }))));
    const result = await submitAdmission(FIELDS, config);
    expect(result).toMatchObject({ outcome: "rejected", httpStatus: 422 });
    if (result.outcome === "rejected") expect(result.diagnostic).toContain("lane unknown");
  });

  it("maps 401/403 to an explicit rejection and never echoes the credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(httpResponse(401, JSON.stringify({ error: `bad token ${TOKEN}` }))),
    );
    const result = await submitAdmission(FIELDS, config);
    expect(result).toMatchObject({ outcome: "rejected", httpStatus: 401 });
    if (result.outcome === "rejected") expect(result.diagnostic).not.toContain(TOKEN);
  });

  it("maps 5xx to uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpResponse(503, "")));
    const result = await submitAdmission(FIELDS, config);
    expect(result).toMatchObject({ outcome: "uncertain", httpStatus: 503, timeout: false });
  });

  it("maps a timeout to uncertain with timeout=true", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError));
    const result = await submitAdmission(FIELDS, config);
    expect(result).toMatchObject({ outcome: "uncertain", timeout: true });
    if (result.outcome === "uncertain") expect(result.diagnostic).toMatch(/timed out/i);
  });

  it("maps a network failure to uncertain with timeout=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED")));
    const result = await submitAdmission(FIELDS, config);
    expect(result).toMatchObject({ outcome: "uncertain", timeout: false });
    if (result.outcome === "uncertain") expect(result.diagnostic).toContain("ECONNREFUSED");
  });

  // #1627: fetch resolves after headers arrive; a failure while READING the
  // body must settle as uncertain delivery, never escape as a throw.
  it("settles a rejected response body (AbortError/TimeoutError) as uncertain with timeout=true", async () => {
    for (const error of [
      new DOMException("body timed out", "AbortError"),
      new DOMException("body timed out", "TimeoutError"),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 201, text: () => Promise.reject(error) } as unknown as Response),
      );
      const result = await submitAdmission(FIELDS, config);
      expect(result).toMatchObject({ outcome: "uncertain", httpStatus: 201, timeout: true });
      if (result.outcome === "uncertain") expect(result.diagnostic).toMatch(/body read timed out/i);
    }
  });

  it("settles a non-timeout body-read failure as uncertain with timeout=false and a redacted diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        text: () => Promise.reject(new TypeError(`connection reset while reading with ${TOKEN}`)),
      } as unknown as Response),
    );
    const result = await submitAdmission(FIELDS, config);
    expect(result).toMatchObject({ outcome: "uncertain", httpStatus: 201, timeout: false });
    if (result.outcome === "uncertain") {
      expect(result.diagnostic).toContain("connection reset");
      expect(result.diagnostic).not.toContain(TOKEN);
    }
  });

  it("settles an unreadable 4xx body as uncertain, never a terminal rejection", async () => {
    // An unreadable error body is not proof of refusal — only a successfully
    // read 4xx response may settle as the terminal `rejected` outcome.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.reject(new TypeError("connection reset")),
      } as unknown as Response),
    );
    const result = await submitAdmission(FIELDS, config);
    expect(result).toMatchObject({ outcome: "uncertain", httpStatus: 422, timeout: false });
  });

  it("bounds a long body-read diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        text: () => Promise.reject(new Error("x".repeat(900))),
      } as unknown as Response),
    );
    const result = await submitAdmission(FIELDS, config);
    expect(result.outcome).toBe("uncertain");
    if (result.outcome === "uncertain") {
      expect(result.diagnostic).toMatch(/\[truncated\]$/);
      expect(result.diagnostic.length).toBeLessThanOrEqual(500 + "…[truncated]".length);
    }
  });

  // #1690: a runtime may echo the whole request URL in a fetch error; a
  // credential-bearing endpoint (userinfo + token query) must not survive.
  it("scrubs a credential-bearing endpoint URL echoed in a fetch failure", async () => {
    const credEndpoint = new URL("https://user:secretpw@courier.internal:8443/v1/contributions?token=***");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError(`Failed to fetch ${credEndpoint.href} — redirect refused`)),
    );
    const result = await submitAdmission(FIELDS, { ...config, endpoint: credEndpoint });
    expect(result).toMatchObject({ outcome: "uncertain", timeout: false });
    if (result.outcome === "uncertain") {
      expect(result.diagnostic).not.toContain("secretpw");
      expect(result.diagnostic).not.toContain("supersecret");
      expect(result.diagnostic).not.toContain("courier.internal");
      expect(result.diagnostic).toContain("[scrubbed-endpoint]");
      expect(result.diagnostic).toContain("redirect refused");
    }
  });
});
