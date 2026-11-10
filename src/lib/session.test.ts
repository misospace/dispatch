import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@/lib/auth-next", () => ({ auth: mocks.auth }));

const { getSession, hasSession, getSessionUser, requireSession } = await import("./session");

const session = {
  user: { name: "Alice", email: "alice@example.com", id: "subject-1" },
  expires: "2026-12-01T00:00:00.000Z",
};

describe("session helpers", () => {
  it("getSession returns the current session", async () => {
    mocks.auth.mockResolvedValue(session);
    expect(await getSession()).toBe(session);
  });

  it("getSession returns null when there is no session", async () => {
    mocks.auth.mockResolvedValue(null);
    expect(await getSession()).toBeNull();
  });

  it("hasSession reports true when a session exists and false when it does not", async () => {
    mocks.auth.mockResolvedValue(session);
    expect(await hasSession()).toBe(true);
    mocks.auth.mockResolvedValue(null);
    expect(await hasSession()).toBe(false);
  });

  it("getSessionUser returns the session user", async () => {
    mocks.auth.mockResolvedValue(session);
    expect(await getSessionUser()).toBe(session.user);
  });

  it("getSessionUser returns null when there is no session or no user", async () => {
    mocks.auth.mockResolvedValue(null);
    expect(await getSessionUser()).toBeNull();
    mocks.auth.mockResolvedValue({ expires: "2026-12-01T00:00:00.000Z" });
    expect(await getSessionUser()).toBeNull();
  });

  it("requireSession returns the session user", async () => {
    mocks.auth.mockResolvedValue(session);
    expect(await requireSession()).toBe(session.user);
  });

  it("requireSession throws Unauthorized when there is no session or no user", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(requireSession()).rejects.toThrow("Unauthorized");
    mocks.auth.mockResolvedValue({ expires: "2026-12-01T00:00:00.000Z" });
    await expect(requireSession()).rejects.toThrow("Unauthorized");
  });
});
