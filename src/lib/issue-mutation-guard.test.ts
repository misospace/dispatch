import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARD_HEARTBEAT_MS, withIssueMutationGuard } from "./issue-mutation-guard";

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

  it("removes a freshly created ownership guard when the operation throws (#1251)", async () => {
    vi.mocked(prisma.issueMutationGuard.create).mockResolvedValue({} as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(row({ operation: "ownership", executing: true }) as never);
    vi.mocked(prisma.issueMutationGuard.deleteMany as any).mockResolvedValue({ count: 1 });
    const boom = new Error("db blip");
    await expect(
      withIssueMutationGuard({ issueId: "issue-1", operation: "ownership", agentName: "alpha", claimToken: "t1" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    // Ownership writes are local + idempotent: a failed attempt must not leave
    // an unrecoverable guard (no resume branch exists for "ownership").
    expect(prisma.issueMutationGuard.deleteMany).toHaveBeenCalledWith({ where: { issueId: "issue-1", ownerToken: "existing", executing: true } });
    expect(prisma.issueMutationGuard.updateMany).not.toHaveBeenCalled();
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

  it("allows only the exact same agent to resume a nonexecuting claim", async () => {
    vi.mocked(prisma.issueMutationGuard.create).mockRejectedValue({ code: "P2002" } as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(row({ agentName: "worker" }) as never);
    vi.mocked(prisma.issueMutationGuard.updateMany as any).mockResolvedValue({ count: 1 });
    const callback = vi.fn(async (_, context) => ({ complete: true, value: context.resuming }));
    await expect(withIssueMutationGuard({ ...request, agentName: "worker" }, callback)).resolves.toMatchObject({ status: "completed", value: true });
    expect(callback).toHaveBeenCalledOnce();
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

  it("removes a new lease guard after transient failure so a retry can acquire it", async () => {
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
    const leaseRequest = { issueId: "issue-1", operation: "lease", agentName: "worker" };
    await expect(withIssueMutationGuard(leaseRequest, async () => { throw new Error("transient"); })).rejects.toThrow("transient");
    expect(stored).toBeNull();
    const retry = await withIssueMutationGuard(leaseRequest, async () => ({ complete: true, value: "lease created" }));
    expect(retry).toMatchObject({ status: "completed", value: "lease created" });
    expect(prisma.issueMutationGuard.create).toHaveBeenCalledTimes(2);
  });

  it("allows only the exact same agent to resume a nonexecuting stale-release (#1251)", async () => {
    // The stale-work sweep fences its whole decide-and-release pipeline under
    // "stale-release". A failed release leaves the guard non-executing; the
    // NEXT sweep of the same (issue, agent) must resume it — its steps are
    // conditional updates keyed off persisted state plus an epoch-deduped
    // release, so re-entry is safe.
    vi.mocked(prisma.issueMutationGuard.create).mockRejectedValue({ code: "P2002" } as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(
      row({ operation: "stale-release", agentName: "alpha" }) as never,
    );
    vi.mocked(prisma.issueMutationGuard.updateMany as any).mockResolvedValue({ count: 1 });
    const callback = vi.fn(async (_tx, context) => ({ complete: true, value: context.resuming }));
    await expect(
      withIssueMutationGuard({ issueId: "issue-1", operation: "stale-release", agentName: "alpha" }, callback),
    ).resolves.toMatchObject({ status: "completed", value: true });
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each([
    { operation: "stale-release", agentName: "beta" },
    { operation: "claim", agentName: "alpha" },
    { operation: "lease", agentName: "alpha" },
  ])("does not let mismatched writers resume a stale-release guard", async (attempt) => {
    // Resume is exact on operation AND agent: a different agent's sweep, or
    // any claim-path writer, still gets `busy` and touches nothing.
    vi.mocked(prisma.issueMutationGuard.create).mockRejectedValue({ code: "P2002" } as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(
      row({ operation: "stale-release", agentName: "alpha" }) as never,
    );
    const callback = vi.fn();
    expect(await withIssueMutationGuard({ issueId: "issue-1", ...attempt }, callback)).toMatchObject({ status: "busy" });
    expect(callback).not.toHaveBeenCalled();
    expect(prisma.issueMutationGuard.updateMany).not.toHaveBeenCalled();
  });

  it("keeps an executing stale-release guard fail-closed to its own agent", async () => {
    // A crashed sweep leaves executing=true with no automatic takeover — the
    // same fail-closed posture as a crashed claim guard (operator-visible,
    // never silently stolen).
    vi.mocked(prisma.issueMutationGuard.create).mockRejectedValue({ code: "P2002" } as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(
      row({ operation: "stale-release", agentName: "alpha", executing: true }) as never,
    );
    expect(
      await withIssueMutationGuard({ issueId: "issue-1", operation: "stale-release", agentName: "alpha" }, vi.fn()),
    ).toMatchObject({ status: "busy" });
    expect(prisma.issueMutationGuard.updateMany).not.toHaveBeenCalled();
  });

  it("override refuses an executing guard too young to prove a crash (#1254 review)", async () => {
    // A live request-scoped writer (claim route, reconciler pass) can hold
    // its guard for seconds — stealing a YOUNG executing guard would race it
    // through the §8.7 anchor. The age fence keeps the override fail-closed
    // until no legitimate holder could still be running.
    vi.mocked(prisma.issueMutationGuard.create).mockRejectedValue({ code: "P2002" } as never);
    vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(
      row({ operation: "reconcile-release", agentName: "alpha", executing: true, updatedAt: new Date() }) as never,
    );
    vi.mocked(prisma.issueMutationGuard.deleteMany as any).mockImplementation(
      async ({ where }: any) => ({ count: where.updatedAt.lte >= new Date() ? 1 : 0 }),
    );
    const callback = vi.fn();
    expect(
      await withIssueMutationGuard({ issueId: "issue-1", operation: "claim", agentName: "beta", override: true }, callback),
    ).toMatchObject({ status: "busy" });
    expect(callback).not.toHaveBeenCalled();
    expect(prisma.issueMutationGuard.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ updatedAt: { lte: expect.any(Date) } }) }),
    );
  });

  it("override clears an executing guard older than any bounded live hold", async () => {
    vi.mocked(prisma.issueMutationGuard.create)
      .mockRejectedValueOnce({ code: "P2002" } as never)
      .mockResolvedValueOnce({} as never);
    vi.mocked(prisma.issueMutationGuard.findUnique)
      .mockResolvedValueOnce(row({ operation: "reconcile-release", agentName: "alpha", executing: true, updatedAt: new Date(Date.now() - 10 * 60_000) }) as never)
      .mockResolvedValueOnce(row({ ownerToken: "fresh", executing: true }) as never);
    vi.mocked(prisma.issueMutationGuard.deleteMany as any)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const callback = vi.fn(async () => ({ complete: true, value: "force claimed" }));
    await expect(
      withIssueMutationGuard({ issueId: "issue-1", operation: "claim", agentName: "beta", override: true }, callback),
    ).resolves.toMatchObject({ status: "completed", value: "force claimed" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("stamps the guard while a live holder runs, and stops on release (#1254 round 4)", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(prisma.issueMutationGuard.create).mockResolvedValue({} as never);
      vi.mocked(prisma.issueMutationGuard.findUnique).mockResolvedValue(row({ executing: true }) as never);
      vi.mocked(prisma.issueMutationGuard.deleteMany as any).mockResolvedValue({ count: 1 });
      let resume!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const pause = new Promise<void>((resolve) => { resume = resolve; });
      const run = withIssueMutationGuard(request, async () => {
        started();
        await pause;
        return { complete: true, value: "done" };
      });
      await entered;
      await vi.advanceTimersByTimeAsync(GUARD_HEARTBEAT_MS * 2 + 1);
      // The stamp is CAS'd to this owner's executing guard and only ever
      // refreshes `updatedAt`: it keeps the age fence honest (a stamped guard
      // is never old enough for an override) without touching fence state.
      expect(prisma.issueMutationGuard.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { issueId: "issue-1", ownerToken: "existing", executing: true },
          data: { updatedAt: expect.any(Date) },
        }),
      );
      const stampsWhileRunning = vi.mocked(prisma.issueMutationGuard.updateMany).mock.calls.length;
      resume();
      await run;
      // After release the heartbeat is stopped: no further stamps ever land.
      await vi.advanceTimersByTimeAsync(GUARD_HEARTBEAT_MS * 3);
      expect(vi.mocked(prisma.issueMutationGuard.updateMany).mock.calls.length).toBe(stampsWhileRunning);
    } finally {
      vi.useRealTimers();
    }
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

   it("stillHoldsGuard reports true while this holder still owns the anchor (#1254)", async () => {
     vi.mocked(prisma.issueMutationGuard.create).mockResolvedValue({} as never);
     vi.mocked(prisma.issueMutationGuard.deleteMany as any).mockResolvedValue({ count: 1 });
     // Acquisition read, then the callback's re-check read: both still ours.
     vi.mocked(prisma.issueMutationGuard.findUnique)
       .mockResolvedValueOnce(row({ ownerToken: "existing", executing: true }) as never)
       .mockResolvedValueOnce(row({ ownerToken: "existing", executing: true }) as never);
     const result = await withIssueMutationGuard(request, async (_tx, context) => ({
       complete: true,
       value: await context.stillHoldsGuard(),
     }));
     expect(result).toMatchObject({ status: "completed", value: true });
   });

   it("stillHoldsGuard reports false once an override re-owns the anchor (#1254)", async () => {
     vi.mocked(prisma.issueMutationGuard.create).mockResolvedValue({} as never);
     vi.mocked(prisma.issueMutationGuard.deleteMany as any).mockResolvedValue({ count: 1 });
     // Acquisition read is ours; the callback's re-check read returns a guard
     // a different ownerToken now holds — a maintainer force-claim took it.
     vi.mocked(prisma.issueMutationGuard.findUnique)
       .mockResolvedValueOnce(row({ ownerToken: "existing", executing: true }) as never)
       .mockResolvedValueOnce(row({ ownerToken: "override-owner", executing: true }) as never);
     const result = await withIssueMutationGuard(request, async (_tx, context) => ({
       complete: true,
       value: await context.stillHoldsGuard(),
     }));
     expect(result).toMatchObject({ status: "completed", value: false });
   });

   it("stillHoldsGuard reports false when the anchor row has been deleted (#1254)", async () => {
     vi.mocked(prisma.issueMutationGuard.create).mockResolvedValue({} as never);
     vi.mocked(prisma.issueMutationGuard.deleteMany as any).mockResolvedValue({ count: 1 });
     // Acquisition read is ours; the re-check read finds no row (deleted, and
     // the override's own create has not committed yet).
     vi.mocked(prisma.issueMutationGuard.findUnique)
       .mockResolvedValueOnce(row({ ownerToken: "existing", executing: true }) as never)
       .mockResolvedValueOnce(null as never);
     const result = await withIssueMutationGuard(request, async (_tx, context) => ({
       complete: true,
       value: await context.stillHoldsGuard(),
     }));
     expect(result).toMatchObject({ status: "completed", value: false });
   });
});
