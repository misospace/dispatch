import { createHash } from "crypto";

/**
 * LiteLLM session affinity for one grooming run (dispatch#1677).
 *
 * A hosted grooming run is not one model call. The exploration loop makes a
 * round-trip per tool turn, and the plan stage adds its own request, which can
 * be followed by a schema-fallback and a repair turn. LiteLLM routes each
 * request on its own, so the turns of one run land on different backends and
 * each turn rebuilds context the previous turn already had warm.
 *
 * LiteLLM pins a session when every request of it carries the same id in the
 * `x-litellm-session-id` header: the first request is routed by the normal
 * strategy and the deployment it lands on becomes the pin, and later requests
 * with that id go to that deployment while it stays healthy. This module owns
 * that id. It comes from the `GroomingRun` row, so one run has one id for its
 * whole life and two runs never share one.
 */

/** The header LiteLLM reads natively for session affinity. */
export const LITELLM_SESSION_HEADER = "x-litellm-session-id";

/**
 * The value shape LiteLLM accepts for a session id, and the shortest value it
 * treats as one. A cuid already matches, so a run id normally passes through
 * untouched; the fallback in `groomerSessionId` keeps any other value usable
 * instead of sending something a proxy could reject.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

/** Header values stay short: a longer id is hashed rather than sent whole. */
const MAX_SESSION_ID_CHARS = 128;

/** Marks a derived value, so a run id and its fallback never collide. */
const DERIVED_PREFIX = "groom-";

/**
 * The session id for one grooming run: its `GroomingRun.id` when that is
 * already a header-safe value, and a deterministic digest of it otherwise. The
 * derivation is pure, so every call site of one run gets the same id without
 * threading state, and a retry of the same run row keeps the same pin.
 */
export function groomerSessionId(groomingRunId: string): string {
  const id = groomingRunId.trim();
  if (id.length <= MAX_SESSION_ID_CHARS && SESSION_ID_PATTERN.test(id)) return id;
  return `${DERIVED_PREFIX}${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/**
 * The session headers a model request carries. Empty when the caller has no
 * session: a stateless one-shot call (the lesson feed, a lane classification)
 * stays stateless and keeps LiteLLM's normal per-request routing.
 */
export function litellmSessionHeaders(sessionId?: string | null): Record<string, string> {
  return sessionId ? { [LITELLM_SESSION_HEADER]: sessionId } : {};
}
