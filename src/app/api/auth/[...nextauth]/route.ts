/**
 * NextAuth v5 handler for Dispatch OIDC authentication.
 *
 * When DISPATCH_AUTH_MODE=oidc, this endpoint handles:
 * - /api/auth/signin  — redirects to the OIDC provider
 * - /api/auth/callback/oidc — handles the OIDC callback
 * - /api/auth/signout — clears the session cookie
 * - /api/auth/session  — returns the current session (for client checks)
 */

import { handlers } from "@/lib/auth-next";

export const { GET, POST } = handlers;
