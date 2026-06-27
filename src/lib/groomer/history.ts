interface GroomingRunDelegateLike {
  create(args: any): Promise<any>;
  update(args: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  findUnique(args: any): Promise<any | null>;
}

export interface PrismaLike {
  groomingRun: GroomingRunDelegateLike;
}

export interface CreateGroomingRunInput {
  issueId: string;
  repoId: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  dryRun: boolean;
  labelsBefore: string[];
  laneBefore: string | null;
  model: string | null;
  provider: string | null;
  timeoutMs: number | null;
  maxContextBytes: number | null;
}

export interface GroomingRunFilters {
  repo?: string;
  issueNumber?: number;
  status?: string;
  dryRun?: boolean;
  model?: string;
  take?: number;
}

export interface UpdateGroomingRunData {
  status?: string;
  stage?: string;
  labelsAfter?: string[];
  laneAfter?: string | null;
  errorMessage?: string | null;
  model?: string | null;
  [key: string]: unknown;
}

export async function createGroomingRunRecord(
  prisma: PrismaLike,
  input: CreateGroomingRunInput,
) {
  return prisma.groomingRun.create({
    data: {
      issueId: input.issueId,
      repoId: input.repoId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueUrl: input.issueUrl,
      status: "running",
      dryRun: input.dryRun,
      stage: "selected",
      labelsBefore: input.labelsBefore,
      labelsAfter: input.labelsBefore,
      laneBefore: input.laneBefore,
      laneAfter: input.laneBefore,
      model: input.model,
      provider: input.provider,
      timeoutMs: input.timeoutMs,
      maxContextBytes: input.maxContextBytes,
    },
  });
}

export async function updateGroomingRunRecord(
  prisma: PrismaLike,
  id: string,
  data: UpdateGroomingRunData,
) {
  return prisma.groomingRun.update({
    where: { id },
    data,
  });
}

export async function completeGroomingRunRecord(
  prisma: PrismaLike,
  id: string,
  data: UpdateGroomingRunData,
) {
  return prisma.groomingRun.update({
    where: { id },
    data: {
      ...data,
      completedAt: new Date(),
    },
  });
}

export async function listGroomingRuns(
  prisma: PrismaLike,
  filters: GroomingRunFilters = {},
) {
  const where: Record<string, unknown> = {};
  if (filters.repo !== undefined) where.repoFullName = filters.repo;
  if (filters.issueNumber !== undefined) where.issueNumber = filters.issueNumber;
  if (filters.status !== undefined) where.status = filters.status;
  if (filters.dryRun !== undefined) where.dryRun = filters.dryRun;
  if (filters.model !== undefined) where.model = filters.model;

  const take = Math.max(1, Math.min(200, filters.take ?? 50));

  return prisma.groomingRun.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
    include: {
      issue: { select: { title: true, state: true } },
      agentRun: true,
    },
  });
}

export async function getGroomingRunDetail(
  prisma: PrismaLike,
  id: string,
) {
  return prisma.groomingRun.findUnique({
    where: { id },
    include: {
      issue: { include: { repository: true } },
      repo: true,
      agentRun: true,
    },
  });
}
