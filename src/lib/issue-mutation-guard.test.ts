import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIssueMutationGuard } from "./issue-mutation-guard";

vi.mock("@/lib/prisma", () => ({ prisma: {
  issueMutationGuard: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
} }));

const request = { issueId: "issue-1", operation: "claim" };
const row = (overrides = {}) => ({ issueId: "issue-1", ownerToken: "existing", operation: "claim", agentName: null, claimToken: null, executing: false, ...overrides });

describe("issue mutation guard", () => {
  let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/prisma")).prisma;
  });

  it("creates a committed fence and removes only its owner on completion", async () => {
    vi.mocked(prisma.issueMutationGuard.create).mockResolvedValue({} as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(row({ executing: true }) as never);
    vi.mocked(prisma.issueMutationGuard.deleteMany as any).mockResolvedValue({ count: 1 });
    const callback = vi.fn(async (tx, context) => ({ complete: true, value: [tx, context.resuming] }));
    await expect(withIssueMutationGuard(request, callback)).resolves.toMatchObject({ status: "completed", value: [undefined, false] });
    expect(callback).toHaveBeenCalledOnce();
    expect(prisma.issueMutationGuard.deleteMany).toHaveBeenCalledWith({ where: { issueId: "issue-1", ownerToken: "existing", executing: true } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows only the exact nonexecuting release to CAS-resume", async () => {
    vi.mocked(prisma.issueMutationGuard.create).mockRejectedValue({ code: "P2002" } as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(row({ operation: "capacity-release", agentName: "worker", claimToken: "token" }) as never);
    vi.mocked(prisma.issueMutationGuard.updateMany as any).mockResolvedValue({ count: 1 });
    const result = await withIssueMutationGuard({ issueId: "issue-1", operation: "capacity-release", agentName: "worker", claimToken: "token" }, async (_, context) => ({ complete: false, value: context.resuming }));
    expect(result).toMatchObject({ status: "retained", value: true });
    expect(prisma.issueMutationGuard.updateMany).toHaveBeenCalledWith({ where: { issueId: "issue-1", ownerToken: "existing", executing: false }, data: { executing: true } });
    expect(prisma.issueMutationGuard.updateMany).toHaveBeenLastCalledWith({ where: { issueId: "issue-1", ownerToken: "existing", executing: true }, data: { executing: false } });
  });

  it.each([
    { operation: "capacity-release", agentName: "other", claimToken: "token" },
    { operation: "capacity-release", agentName: "worker", claimToken: "other" },
    { operation: "claim", agentName: "worker", claimToken: "token" },
  ])("rejects mismatched credentials", async (attempt) => {
    vi.mocked(prisma.issueMutationGuard.create).mockRejectedValue({ code: "P2002" } as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(row({ operation: "capacity-release", agentName: "worker", claimToken: "token" }) as never);
    const callback = vi.fn();
    expect(await withIssueMutationGuard({ issueId: "issue-1", ...attempt }, callback)).toMatchObject({ status: "busy" });
    expect(callback).not.toHaveBeenCalled();
    expect(prisma.issueMutationGuard.updateMany).not.toHaveBeenCalled();
  });

  it("keeps an executing exact retry busy", async () => {
    vi.mocked(prisma.issueMutationGuard.create).mockRejectedValue({ code: "P2002" } as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(row({ operation: "capacity-release", agentName: "worker", claimToken: "token", executing: true }) as never);
    expect(await withIssueMutationGuard({ issueId: "issue-1", operation: "capacity-release", agentName: "worker", claimToken: "token" }, vi.fn())).toMatchObject({ status: "busy" });
    expect(prisma.issueMutationGuard.updateMany).not.toHaveBeenCalled();
  });

  it("blocks a same-agent reclaim while old cleanup is paused, then admits a new epoch", async () => {
    let stored: any = null;
    vi.mocked(prisma.issueMutationGuard.create as any).mockImplementation(async ({ data }: any) => {
      if (stored) throw { code: "P2002" };
      stored = { ...data };
      return stored;
    });
    vi.mocked(prisma.issueMutationGuard.findUnique as any).mockImplementation(async () => stored);
    vi.mocked(prisma.issueMutationGuard.deleteMany as any).mockImplementation(async ({ where }: any) => {
      if (stored?.ownerToken !== where.ownerToken) return { count: 0 };
      stored = null;
      return { count: 1 };
    });
    let resume!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pause = new Promise<void>((resolve) => { resume = resolve; });
    const release = withIssueMutationGuard({ issueId: "issue-1", operation: "capacity-release", agentName: "worker", claimToken: "old-token" }, async () => {
      started();
      await pause;
      return { complete: true, value: "old cleanup finished" };
    });
    await entered;
    const newClaim = vi.fn(async () => ({ complete: true, value: "new-token" }));
    expect(await withIssueMutationGuard({ ...request, agentName: "worker" }, newClaim)).toMatchObject({ status: "busy" });
    expect(newClaim).not.toHaveBeenCalled();
    resume();
    await release;
    expect(await withIssueMutationGuard({ ...request, agentName: "worker" }, newClaim)).toMatchObject({ status: "completed", value: "new-token" });
  });

  it("reopens a thrown callback but keeps the owner barrier", async () => {
    vi.mocked(prisma.issueMutationGuard.create).mockResolvedValue({} as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(row({ executing: true }) as never);
    vi.mocked(prisma.issueMutationGuard.updateMany as any).mockResolvedValue({ count: 1 });
    const error = new Error("failure");
    await expect(withIssueMutationGuard(request, async () => { throw error; })).rejects.toBe(error);
    expect(prisma.issueMutationGuard.updateMany).toHaveBeenCalledWith({ where: { issueId: "issue-1", ownerToken: "existing", executing: true }, data: { executing: false } });
    expect(prisma.issueMutationGuard.deleteMany).not.toHaveBeenCalled();
  });
});
