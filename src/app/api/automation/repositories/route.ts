import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidRepoName } from "@/lib/config";

export async function GET() {
  const repos = await prisma.automationRepo.findMany({
    orderBy: { fullName: "asc" },
    select: {
      id: true,
      fullName: true,
      name: true,
      owner: true,
      defaultBranch: true,
      lastSyncedAt: true,
      syncError: true,
    },
  });

  return NextResponse.json(repos);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const fullName = body?.repo || body?.fullName;

  if (!fullName || typeof fullName !== "string") {
    return NextResponse.json({ error: "repo fullName (owner/repo) is required" }, { status: 400 });
  }

  if (!isValidRepoName(fullName)) {
    return NextResponse.json({ error: "Invalid repo fullName format. Expected: owner/repo" }, { status: 400 });
  }

  try {
    const existing = await prisma.automationRepo.findUnique({ where: { fullName } });
    if (existing) {
      return NextResponse.json({ error: "Repo already tracked", repo: existing }, { status: 409 });
    }

    const [owner, name] = fullName.split("/");
    const repo = await prisma.automationRepo.create({
      data: {
        fullName,
        owner,
        name,
        defaultBranch: "main",
      },
    });

    return NextResponse.json({ success: true, repo }, { status: 201 });
  } catch (error) {
    console.error("Failed to add repo:", error);
    return NextResponse.json({ error: "Failed to add repo" }, { status: 500 });
  }
}