/**
 * Logout API route for OIDC authentication.
 *
 * Clears the NextAuth session and redirects to the login page.
 */

import { signOut } from "@/lib/auth-next";
import { NextResponse } from "next/server";

export async function POST() {
  await signOut({ redirect: false });
  return NextResponse.json({ success: true });
}
