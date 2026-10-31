/**
 * NextAuth v5 configuration for Dispatch OIDC authentication.
 *
 * Uses JWT-based sessions (stateless, no database required).
 * The OIDC provider is configured dynamically from environment variables.
 */

import NextAuth from "next-auth";
import type { OIDCConfig } from "@auth/core/providers/oauth";
import { CONTROL_OR_BACKSLASH, DEFAULT_CALLBACK_URL } from "./callback-url";

function getOidcProvider(): OIDCConfig<Record<string, unknown>> {
  const issuerOrDiscovery = process.env.DISPATCH_OIDC_ISSUER;
  const isDiscoveryUrl = issuerOrDiscovery?.includes("/.well-known/openid-configuration") ?? false;
  const provider: OIDCConfig<Record<string, unknown>> = {
    id: "oidc",
    name: issuerOrDiscovery ? (() => { try { return new URL(issuerOrDiscovery).hostname; } catch { return "OIDC"; } })() : "OIDC",
    type: "oidc",
    clientId: process.env.DISPATCH_OIDC_CLIENT_ID,
    clientSecret: process.env.DISPATCH_OIDC_CLIENT_SECRET,
    authorization: {
      params: {
        scope: "openid profile email",
      },
    },
    // pkce alone sends no `state`, which some providers reject outright:
    // Authelia refuses the authorization request with "The state is missing or
    // does not have enough characters and is therefore considered too weak".
    // Authentik does not enforce it, which is why this went unnoticed.
    //
    // state is the standard CSRF protection for the authorization code flow
    // and is wanted regardless of which IdP is in front; pkce covers code
    // interception, not request forgery. Auth.js generates and verifies it.
    checks: ["pkce", "state"],
  };

  if (issuerOrDiscovery) {
    if (isDiscoveryUrl) {
      provider.wellKnown = issuerOrDiscovery;
    } else {
      provider.issuer = issuerOrDiscovery;
    }
  }

  return provider;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  providers: [getOidcProvider()],
  callbacks: {
    // Re-validate every post-login redirect target as same-origin (#1466).
    //
    // Without this callback, @auth/core's default heuristic is the only gate:
    // it allows anything starting with "/" verbatim, which accepts the
    // protocol-relative `//evil.example` shape and the slash-backslash /
    // control-character variants that re-form one after URL parsing. The
    // `GET /api/login` route sanitizes `callbackUrl` through `safeCallbackUrl`
    // before calling `signIn`, but that keeps the flow safe only as long as
    // that one call survives; the framework-level entry points
    // (`/api/auth/*` with a `callbackUrl` query param or cookie) never pass
    // through it. This callback is the fail-closed backstop for both: resolve
    // the candidate against the configured base origin and keep it only if it
    // stays on that origin, otherwise fall back to the default callback URL.
    async redirect({ url, baseUrl }) {
      // The slash-backslash and C0/DEL control-character variants re-form a
      // protocol-relative URL only after browser-side stripping, so they
      // resolve to a same-origin (percent-encoded) path here and would pass
      // a bare origin check. Reject them with the same guard `safeCallbackUrl`
      // applies: the shared regex keeps both gates on one rule, so neither
      // can drift ahead of the other.
      if (CONTROL_OR_BACKSLASH.test(url)) return DEFAULT_CALLBACK_URL;
      try {
        const base = new URL(baseUrl);
        const resolved = new URL(url, base);
        if (resolved.origin === base.origin) {
          return resolved.toString();
        }
      } catch {
        // Unparseable candidate: fall back below.
      }
      return DEFAULT_CALLBACK_URL;
    },
    async session({ token, session }) {
      if (token) {
        // Ensure sub (subject) is available from OIDC id_token
        if (token.sub) {
          // @ts-expect-error — next-auth adds custom fields to session.user
          session.user.subject = token.sub;
        }
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
});
