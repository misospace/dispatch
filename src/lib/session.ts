/**
 * Session helpers for Dispatch OIDC authentication.
 *
 * Provides utilities to check and access the current OIDC session
 * from server components, API routes, and middleware.
 */

import { auth as nextAuth } from "@/lib/auth-next";
import type { Session } from "@auth/core/types";

/**
 * Get the current session. Returns null if no session exists.
 */
export async function getSession(): Promise<Session | null> {
  return await nextAuth();
}

/**
 * Check if the current request has a valid OIDC session.
 * Useful for route handlers that need to gate access.
 */
export async function hasSession(): Promise<boolean> {
  const session = await nextAuth();
  return session !== null;
}

/**
 * Get the authenticated user's identity from the session.
 * Returns null if no session exists.
 *
 * The user object contains:
 * - name: Display name from OIDC provider
 * - email: Email from OIDC provider (if requested)
 * - subject: OIDC subject identifier (stable unique ID)
 */
export async function getSessionUser() {
  const session = await nextAuth();
  if (!session?.user) return null;
  return session.user;
}

/**
 * Require an authenticated OIDC session.
 * Throws a 401 error if no session exists.
 *
 * Use this in API routes that require OIDC authentication:
 *   const user = await requireSession();
 */
export async function requireSession() {
  const session = await nextAuth();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }
  return session.user;
}
