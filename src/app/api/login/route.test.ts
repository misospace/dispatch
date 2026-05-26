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
});
