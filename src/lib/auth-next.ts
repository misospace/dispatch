/**
 * NextAuth v5 configuration for Dispatch OIDC authentication.
 *
 * Uses JWT-based sessions (stateless, no database required).
 * The OIDC provider is configured dynamically from environment variables.
 */

import NextAuth from "next-auth";
import type { OIDCConfig } from "@auth/core/providers/oauth";

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
    checks: ["pkce"],
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
