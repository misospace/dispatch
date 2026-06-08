import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const AUTH_SESSION_KEY = "dispatch-auth-credentials";

function clearSession(): void {
  sessionStorage.clear();
}

describe("encodeBasicAuth", () => {
  it("encodes username:password as Base64", () => {
    const encoded = btoa("operator:s3cret");
    expect(encoded).toBe("b3BlcmF0b3I6czNjcmV0");
  });

  it("handles special characters in password", () => {
    const encoded = btoa("user:p@ss:w0rd!");
    expect(encoded).toBe("dXNlcjpwQHNzOncwcmQh");
  });
});

describe("storeBasicAuthCredentials / getStoredBasicAuthCredentials / clearBasicAuthCredentials", () => {
  beforeEach(clearSession);
  afterEach(clearSession);

  it("stores and retrieves credentials", () => {
    sessionStorage.setItem(AUTH_SESSION_KEY, "b3BlcmF0b3I6czNjcmV0");
    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).toBe("b3BlcmF0b3I6czNjcmV0");
  });

  it("returns null when no credentials stored", () => {
    clearSession();
    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
  });

  it("clears stored credentials", () => {
    sessionStorage.setItem(AUTH_SESSION_KEY, "b3BlcmF0b3I6czNjcmV0");
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
  });
});

describe("hasBasicAuthCredentials", () => {
  beforeEach(clearSession);
  afterEach(clearSession);

  it("returns true when credentials exist", () => {
    sessionStorage.setItem(AUTH_SESSION_KEY, "stored");
    expect(sessionStorage.getItem(AUTH_SESSION_KEY) !== null).toBe(true);
  });

  it("returns false when no credentials exist", () => {
    clearSession();
    expect(sessionStorage.getItem(AUTH_SESSION_KEY) !== null).toBe(false);
  });
});

describe("authedFetch", () => {
  beforeEach(() => {
    clearSession();
    // Mock global fetch
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSession();
  });

  it("attaches Basic Auth header when credentials are stored", async () => {
    const { authedFetch } = await import("./client-auth");
    sessionStorage.setItem(AUTH_SESSION_KEY, "b3BlcmF0b3I6czNjcmV0");

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await authedFetch("/api/test", { method: "POST" });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Basic b3BlcmF0b3I6czNjcmV0" }),
        method: "POST",
      })
    );
  });

  it("does not override existing Authorization header", async () => {
    const { authedFetch } = await import("./client-auth");
    sessionStorage.setItem(AUTH_SESSION_KEY, "b3BlcmF0b3I6czNjcmV0");

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await authedFetch("/api/test", {
      method: "POST",
      headers: { Authorization: "Bearer existing-token" },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer existing-token" }),
      })
    );
  });

  it("does not add Authorization header when no credentials stored", async () => {
    const { authedFetch } = await import("./client-auth");
    clearSession();

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await authedFetch("/api/test");

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    // When no credentials stored, Authorization should not be present in headers
    expect(headers.Authorization).toBeUndefined();
  });

  it("passes through other options unchanged", async () => {
    const { authedFetch } = await import("./client-auth");
    sessionStorage.setItem(AUTH_SESSION_KEY, "b3BlcmF0b3I6czNjcmV0");

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await authedFetch("/api/test", {
      method: "PUT",
      body: JSON.stringify({ key: "value" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ key: "value" }),
      })
    );
  });

  it("merges existing headers with Authorization header", async () => {
    const { authedFetch } = await import("./client-auth");
    sessionStorage.setItem(AUTH_SESSION_KEY, "b3BlcmF0b3I6czNjcmV0");

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await authedFetch("/api/test", {
      headers: { "Content-Type": "application/json" },
    });

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Basic b3BlcmF0b3I6czNjcmV0");
  });

  it("returns the fetch response", async () => {
    const { authedFetch } = await import("./client-auth");
    sessionStorage.setItem(AUTH_SESSION_KEY, "b3BlcmF0b3I6czNjcmV0");

    const mockResponse = { ok: true, status: 200 };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await authedFetch("/api/test");
    expect(result).toBe(mockResponse);
  });
});
