import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requeuePrFixItem, parseRequeuePrFixInput } from "@/lib/pr-fix-queue";
import { authorizeRequest } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 } as const;

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = enforceRateLimit(`route:pr-fix-queue/requeue:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (err) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseRequeuePrFixInput(payload);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const item = await requeuePrFixItem(prisma, parsed);
    if (!item) {
      return NextResponse.json({ error: "pr-fix item not found" }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to requeue pr-fix item";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
