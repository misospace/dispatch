import { NextResponse } from "next/server";
import { getAppVersion } from "@/lib/version";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const version = getAppVersion();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      database: "ok",
      version,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      database: "error",
      version,
    }, { status: 503 });
  }
}
