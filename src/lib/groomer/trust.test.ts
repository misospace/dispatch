import { describe, expect, it, vi } from "vitest";

import type { CollaboratorPermission, CollaboratorPermissionResult } from "@/lib/github-issues";
import {
  assessExternalEngagement,
  resolveParticipantTrust,
  type ParticipantRole,
  type TrustDeps,
} from "./trust";

const REPO = "org/repo";
const CONFIG = { trustedLogins: [] };

function depsReturning(result: CollaboratorPermissionResult): TrustDeps & { lookup: ReturnType<typeof vi.fn> } {
  return { lookup: vi.fn(async () => result) };
}

async function resolve(
  login: string | null,
  authorAssociation: string | null | undefined,
  deps: TrustDeps,
  role: ParticipantRole = "commenter",
) {
  return resolveParticipantTrust({ login, role, authorAssociation }, REPO, deps, CONFIG);
}

describe("resolveParticipantTrust", () => {
  const eligibleAssociations = ["OWNER", "MEMBER", "COLLABORATOR"] as const;
  const trustedPermissions: CollaboratorPermission[] = ["admin", "write", "maintain"];
  const insufficientPermissions: CollaboratorPermission[] = ["read", "triage", "none"];

  it.each(eligibleAssociations.flatMap((association) =>
    trustedPermissions.map((permission) => [association, permission] as const),
  ))("trusts %s when repository permission is %s", async (association, permission) => {
    const deps = depsReturning({ status: "ok", permission });

    const participant = await resolve("alice", association, deps);

    expect(participant).toMatchObject({ trusted: true, reason: `repo_permission:${permission}` });
    expect(deps.lookup).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it.each(eligibleAssociations.flatMap((association) =>
    insufficientPermissions.map((permission) => [association, permission] as const),
  ))("rejects %s with insufficient %s permission", async (association, permission) => {
    const deps = depsReturning({ status: "ok", permission });

    const participant = await resolve("alice", association, deps);

    expect(participant).toMatchObject({ trusted: false, reason: `insufficient_permission:${permission}` });
    expect(deps.lookup).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it.each(eligibleAssociations)("rejects %s when collaborator lookup returns not_found", async (association) => {
    const deps = depsReturning({ status: "not_found" });

    const participant = await resolve("alice", association, deps);

    expect(participant).toMatchObject({ trusted: false, reason: "not_a_collaborator" });
    expect(deps.lookup).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it.each(eligibleAssociations)("fails closed for %s when collaborator lookup errors", async (association) => {
    const deps = depsReturning({ status: "error", message: "GitHub unavailable" });

    const participant = await resolve("alice", association, deps);

    expect(participant).toMatchObject({
      trusted: false,
      reason: "permission_lookup_failed",
      detail: "GitHub unavailable",
    });
    expect(deps.lookup).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it.each(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", null, ""])(
    "rejects external association %s without a permission lookup",
    async (association) => {
      const deps = depsReturning({ status: "ok", permission: "admin" });

      const participant = await resolve("alice", association, deps);

      const code = typeof association === "string" && association ? association.toLowerCase() : "none";
      expect(participant).toMatchObject({ trusted: false, reason: `external_association:${code}` });
      expect(deps.lookup).not.toHaveBeenCalled();
    },
  );

  it("trusts operator allowlist entries case-insensitively before association lookup", async () => {
    const deps = depsReturning({ status: "not_found" });

    const participant = await resolveParticipantTrust(
      { login: "Alice", role: "author", authorAssociation: "NONE" },
      REPO,
      deps,
      { trustedLogins: ["ALICE"] },
    );

    expect(participant).toMatchObject({ trusted: true, reason: "operator_allowlist", role: "author" });
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  it("trusts internal automation without a permission lookup", async () => {
    const deps = depsReturning({ status: "not_found" });

    const participant = await resolve("github-actions[bot]", "NONE", deps);

    expect(participant).toMatchObject({ trusted: true, reason: "internal_automation" });
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])("rejects an empty login (%s) without lookup", async (login) => {
    const deps = depsReturning({ status: "ok", permission: "admin" });

    const participant = await resolve(login, "OWNER", deps);

    expect(participant).toMatchObject({ trusted: false, reason: "unknown_login" });
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  it("fails closed if the injected permission lookup throws", async () => {
    const deps = { lookup: vi.fn().mockRejectedValue(new Error("network failure")) };

    const participant = await resolve("alice", "MEMBER", deps);

    expect(participant).toMatchObject({
      trusted: false,
      reason: "permission_lookup_failed",
      detail: "network failure",
    });
  });
});

describe("assessExternalEngagement", () => {
  it("deduplicates commenters by lowercased login and does not re-add the author", async () => {
    const deps = depsReturning({ status: "ok", permission: "write" });

    const result = await assessExternalEngagement(
      {
        repoFullName: REPO,
        author: { login: "Alice", authorAssociation: "OWNER" },
        comments: [
          { author: "alice", authorAssociation: "NONE" },
          { author: "BOB", authorAssociation: "MEMBER" },
          { author: "bob", authorAssociation: "NONE" },
        ],
      },
      deps,
      CONFIG,
    );

    expect(result.participants).toHaveLength(2);
    expect(result.participants.map(({ login, role }) => ({ login, role }))).toEqual([
      { login: "Alice", role: "author" },
      { login: "BOB", role: "commenter" },
    ]);
    expect(deps.lookup).toHaveBeenCalledTimes(2);
    expect(result.engaged).toBe(false);
  });

  it("marks the issue externally engaged when a commenter is untrusted", async () => {
    const deps = depsReturning({ status: "ok", permission: "write" });

    const result = await assessExternalEngagement(
      {
        repoFullName: REPO,
        author: { login: "maintainer", authorAssociation: "MEMBER" },
        comments: [{ author: "external", authorAssociation: "NONE" }],
      },
      deps,
      CONFIG,
    );

    expect(result.engaged).toBe(true);
    expect(result.participants).toMatchObject([
      { login: "maintainer", trusted: true },
      { login: "external", trusted: false, reason: "external_association:none" },
    ]);
    expect(deps.lookup).toHaveBeenCalledTimes(1);
  });

  it("is not engaged when all participants are trusted through the allowlist", async () => {
    const deps = depsReturning({ status: "not_found" });

    const result = await assessExternalEngagement(
      {
        repoFullName: REPO,
        author: { login: "maintainer", authorAssociation: "NONE" },
        comments: [{ author: "reviewer", authorAssociation: "CONTRIBUTOR" }],
      },
      deps,
      { trustedLogins: ["MAINTAINER", "reviewer"] },
    );

    expect(result.engaged).toBe(false);
    expect(result.participants.every((participant) => participant.trusted)).toBe(true);
    expect(deps.lookup).not.toHaveBeenCalled();
  });
});
