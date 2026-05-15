import { prisma } from "@/lib/prisma";

export async function createTrackedRepo(fullName: string) {
  const [owner, name] = fullName.split("/");

  const { automationRepo, repository } = await prisma.$transaction(async (tx) => {
    const automationRepo = await tx.automationRepo.create({
      data: { fullName, owner, name, source: "user" },
    });
    const repository = await tx.repository.upsert({
      where: { fullName },
      create: { fullName, owner, name, enabled: true },
      update: { owner, name, enabled: true },
    });
    await tx.auditLog.create({
      data: {
        actor: "user",
        action: "add_tracked_repo",
        repoFullName: fullName,
        beforeLabels: [],
        afterLabels: [],
        success: true,
      },
    });

    return { automationRepo, repository };
  });

  return { automationRepo, repository };
}

export async function auditTrackedRepoCreateFailure(fullName: string, errorMessage: string) {
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
}
