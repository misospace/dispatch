import { describe, expect, it } from "vitest";
import { rejectAgentCaller } from "./operator-only";
import type { AuthorizedRequest } from "./auth";

const bearer: AuthorizedRequest = {
  authorized: true,
  type: "bearer",
  actor: "agent/alpha",
  throttleKey: "bearer:tok",
  tier: "maintainer",
};

const oidc: AuthorizedRequest = {
  authorized: true,
  type: "oidc",
  actor: "alice",
  throttleKey: "oidc:alice",
  tier: "maintainer",
};

const basic: AuthorizedRequest = {
  authorized: true,
  type: "basic",
  username: "alice",
  actor: "alice",
  throttleKey: "basic:alice",
  tier: "maintainer",
};

describe("rejectAgentCaller", () => {
  it("rejects a bearer caller with a 403 and the operator-auth message", async () => {
    const res = rejectAgentCaller(bearer, "admission override");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body).toEqual({
      error:
        "admission override requires operator auth (OIDC session or basic auth); agent bearer tokens cannot perform it",
    });
  });

  it("interpolates the action name into the rejection message", async () => {
    const res = rejectAgentCaller(bearer, "force claim");
    const body = await res!.json();
    expect(body.error).toContain("force claim requires operator auth");
  });

  it("allows an OIDC caller (returns null)", () => {
    expect(rejectAgentCaller(oidc, "admission override")).toBeNull();
  });

  it("allows a basic-auth caller (returns null)", () => {
    expect(rejectAgentCaller(basic, "admission override")).toBeNull();
  });

  it("allows an unauthorized caller (returns null)", () => {
    const unauthorized: AuthorizedRequest = { authorized: false };
    expect(rejectAgentCaller(unauthorized, "admission override")).toBeNull();
  });
});
