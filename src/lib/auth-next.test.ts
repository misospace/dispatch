import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CALLBACK_URL } from "./callback-url";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    nextAuth: vi.fn(() => ({
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      auth: vi.fn(),
    })),
  },
}));

vi.mock("next-auth", () => ({
  default: mocks.nextAuth,
}));

type AuthNextConfigForTest = {
  callbacks: {
    redirect(args: { url: string; baseUrl: string }): Promise<string>;
    session(args: {
      token: Record<string, unknown>;
      session: { user: Record<string, unknown> };
    }): Promise<{ user: Record<string, unknown> }>;
  };
  providers: Array<{ issuer?: string; wellKnown?: string; checks?: string[] }>;
};

async function loadConfig() {
  vi.resetModules();
  mocks.nextAuth.mockClear();
  await import("./auth-next");
  const calls = mocks.nextAuth.mock.calls as unknown as Array<[AuthNextConfigForTest]>;
  const config = calls[0]?.[0];
  expect(config).toBeDefined();
  return config;
}

describe("auth-next OIDC configuration", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_OIDC_ISSUER;
    delete process.env.DISPATCH_OIDC_CLIENT_ID;
    delete process.env.DISPATCH_OIDC_CLIENT_SECRET;
    delete process.env.NEXTAUTH_SECRET;
  });

  it("does not expose raw OIDC tokens on the browser session", async () => {
    const config = await loadConfig();
    const session = await config.callbacks.session({
      token: {
        sub: "subject-1",
        access_token: "raw-access-token",
        id_token: "raw-id-token",
      },
      session: { user: { email: "operator@example.com" } },
    });

    expect(session.user.subject).toBe("subject-1");
    expect(session.user.access_token).toBeUndefined();
    expect(session.user.id_token).toBeUndefined();
  });

  it("treats DISPATCH_OIDC_ISSUER as an issuer URL by default", async () => {
    process.env.DISPATCH_OIDC_ISSUER = "https://auth.example.com";

    const config = await loadConfig();
    const provider = config.providers[0];

    expect(provider.issuer).toBe("https://auth.example.com");
    expect(provider.wellKnown).toBeUndefined();
  });

  it("accepts a well-known discovery URL for compatibility", async () => {
    process.env.DISPATCH_OIDC_ISSUER = "https://auth.example.com/.well-known/openid-configuration";

    const config = await loadConfig();
    const provider = config.providers[0];

    expect(provider.wellKnown).toBe("https://auth.example.com/.well-known/openid-configuration");
    expect(provider.issuer).toBeUndefined();
  });

  it("sends state as well as pkce", async () => {
    // pkce alone omits `state`, and Authelia rejects the authorization
    // request outright: "The state is missing or does not have enough
    // characters and is therefore considered too weak." Authentik does not
    // enforce it, so the gap only shows up on some providers.
    process.env.DISPATCH_OIDC_ISSUER = "https://auth.example.com";

    const config = await loadConfig();
    const provider = config.providers[0];

    expect(provider.checks).toContain("state");
    expect(provider.checks).toContain("pkce");
  });
});

const BASE_ORIGIN = "https://dispatch.example";

function staysOnBaseOrigin(result: string): boolean {
  try {
    return new URL(result, BASE_ORIGIN).origin === BASE_ORIGIN;
  } catch {
    return false;
  }
}

describe("auth-next redirect callback", () => {
  it.each([
    "/board",
    "/",
    "/board/issues",
    "/board?tab=issues",
    "/board?tab=issues&lane=normal#card-7",
    "/custom/return",
    "/board%2Fissues",
    "/board?redirect=%2Finside",
  ])("keeps local redirect target %s on the base origin", async (url) => {
    const config = await loadConfig();
    const result = await config.callbacks.redirect({ url, baseUrl: BASE_ORIGIN });

    expect(result).toBe(new URL(url, BASE_ORIGIN).toString());
    expect(staysOnBaseOrigin(result)).toBe(true);
  });

  it("keeps an absolute same-origin redirect target", async () => {
    const config = await loadConfig();
    const result = await config.callbacks.redirect({
      url: `${BASE_ORIGIN}/board?tab=issues`,
      baseUrl: BASE_ORIGIN,
    });

    expect(result).toBe(`${BASE_ORIGIN}/board?tab=issues`);
  });

  it.each([
    ["protocol-relative URL", "//evil.example"],
    ["protocol-relative URL with path", "//evil.example/path"],
    ["absolute external URL", "https://evil.example/path"],
    ["absolute external URL (uppercase scheme)", "HTTP://evil.example/path"],
    ["slash-backslash variant", "/\\evil.example/path"],
    ["slash-backslash-slash variant", "/\\/evil.example"],
    ["tab control character", "/\t/evil.example"],
    ["newline control character", "/\n/evil.example"],
    ["carriage-return control character", "/\r/evil.example"],
    ["vertical tab", "/\v/evil.example"],
    ["form feed", "/\f/evil.example"],
    ["DEL control character", "/\x7f/evil.example"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["data: scheme", "data:text/html,<script>alert(1)</script>"],
  ])("falls back to the default callback for %s", async (_name, url) => {
    const config = await loadConfig();
    const result = await config.callbacks.redirect({ url, baseUrl: BASE_ORIGIN });

    expect(result).toBe(DEFAULT_CALLBACK_URL);
    expect(staysOnBaseOrigin(result)).toBe(true);
  });

  it("never returns a target off the base origin", async () => {
    const config = await loadConfig();
    const candidates = [
      "/board",
      "//evil.example",
      "https://evil.example/path",
      "/\\evil.example/path",
      "/\t/evil.example",
      "javascript:alert(1)",
      "not a url %",
      "",
    ];
    for (const url of candidates) {
      const result = await config.callbacks.redirect({ url, baseUrl: BASE_ORIGIN });
      expect(staysOnBaseOrigin(result)).toBe(true);
    }
  });
});
