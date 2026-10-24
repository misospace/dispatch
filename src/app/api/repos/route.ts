import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  try {
    const repos = await prisma.repository.findMany({
      orderBy: { fullName: "asc" },
    });
    return NextResponse.json(repos);
  } catch (error) {
    console.error("Failed to fetch repos:", error);
    return errorResponse("Failed to fetch repositories", 500);
  }
}
