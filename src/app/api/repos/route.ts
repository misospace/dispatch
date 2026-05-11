import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fullName } = body;

    if (!fullName || typeof fullName !== "string") {
      return NextResponse.json({ error: "fullName is required" }, { status: 400 });
    }

    const [owner, name] = fullName.split("/");
    if (!owner || !name) {
      return NextResponse.json({ error: "Invalid fullName format. Expected: owner/repo" }, { status: 400 });
    }

    const repo = await prisma.repository.create({
      data: { name, owner, fullName },
    });

    return NextResponse.json(repo, { status: 201 });
  } catch (error) {
    console.error("Failed to create repo:", error);
    return NextResponse.json({ error: "Failed to create repository" }, { status: 500 });
  }
}