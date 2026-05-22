import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    leaseFindUnique: vi.fn(),
    leaseCreate: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lease: {
      findUnique: mocks.leaseFindUnique,
      create: mocks.leaseCreate,
    },
  },
}));

vi.mock("@/lib/next-action", () => ({
  buildResumeContext: vi.fn((input) => ({ ...input, nextAction: "inspect_issue" })),
  isValidCheckpoint: vi.fn((cp) => ["issue_claimed"].includes(cp)),
}));

import { upsertLease } from "./lease";

describe("debug upsertLease", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("creates a new lease with checkpoint", async () => {
    mocks.leaseFindUnique.mockImplementation(() => Promise.resolve(null));
    mocks.leaseCreate.mockImplementation((args: any) => {
      console.log("LEASE CREATE DATA:", JSON.stringify(args.data, null, 2));
      return Promise.resolve({ id: "l-1", ...args.data });
    });

    const result = await upsertLease({ agentName: "saffron", issueId: "i-1" });

    console.log("CHECKPOINT:", (mocks.leaseCreate.mock.calls[0] as any)[0].data.checkpoint);
    expect(result.created).toBe(true);
  });
});
