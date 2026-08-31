import { beforeEach, describe, expect, it, vi } from "vitest";

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
    session(args: {
      token: Record<string, unknown>;
      session: { user: Record<string, unknown> };
    }): Promise<{ user: Record<string, unknown> }>;
  };
  providers: Array<{ issuer?: string; wellKnown?: string }>;
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
