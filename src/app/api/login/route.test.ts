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
});
