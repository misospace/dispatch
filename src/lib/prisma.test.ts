import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Build-time contract for the prisma client.
 *
 * `next build` performs page-data collection that imports every route handler
 * and page module. Importing `@/lib/prisma` must NOT throw, even when
 * `DATABASE_URL` is intentionally absent (CI / local dev / static export
 * steps). The first actual *use* of the client at runtime should still
 * surface a clear error if the env var is missing.
 *
 * The previous eager implementation threw at module load (and Next.js's
 * page-data collection triggered it because the bundler inlines
 * `process.env.NODE_ENV === "production"` to `true` during `next build`,
 * stripping the guard). The fix is a lazy Proxy that defers
 * `PrismaPg`/`PrismaClient` construction until first property access.
 */

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_DISPATCH_DATABASE_URL = process.env.DISPATCH_DATABASE_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe("prisma module lazy initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    const env = process.env as Record<string, string | undefined>;
    delete env.DATABASE_URL;
    delete env.DISPATCH_DATABASE_URL;
    delete env.NODE_ENV;
  });

  afterEach(() => {
    // Restore a working DATABASE_URL for downstream tests that may share
    // the worker; vitest.setup.ts also sets a default.
    if (ORIGINAL_DATABASE_URL !== undefined) {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    } else {
      process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/dispatch_test";
    }
    if (ORIGINAL_DISPATCH_DATABASE_URL !== undefined) {
      process.env.DISPATCH_DATABASE_URL = ORIGINAL_DISPATCH_DATABASE_URL;
    }
    if (ORIGINAL_NODE_ENV !== undefined) {
      (process.env as Record<string, string | undefined>).NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  it("does not throw on import when DATABASE_URL is unset", async () => {
    await expect(import("./prisma")).resolves.toBeDefined();
  });

  it("does not construct a PrismaClient on import when DATABASE_URL is unset", async () => {
    // We can't directly observe the PrismaPg/PrismaClient constructors
    // without mocking, but we can assert that `initClient` is not
    // exercised by ensuring no delegated call yet exists: the proxy is
    // present, but accessing a non-existent property returns undefined
    // (not throw) because initClient throws only on first call.
    //
    // If prisma were eager, this import would have thrown before we got
    // here, failing the previous test.
    const mod = await import("./prisma");
    expect(typeof mod.prisma).toBe("object");
    // Reading symbols that the lazy proxy would resolve by calling
    // initClient() should throw (no DATABASE_URL).
    expect(() => (mod.prisma as any).repository).toThrow(/DATABASE_URL/);
  });

  it("throws with a clear message when DATABASE_URL is missing on first access", async () => {
    const mod = await import("./prisma");
    expect(() => (mod.prisma as any).issue).toThrow(/DATABASE_URL is not set/);
    expect(() => (mod.prisma as any).$transaction).toThrow(/DATABASE_URL is not set/);
  });

  it("does not leak the missing-env error across reset cycles", async () => {
    const mod = await import("./prisma");
    // First access throws.
    expect(() => (mod.prisma as any).repository).toThrow(/DATABASE_URL/);
    // After we set DATABASE_URL and reset the cached client, next access
    // should NOT throw the missing-env error. (We don't actually connect,
    // we only verify the env gate is past.)
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    mod.__resetPrismaClientForTests();
    expect(() => (mod.prisma as any).repository).not.toThrow(/DATABASE_URL/);
  });

  it("accepts DISPATCH_DATABASE_URL as the documented alias", async () => {
    process.env.DISPATCH_DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const mod = await import("./prisma");
    expect(() => (mod.prisma as any).repository).not.toThrow(/DATABASE_URL/);
  });
});

describe("prisma DATABASE_URL sslmode handling", () => {
  let adapterCtor: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let PrismaPgMock: any;

  beforeEach(() => {
    vi.resetModules();
    adapterCtor = vi.fn((..._args: unknown[]) => undefined);
    const PrismaPgCtor: any = vi.fn(function (this: any, ...args: any[]) {
      adapterCtor(...args);
      this.adapterName = "PrismaPg";
      this.provider = "postgres";
    });
    PrismaPgMock = PrismaPgCtor;
    vi.doMock("@prisma/adapter-pg", () => ({
      PrismaPg: PrismaPgMock,
    }));
  });

  afterEach(() => {
    vi.doUnmock("@prisma/adapter-pg");
  });

  it("passes ssl: { rejectUnauthorized: false } when sslmode=no-verify is set", async () => {
    process.env.DATABASE_URL =
      "postgresql://dispatch:secret@ai-primary.ai.svc:5432/dispatch?sslmode=no-verify";
    const mod = await import("./prisma");
    // Force the cached client to be rebuilt with the new DATABASE_URL.
    mod.__resetPrismaClientForTests();
    // Touch the lazy proxy to force initClient().
    void (mod.prisma as any).repository;
    expect(adapterCtor).toHaveBeenCalledTimes(1);
    const config = adapterCtor.mock.calls[0][0] as {
      connectionString: string;
      ssl: { rejectUnauthorized: boolean };
    };
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
    // The unknown sslmode must be stripped so pg-connection-string does
    // not fall back to "prefer" and try a plaintext handshake.
    expect(new URL(config.connectionString).searchParams.has("sslmode")).toBe(false);
    expect(new URL(config.connectionString).toString()).toBe(
      "postgresql://dispatch:secret@ai-primary.ai.svc:5432/dispatch",
    );
  });

  it("leaves the URL untouched for standard sslmode values like require", async () => {
    process.env.DATABASE_URL =
      "postgresql://dispatch:secret@ai-primary.ai.svc:5432/dispatch?sslmode=require";
    const mod = await import("./prisma");
    mod.__resetPrismaClientForTests();
    void (mod.prisma as any).repository;
    expect(adapterCtor).toHaveBeenCalledTimes(1);
    const arg = adapterCtor.mock.calls[0][0];
    expect(arg).toBe(process.env.DATABASE_URL);
  });

  it("does not add explicit ssl config when sslmode is absent", async () => {
    process.env.DATABASE_URL = "postgresql://dispatch:secret@ai-primary.ai.svc:5432/dispatch";
    const mod = await import("./prisma");
    mod.__resetPrismaClientForTests();
    void (mod.prisma as any).repository;
    expect(adapterCtor).toHaveBeenCalledTimes(1);
    const arg = adapterCtor.mock.calls[0][0];
    expect(arg).toBe(process.env.DATABASE_URL);
  });

  it("falls back to passing the raw URL when it is not a parseable URL", async () => {
    process.env.DATABASE_URL = "not-a-valid-url";
    const mod = await import("./prisma");
    mod.__resetPrismaClientForTests();
    void (mod.prisma as any).repository;
    expect(adapterCtor).toHaveBeenCalledTimes(1);
    const arg = adapterCtor.mock.calls[0][0];
    expect(arg).toBe("not-a-valid-url");
  });
});
