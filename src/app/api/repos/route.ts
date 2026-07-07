import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidRepoName } from "@/lib/config";
import { auditTrackedRepoCreateFailure, createTrackedRepo } from "@/lib/tracked-repos";
import { authorizeRequest } from "@/lib/auth";

export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
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

// Deprecated compatibility endpoint. Use POST /api/automation/repos for
// tracked repository management.
export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("Invalid JSON body", 400);
  }

  const { fullName } = body as Record<string, unknown>;

  if (typeof fullName !== "string" || !fullName) {
    return errorResponse("fullName is required", 400);
  }

  if (!isValidRepoName(fullName)) {
    return errorResponse("Invalid fullName format. Expected: owner/repo", 400);
  }

  try {
    const { automationRepo, repository } = await createTrackedRepo(fullName);

    const response = NextResponse.json({ ...repository, automationRepoId: automationRepo.id }, { status: 201 });
    response.headers.set("Deprecation", "true");
    response.headers.set("Link", '</api/automation/repos>; rel="successor-version"');
    return response;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return errorResponse("Repository is already tracked", 409);
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await auditTrackedRepoCreateFailure(fullName, errorMessage);
    console.error("Failed to create repo:", error);
    return errorResponse(errorMessage, 500);
  }
}
