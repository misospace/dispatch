/**
 * NextAuth v5 configuration for Dispatch OIDC authentication.
 *
 * Uses JWT-based sessions (stateless, no database required).
 * The OIDC provider is configured dynamically from environment variables.
 */

import NextAuth from "next-auth";
import type { OIDCConfig } from "@auth/core/providers/oauth";

function getOidcProvider(): OIDCConfig<Record<string, unknown>> {
  const issuer = process.env.DISPATCH_OIDC_ISSUER;
  return {
    id: "oidc",
    name: issuer ? (() => { try { return new URL(issuer).hostname; } catch { return "OIDC"; } })() : "OIDC",
    type: "oidc",
    wellKnown: issuer,
    issuer,
    clientId: process.env.DISPATCH_OIDC_CLIENT_ID,
    clientSecret: process.env.DISPATCH_OIDC_CLIENT_SECRET,
    authorization: {
      params: {
        scope: "openid profile email",
      },
    },
    checks: ["pkce"],
  };
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  providers: [getOidcProvider()],
  callbacks: {
    async jwt({ token, account }) {
      // Initial sign in — store access token in JWT
      if (account) {
        token.access_token = account.access_token;
        token.id_token = account.id_token;
        token.session_id = account.session_id;
      }
      return token;
    },
    async session({ token, session }) {
      if (token) {
        // @ts-expect-error — next-auth adds custom fields to session.user
        session.user.access_token = token.access_token;
        // @ts-expect-error — next-auth adds custom fields to session.user
        session.user.id_token = token.id_token;
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
