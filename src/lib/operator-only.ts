import type { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import type { AuthorizedRequest } from "@/lib/auth";

export function rejectAgentCaller(auth: AuthorizedRequest, action: string): NextResponse | null {
  if (auth.authorized && auth.type === "bearer") {
    return errorResponse(
      `${action} requires operator auth (OIDC session or basic auth); agent bearer tokens cannot perform it`,
      403,
    );
  }
  return null;
}
