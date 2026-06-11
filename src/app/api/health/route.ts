import { NextResponse } from "next/server";
import { getAppVersion } from "@/lib/version";
import { prisma } from "@/lib/prisma";
import { getAuthMode } from "@/lib/auth";

export async function GET() {
  const version = getAppVersion();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      database: "ok",
      version,
      authMode: getAuthMode() || "legacy",
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      database: "error",
      version,
    }, { status: 503 });
  }
}
