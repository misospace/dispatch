import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { getGroomingRunDetail } from "@/lib/groomer/history";
import { jsonSafe } from "@/lib/json";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const run = await getGroomingRunDetail(prisma, id);
    if (!run) {
      return NextResponse.json({ error: "Grooming run not found" }, { status: 404 });
    }
    return NextResponse.json(jsonSafe(run));
  } catch (error) {
    console.error("Failed to fetch grooming run:", error);
    return NextResponse.json({ error: "Failed to fetch grooming run" }, { status: 500 });
  }
}
