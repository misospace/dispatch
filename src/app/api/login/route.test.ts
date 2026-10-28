import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSignIn = vi.fn();

vi.mock("@/lib/auth-next", () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

function makeRequest(url: string) {
  return new Request(url);
}

describe("GET /api/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignIn.mockReset();
  });

  it("calls signIn with provider 'oidc' and the default callbackUrl when none is provided", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    const res = (await GET(makeRequest("http://localhost/api/login"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board" });
    expect(res.status).toBe(302);
  });

  it("passes the callbackUrl query parameter to signIn", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl=%2Fboard%2Fissues"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board/issues" });
    expect(res.status).toBe(302);
  });

  it("defaults to /board when callbackUrl is empty string", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl="))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board" });
    expect(res.status).toBe(302);
  });

  it("rejects absolute https callbackUrl and falls back to /board", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl=https%3A%2F%2Fevil.example.com"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board" });
    expect(res.status).toBe(302);
  });

  it("rejects protocol-relative callbackUrl and falls back to /board", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl=%2F%2Fevil.example.com"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board" });
    expect(res.status).toBe(302);
  });

  it("rejects http absolute callbackUrl and falls back to /board", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl=http%3A%2F%2Fevil.example.com"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board" });
    expect(res.status).toBe(302);
  });

  it("allows relative paths with nested segments", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl=%2Fboard%2Finbox"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board/inbox" });
    expect(res.status).toBe(302);
  });

  it("preserves query strings and fragments on valid local callbacks", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl=%2Fboard%3Ftab%3Dissues%23card-7"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board?tab=issues#card-7" });
    expect(res.status).toBe(302);
  });

  it("rejects slash-backslash protocol-relative callbackUrl decoded by URLSearchParams", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    // Decodes to /\evil.example/path, which the URL parser normalizes to https://evil.example/path
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl=%2F%5Cevil.example%2Fpath"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board" });
    expect(res.status).toBe(302);
  });

  it("rejects backslash-only variant callbackUrl decoded by URLSearchParams", async () => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    // Decodes to /\/evil.example
    const res = (await GET(makeRequest("http://localhost/api/login?callbackUrl=%2F%5C%2Fevil.example"))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board" });
    expect(res.status).toBe(302);
  });

  it.each([
    ["tab", "%09"],
    ["newline", "%0A"],
    ["carriage return", "%0D"],
  ])("rejects callbackUrl with embedded %s decoded by URLSearchParams", async (_name, encoded) => {
    mockSignIn.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const { GET } = await import("./route");
    // Decodes to /<control>/evil.example, which the URL parser normalizes to http://evil.example/
    const res = (await GET(makeRequest(`http://localhost/api/login?callbackUrl=/${encoded}%2Fevil.example`))) as Response;

    expect(mockSignIn).toHaveBeenCalledWith("oidc", { redirectTo: "/board" });
    expect(res.status).toBe(302);
  });
});
