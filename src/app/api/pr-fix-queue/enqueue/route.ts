import { NextResponse } from "next/server";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { enqueuePrFixItem, parseEnqueuePrFixInput } from "@/lib/pr-fix-queue";

export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.MISSION_CONTROL_AGENT_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const input = parseEnqueuePrFixInput(body);
    if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });

    const item = await enqueuePrFixItem(asPrFixQueueClient(prisma), input);
    return NextResponse.json(item);
  } catch (error) {
    console.error("Failed to enqueue PR fix item:", error);
    return NextResponse.json({ error: "Failed to enqueue PR fix item" }, { status: 500 });
  }
}
