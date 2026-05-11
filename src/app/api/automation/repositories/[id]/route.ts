import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: "repo id is required" }, { status: 400 });
  }

  try {
    const existing = await prisma.automationRepo.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Repo not found" }, { status: 404 });
    }

    await prisma.automationRepo.delete({ where: { id } });

    return NextResponse.json({ success: true, deletedId: id });
  } catch (error) {
    console.error("Failed to delete repo:", error);
    return NextResponse.json({ error: "Failed to delete repo" }, { status: 500 });
  }
}