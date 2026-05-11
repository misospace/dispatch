import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const version = process.env.npm_package_version || "0.1.1";

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