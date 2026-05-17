import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { markPrFixItem, parseMarkPrFixInput } from "@/lib/pr-fix-queue";

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const input = parseMarkPrFixInput(body);
    if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });

    const item = await markPrFixItem(prisma, input);
    if (!item) return NextResponse.json({ error: "PR fix queue item not found" }, { status: 404 });
    return NextResponse.json(item);
  } catch (error) {
    console.error("Failed to mark PR fix queue item:", error);
    return NextResponse.json({ error: "Failed to mark PR fix queue item" }, { status: 500 });
  }
}
