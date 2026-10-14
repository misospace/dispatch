import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCapacitySkip,
  capacityCooldownMs,
  loadActiveCapacityHandoffs,
  newClaimToken,
  normalizeCapacity,
  recordCapacityHandoff,
  MAX_CAPACITY_LENGTH,
} from "./capacity-handoff";

describe("capacityCooldownMs (#1256)", () => {
  const prev = process.env.DISPATCH_CAPACITY_COOLDOWN_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.DISPATCH_CAPACITY_COOLDOWN_MS;
    else process.env.DISPATCH_CAPACITY_COOLDOWN_MS = prev;
  });

  it("defaults to 15 minutes", () => {
    delete process.env.DISPATCH_CAPACITY_COOLDOWN_MS;
    expect(capacityCooldownMs()).toBe(15 * 60 * 1000);
  });

  it("honors a configured override", () => {
    process.env.DISPATCH_CAPACITY_COOLDOWN_MS = "120000";
    expect(capacityCooldownMs()).toBe(120_000);
  });

  it("clamps the bound: never below 1 minute, never above 6 hours", () => {
    process.env.DISPATCH_CAPACITY_COOLDOWN_MS = "1";
    expect(capacityCooldownMs()).toBe(60_000);
    process.env.DISPATCH_CAPACITY_COOLDOWN_MS = String(99 * 60 * 60 * 1000);
    expect(capacityCooldownMs()).toBe(6 * 60 * 60 * 1000);
  });

  it("falls back to the default on garbage values", () => {
    process.env.DISPATCH_CAPACITY_COOLDOWN_MS = "not-a-number";
    expect(capacityCooldownMs()).toBe(15 * 60 * 1000);
    process.env.DISPATCH_CAPACITY_COOLDOWN_MS = "-5";
    expect(capacityCooldownMs()).toBe(15 * 60 * 1000);
    process.env.DISPATCH_CAPACITY_COOLDOWN_MS = "";
    expect(capacityCooldownMs()).toBe(15 * 60 * 1000);
  });
});

describe("normalizeCapacity (#1256)", () => {
  it("trims and accepts a bounded non-empty identifier", () => {
    expect(normalizeCapacity("  provider/model  ")).toBe("provider/model");
    expect(normalizeCapacity("x".repeat(MAX_CAPACITY_LENGTH))).toBe("x".repeat(MAX_CAPACITY_LENGTH));
  });

  it("rejects blank, oversized, and non-string values", () => {
    expect(normalizeCapacity("")).toBeNull();
    expect(normalizeCapacity("   ")).toBeNull();
    expect(normalizeCapacity("x".repeat(MAX_CAPACITY_LENGTH + 1))).toBeNull();
    expect(normalizeCapacity(undefined)).toBeNull();
    expect(normalizeCapacity(42)).toBeNull();
  });
});

describe("newClaimToken (#1256)", () => {
  it("mints distinct opaque tokens", () => {
    const a = newClaimToken();
    const b = newClaimToken();
    expect(a).toMatch(/^claim_/);
    expect(a).not.toBe(b);
  });
});

function makeHandoffClient() {
  const rows: any[] = [];
  return {
    rows,
    capacityHandoff: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `h-${rows.length + 1}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            where?.cooldownUntil?.gt == null ||
            new Date(r.cooldownUntil).getTime() > new Date(where.cooldownUntil.gt).getTime(),
        ),
      ),
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (
            where?.cooldownUntil?.lte != null &&
            new Date(rows[i].cooldownUntil).getTime() <= new Date(where.cooldownUntil.lte).getTime()
          ) {
            rows.splice(i, 1);
            count++;
          }
        }
        return { count };
      }),
    },
  };
}

describe("recordCapacityHandoff / loadActiveCapacityHandoffs (#1256)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_CAPACITY_COOLDOWN_MS;
  });

  it("persists a bounded cooldown and only loads active rows", async () => {
    const client = makeHandoffClient();
    const { cooldownUntil } = await recordCapacityHandoff(client, {
      kind: "issue",
      capacity: "provider/model-a",
      repoFullName: "Org/Repo",
      issueNumber: 7,
      agentName: "alpha",
      issueId: "issue-7",
    });
    expect(cooldownUntil.getTime()).toBeGreaterThan(Date.now());
    expect(client.rows[0]).toMatchObject({
      kind: "issue",
      capacity: "provider/model-a",
      repoFullName: "Org/Repo",
      issueNumber: 7,
      agentName: "alpha",
    });

    // Expire it manually; the active load must prune and skip it.
    client.rows[0].cooldownUntil = new Date(Date.now() - 1000);
    const active = await loadActiveCapacityHandoffs(client);
    expect(active).toHaveLength(0);
    expect(client.rows).toHaveLength(0); // lazily pruned
  });
});

const HANDOFFS = [
  { kind: "issue", capacity: "provider/model-a", repoFullName: "org/repo", issueNumber: 10, prNumber: null },
  { kind: "pr_fix", capacity: "provider/model-a", repoFullName: "Org/Repo", issueNumber: null, prNumber: 55 },
];

describe("buildCapacitySkip (#1256) — cooldown is scoped to the exhausted capacity", () => {
  it("suppresses ONLY the exhausted capacity on the handed item", () => {
    const { skipIssue, skipPr } = buildCapacitySkip(HANDOFFS, "provider/model-a");
    expect(skipIssue("org/repo", 10)).toBe(true);
    expect(skipPr("org/repo", 55)).toBe(true);
    // Other items are untouched even for the exhausted capacity.
    expect(skipIssue("org/repo", 11)).toBe(false);
    expect(skipPr("org/repo", 56)).toBe(false);
  });

  it("never suppresses an unrelated capacity — the work stays discoverable", () => {
    const { skipIssue, skipPr } = buildCapacitySkip(HANDOFFS, "provider/model-b");
    expect(skipIssue("org/repo", 10)).toBe(false);
    expect(skipPr("org/repo", 55)).toBe(false);
  });

  it("conservatively suppresses ANY cooled item for a worker that declares no capacity", () => {
    const { skipIssue, skipPr } = buildCapacitySkip(HANDOFFS, undefined);
    expect(skipIssue("org/repo", 10)).toBe(true);
    expect(skipPr("org/repo", 55)).toBe(true);
    expect(skipIssue("org/repo", 12)).toBe(false);
  });

  it("folds repo casing and never leaks a handoff into the wrong kind", () => {
    const { skipIssue, skipPr } = buildCapacitySkip(HANDOFFS, "provider/model-a");
    expect(skipIssue("ORG/repo", 10)).toBe(true);
    expect(skipPr("ORG/REPO", 55)).toBe(true);
    // The issue handoff must not suppress a PR-fix item with the same number.
    expect(skipPr("org/repo", 10)).toBe(false);
    expect(skipIssue("org/repo", 55)).toBe(false);
  });
});
