import type { CollaboratorPermissionResult } from "@/lib/github-issues";
import { isInternalAutomationAuthor } from "./context";

export type ParticipantRole = "author" | "commenter";

export interface ParticipantTrust {
  login: string;
  role: ParticipantRole;
  authorAssociation: string | null;
  trusted: boolean;
  reason: string;
  detail?: string;
}

export interface ExternalEngagement {
  engaged: boolean;
  participants: ParticipantTrust[];
}

export interface TrustDeps {
  lookup: (login: string) => Promise<CollaboratorPermissionResult>;
}

export interface TrustConfig {
  trustedLogins: readonly string[];
}

const LOOKUP_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const TRUSTED_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export async function resolveParticipantTrust(
  input: {
    login: string | null;
    role: ParticipantRole;
    authorAssociation: string | null | undefined;
  },
  repoFullName: string,
  deps: TrustDeps,
  config: TrustConfig,
): Promise<ParticipantTrust> {
  const login = input.login?.trim() ?? "";
  const normalizedLogin = login.toLowerCase();
  const authorAssociation = input.authorAssociation ?? null;
  const association = authorAssociation?.trim().toUpperCase() ?? "";

  const result = (
    trusted: boolean,
    reason: string,
    detail?: string,
  ): ParticipantTrust => ({
    login,
    role: input.role,
    authorAssociation,
    trusted,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  });

  if (!normalizedLogin) return result(false, "unknown_login");
  if (isInternalAutomationAuthor(login)) return result(true, "internal_automation");
  if (config.trustedLogins.some((trustedLogin) => trustedLogin.toLowerCase() === normalizedLogin)) {
    return result(true, "operator_allowlist");
  }

  if (LOOKUP_ASSOCIATIONS.has(association)) {
    let permission: CollaboratorPermissionResult;
    try {
      permission = await deps.lookup(login);
    } catch (error) {
      return result(
        false,
        "permission_lookup_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (permission.status === "not_found") return result(false, "not_a_collaborator");
    if (permission.status === "error") return result(false, "permission_lookup_failed", permission.message);
    if (TRUSTED_PERMISSIONS.has(permission.permission)) {
      return result(true, `repo_permission:${permission.permission}`);
    }
    return result(false, `insufficient_permission:${permission.permission}`);
  }

  return result(false, `external_association:${association.toLowerCase() || "none"}`);
}

export async function assessExternalEngagement(
  input: {
    repoFullName: string;
    author: { login: string | null; authorAssociation: string | null | undefined };
    comments: ReadonlyArray<{ author: string; authorAssociation?: string | null }>;
  },
  deps: TrustDeps,
  config: TrustConfig,
): Promise<ExternalEngagement> {
  const participants: ParticipantTrust[] = [];
  const seen = new Set<string>();

  const addParticipant = async (
    login: string | null,
    role: ParticipantRole,
    authorAssociation: string | null | undefined,
  ) => {
    const key = (login ?? "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    participants.push(
      await resolveParticipantTrust(
        { login, role, authorAssociation },
        input.repoFullName,
        deps,
        config,
      ),
    );
  };

  await addParticipant(input.author.login, "author", input.author.authorAssociation);
  for (const comment of input.comments) {
    await addParticipant(comment.author, "commenter", comment.authorAssociation);
  }

  return {
    engaged: participants.some((participant) => !participant.trusted),
    participants,
  };
}
