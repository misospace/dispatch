import { describe, expect, it, vi } from "vitest";

import {
  ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS,
  MAX_SETTLEMENT_KEY_LENGTH,
  normalizeSettlementKey,
  settlementExpiresAt,
  lookupIssueHandoffSettlement,
  recordIssueHandoffSettlement,
} from "./issue-handoff-settlement";

function makeClient(record: any = null, overrides: Record<string, any> = {}) {
  const deleted: any[] = [];
  const upserts: any[] = [];
  const client: any = {
    deleted, upserts,
    issueHandoffSettlement: {
      findUnique: vi.fn(async () => record),
      upsert: vi.fn(async ({ where, create, update }: any) => { upserts.push({ where, create, update }); return create; }),
      deleteMany: vi.fn(async ({ where }: any) => { deleted.push(where); return { count: 1 }; }),
    },
    ...overrides,
  };
  return client;
}

const WHERE = { agentName: "alpha", issueId: "issue-42", settlementKey: "settle-1" };

describe("normalizeSettlementKey", () => {
  it("trims a valid key", () => {
    expect(normalizeSettlementKey("  settle-1  ")).toBe("settle-1");
  });

  it.each([undefined, null, 42, {}, ""])("rejects %p", (raw) => {
    expect(normalizeSettlementKey(raw)).toBeNull();
  });

  it("rejects a key over the length bound", () => {
    expect(normalizeSettlementKey("k".repeat(MAX_SETTLEMENT_KEY_LENGTH + 1))).toBeNull();
    expect(normalizeSettlementKey("k".repeat(MAX_SETTLEMENT_KEY_LENGTH))).toBe("k".repeat(MAX_SETTLEMENT_KEY_LENGTH));
  });
});

describe("settlementExpiresAt", () => {
  it("bounds retention to 7 days", () => {
    expect(ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const settledAt = new Date("2026-10-18T00:00:00Z");
    expect(settlementExpiresAt(settledAt).toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });
});

describe("lookupIssueHandoffSettlement", () => {
  it("returns absent when no record exists", async () => {
    const client = makeClient(null);
    expect(await lookupIssueHandoffSettlement(client, WHERE)).toEqual({ state: "absent" });
    expect(client.issueHandoffSettlement.deleteMany).not.toHaveBeenCalled();
  });

  it("returns found for an unexpired record", async () => {
    const now = new Date("2026-10-18T00:00:00Z");
    const record = { id: "s1", claimToken: "claim_a", expiresAt: new Date(now.getTime() + 1000) };
    const client = makeClient(record);
    expect(await lookupIssueHandoffSettlement(client, WHERE, now)).toEqual({ state: "found", record });
    expect(client.issueHandoffSettlement.deleteMany).not.toHaveBeenCalled();
  });

  it("prunes and reports an expired record", async () => {
    const now = new Date("2026-10-18T00:00:00Z");
    const client = makeClient({ id: "s1", claimToken: "claim_a", expiresAt: new Date(now.getTime() - 1000) });
    expect(await lookupIssueHandoffSettlement(client, WHERE, now)).toEqual({ state: "expired" });
    expect(client.issueHandoffSettlement.deleteMany).toHaveBeenCalledWith({
      where: { agentName_issueId_settlementKey: WHERE, expiresAt: { lte: now } },
    });
  });

  it("still reports expired when the prune fails", async () => {
    const now = new Date("2026-10-18T00:00:00Z");
    const client = makeClient(
      { id: "s1", claimToken: "claim_a", expiresAt: new Date(now.getTime() - 1000) },
      { issueHandoffSettlement: { findUnique: async () => ({ id: "s1", expiresAt: new Date(now.getTime() - 1000) }), upsert: async () => ({}), deleteMany: async () => { throw new Error("offline"); } } },
    );
    expect(await lookupIssueHandoffSettlement(client, WHERE, now)).toEqual({ state: "expired" });
  });

  it("reports error (not absent) when the lookup read fails", async () => {
    const client = makeClient(null, {
      issueHandoffSettlement: {
        findUnique: async () => { throw new Error("offline"); },
        upsert: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
    });
    expect(await lookupIssueHandoffSettlement(client, WHERE)).toEqual({ state: "error" });
  });
});

describe("recordIssueHandoffSettlement", () => {
  it("upserts first-write-wins with the retention deadline", async () => {
    const client = makeClient();
    const settledAt = new Date("2026-10-18T00:00:00Z");
    await recordIssueHandoffSettlement(client, {
      agentName: "alpha",
      issueId: "issue-42",
      claimToken: "claim_a",
      settlementKey: "settle-1",
      capacity: "provider/model-a",
      labels: ["status/ready"],
      status: "status/ready",
      statusNote: null,
      cooldownUntil: new Date("2026-10-18T00:15:00Z"),
      settledAt,
    });
    expect(client.upserts).toHaveLength(1);
    const { where, create, update } = client.upserts[0];
    expect(where).toEqual({ agentName_issueId_settlementKey: WHERE });
    expect(create).toMatchObject({
      agentName: "alpha",
      issueId: "issue-42",
      claimToken: "claim_a",
      settlementKey: "settle-1",
      labels: ["status/ready"],
      status: "status/ready",
      expiresAt: new Date("2026-10-25T00:00:00.000Z"),
    });
    expect(update).toEqual({});
  });
});
