import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidRepoName } from "@/lib/config";

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

// AutomationRepo is the canonical tracked-repos table. POST creates an
// AutomationRepo (source=user) and a mirror Repository so the board surfaces
// the new repo without waiting for the next /api/sync.
export async function POST(request: Request) {
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

  const [owner, name] = fullName.split("/");

  try {
    const [automationRepo, repository] = await prisma.$transaction([
      prisma.automationRepo.create({
        data: { fullName, owner, name, source: "user" },
      }),
      prisma.repository.upsert({
        where: { fullName },
        create: { fullName, owner, name, enabled: true },
        update: { enabled: true },
      }),
    ]);

    await prisma.auditLog.create({
      data: {
        actor: "user",
        action: "add_tracked_repo",
        repoFullName: fullName,
        beforeLabels: [],
        afterLabels: [],
        success: true,
      },
    });

    return NextResponse.json({ ...repository, automationRepoId: automationRepo.id }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Repository is already tracked" }, { status: 409 });
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await prisma.auditLog.create({
      data: {
        actor: "user",
        action: "add_tracked_repo",
        repoFullName: fullName,
        beforeLabels: [],
        afterLabels: [],
        success: false,
        errorMessage,
      },
    });
    console.error("Failed to create repo:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}