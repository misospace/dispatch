import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidRepoName } from "@/lib/config";
import { auditTrackedRepoCreateFailure, createTrackedRepo } from "@/lib/tracked-repos";
import { authorizeRequest } from "@/lib/auth";

export async function GET() {
  try {
    const repos = await prisma.repository.findMany({
      orderBy: { fullName: "asc" },
    });
    return NextResponse.json(repos);
  } catch (error) {
    console.error("Failed to fetch repos:", error);
    return NextResponse.json({ error: "Failed to fetch repositories" }, { status: 500 });
  }
}

// Deprecated compatibility endpoint. Use POST /api/automation/repos for
// tracked repository management.
export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fullName } = body as Record<string, unknown>;

  if (typeof fullName !== "string" || !fullName) {
    return NextResponse.json({ error: "fullName is required" }, { status: 400 });
  }

  if (!isValidRepoName(fullName)) {
    return NextResponse.json(
      { error: "Invalid fullName format. Expected: owner/repo" },
      { status: 400 },
    );
  }

  try {
    const { automationRepo, repository } = await createTrackedRepo(fullName);

    const response = NextResponse.json({ ...repository, automationRepoId: automationRepo.id }, { status: 201 });
    response.headers.set("Deprecation", "true");
    response.headers.set("Link", '</api/automation/repos>; rel="successor-version"');
    return response;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Repository is already tracked" }, { status: 409 });
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await auditTrackedRepoCreateFailure(fullName, errorMessage);
    console.error("Failed to create repo:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
