/**
 * Resolve the actor name for audit attribution from a request body.
 *
 * Resolution order: actor > agentName > "agent" (default).
 * Validates that the resolved value is a non-empty trimmed string <= 100 chars.
 */
export function resolveActor(body: unknown): { actor: string; error?: string } {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!raw) return { actor: "agent" };

  // Prefer `actor`, fall back to `agentName`, then default to "agent"
  let value: unknown;
  if ("actor" in raw) value = raw.actor;
  else if ("agentName" in raw) value = raw.agentName;
  else return { actor: "agent" };

  if (typeof value !== "string") {
    return { actor: "", error: "'actor'/'agentName' must be a string" };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { actor: "", error: "'actor'/'agentName' must not be empty after trimming" };
  }
  if (trimmed.length > 100) {
    return { actor: "", error: "'actor'/'agentName' must be at most 100 characters" };
  }

  return { actor: trimmed };
}
