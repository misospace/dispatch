import { describe, expect, it } from "vitest";
import {
  backfillPrFixClaimant,
  clearPrFixClaimant,
  evaluatePrFixHandoutOwnership,
  invalidateStaleAgentLabelClaimants,
  transferPrFixClaimant,
  setPrFixClaimant,
  type PrFixQueueClient,
} from "@/lib/pr-fix-queue";

 type Row = { id: string; repo: string; issue: number; pr: number; status?: string; claimant: string | null; claimantSource: string | null };

function makeClient(initial: Row[]) {
  const rows = initial.map((row) => ({ ...row }));
  const history: Array<{ itemId: string; action: string; note: string }> = [];
  let forceContention = false;
  const client: PrFixQueueClient = {
    issue: { findFirst: async () => null },
    prFixQueueItem: {
      findMany: async ({ where }: any = {}) => rows.filter((row) => row.repo === where.repo && row.issue === where.issue && row.claimantSource === where.claimantSource && row.claimant !== null).map(({ id, claimant }) => ({ id, claimant })),
      findUnique: async ({ where }: any) => {
        const row = where.id !== undefined ? rows.find((item) => item.id === where.id) : rows.find((item) => item.repo === where.repo_pr.repo && item.pr === where.repo_pr.pr);
        return row ? { ...row } : null;
      },
      create: async () => ({}),
      update: async () => ({}),
      updateMany: async ({ where, data }: any) => {
        if (forceContention) return { count: 0 };
        const row = rows.find((item) => item.id === where.id && item.claimant === where.claimant && (where.claimantSource === undefined || item.claimantSource === where.claimantSource));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    prFixHistory: { create: async ({ data }: any) => { history.push(data); return data; } },
    $transaction: async (fn) => fn(client),
  };
  return { client, rows, history, contend: () => { forceContention = true; } };
}

const row = (id: string, claimant: string | null, claimantSource: string | null, overrides: Partial<Row> = {}): Row => ({
  id, repo: "org/repo", issue: 42, pr: 90, claimant, claimantSource, ...overrides,
});

describe("#1695 claimant invalidation and operator mutations", () => {
  it("invalidates only stale agent-label evidence and audits it", async () => {
    const fake = makeClient([row("stale", "courier-x", "agent-label"), row("present", "agent-y", "agent-label"), row("operator", "smurf", "operator"), row("author", "external-claimant", "pr-author"), row("lease", "lease-x", "lease"), row("owner", "owner-x", "owner-label"), row("unresolved", null, null), row("unknown", "ambiguous-x", null), row("other-repo", "other", "agent-label", { repo: "org/other" }), row("other-issue", "other", "agent-label", { issue: 43 })]);
    const result = await invalidateStaleAgentLabelClaimants(fake.client, { repo: "ORG/REPO", issue: 42, labelsAfter: ["agent/agent-y"] });
    expect(result).toEqual({ invalidated: 1 });
    expect(fake.rows.find((item) => item.id === "stale")).toMatchObject({ claimant: null, claimantSource: null });
    expect(fake.rows.find((item) => item.id === "present")?.claimant).toBe("agent-y");
    expect(fake.rows.filter((item) => ["operator", "author", "lease", "owner", "unknown", "other-repo", "other-issue"].includes(item.id)).every((item) => item.claimant !== null)).toBe(true);
    expect(fake.history).toHaveLength(1);
    expect(fake.history[0].note).toContain("#1695");
  });

  it("matches trimmed label names case-insensitively and invalidates genuinely stale names", async () => {
    const fake = makeClient([
      row("case", "Courier-X", "agent-label"),
      row("trimmed", "x", "agent-label"),
      row("stale", "courier-x", "agent-label", { issue: 43 }),
    ]);
    expect(await invalidateStaleAgentLabelClaimants(fake.client, {
      repo: "org/repo",
      issue: 42,
      labelsAfter: ["agent/courier-x", "agent/ x"],
    })).toEqual({ invalidated: 0 });
    expect(await invalidateStaleAgentLabelClaimants(fake.client, {
      repo: "org/repo",
      issue: 43,
      labelsAfter: ["agent/courier-y"],
    })).toEqual({ invalidated: 1 });
    expect(fake.rows.find((item) => item.id === "case")?.claimant).toBe("Courier-X");
    expect(fake.rows.find((item) => item.id === "trimmed")?.claimant).toBe("x");
    expect(fake.rows.find((item) => item.id === "stale")?.claimant).toBeNull();
  });

  it("invalidates stale agent-label evidence on FIXED tombstones", async () => {
    const fake = makeClient([row("fixed", "courier-x", "agent-label", { status: "FIXED" })]);
    expect(await invalidateStaleAgentLabelClaimants(fake.client, { repo: "org/repo", issue: 42, labelsAfter: [] })).toEqual({ invalidated: 1 });
    expect(fake.rows[0]).toMatchObject({ status: "FIXED", claimant: null, claimantSource: null });
    expect(fake.history).toHaveLength(1);
  });

  it("allows an operator stamp after invalidation returns the row to unresolved", async () => {
    const fake = makeClient([row("stale", "courier-x", "agent-label")]);
    await invalidateStaleAgentLabelClaimants(fake.client, { repo: "org/repo", issue: 42, labelsAfter: [] });
    expect(await setPrFixClaimant(fake.client, { repo: "org/repo", pr: 90, claimant: "operator-x" })).toEqual({ updated: true });
    expect(fake.rows[0]).toMatchObject({ claimant: "operator-x", claimantSource: "operator" });
    expect(fake.history).toHaveLength(2);
  });

  it("returns the row to normal resolution, which re-assigns the current owner", async () => {
    const fake = makeClient([row("stale", "courier-x", "agent-label")]);
    await invalidateStaleAgentLabelClaimants(fake.client, { repo: "org/repo", issue: 42, labelsAfter: ["agent/agent-y"] });
    expect(fake.rows[0]).toMatchObject({ claimant: null, claimantSource: null });
    // Normal resolution re-runs on the next issuance contact: the issue's
    // reconciled labels now name agent-y, so the backfill records it.
    fake.client.issue.findFirst = async () => ({ id: "issue-1", labels: ["agent/agent-y"] });
    const backfilled = await backfillPrFixClaimant(fake.client, {
      id: "stale",
      repo: "org/repo",
      issue: 42,
      author: "bot",
      claimant: fake.rows[0].claimant,
      claimantSource: fake.rows[0].claimantSource,
    });
    expect(backfilled).toEqual({ claimant: "agent-y", claimantSource: "agent-label" });
    const gate = evaluatePrFixHandoutOwnership(
      { repo: "org/repo", pr: 90, claimant: "agent-y", claimantSource: "agent-label", lane: "NORMAL" },
      "enforce",
      new Set(),
    );
    expect(gate).toMatchObject({ decision: "eligible", refusal: null });
  });

  it("does not overwrite a concurrent operator transfer", async () => {
    const fake = makeClient([row("race", "courier-x", "agent-label")]);
    const updateMany = fake.client.prFixQueueItem.updateMany;
    fake.client.prFixQueueItem.updateMany = async (args: any) => {
      Object.assign(fake.rows[0], { claimant: "operator-x", claimantSource: "operator" });
      return updateMany(args);
    };
    expect(await invalidateStaleAgentLabelClaimants(fake.client, { repo: "org/repo", issue: 42, labelsAfter: [] })).toEqual({ invalidated: 0 });
    expect(fake.rows[0]).toMatchObject({ claimant: "operator-x", claimantSource: "operator" });
    expect(fake.history).toHaveLength(0);
  });

  it("clears recorded ownership with audit and leaves unresolved observations untouched", async () => {
    const fake = makeClient([
      row("clear", "courier-x", "agent-label"),
      row("missing", null, "missing", { pr: 91 }),
      row("ambiguous", null, "ambiguous", { pr: 92 }),
    ]);
    expect(await clearPrFixClaimant(fake.client, { repo: "org/repo", pr: 90 })).toMatchObject({ updated: true, previousClaimant: "courier-x", previousSource: "agent-label" });
    expect(fake.rows[0]).toMatchObject({ claimant: null, claimantSource: null });
    expect(fake.history).toHaveLength(1);
    expect(await clearPrFixClaimant(fake.client, { repo: "org/repo", pr: 90 })).toMatchObject({ updated: true, previousClaimant: null, previousSource: null });
    for (const [pr, source] of [[91, "missing"], [92, "ambiguous"]] as const) {
      expect(await clearPrFixClaimant(fake.client, { repo: "org/repo", pr })).toEqual({ updated: true, previousClaimant: null, previousSource: source });
      expect(fake.rows.find((item) => item.pr === pr)).toMatchObject({ claimant: null, claimantSource: source });
    }
    expect(fake.history).toHaveLength(1);
    expect(await clearPrFixClaimant(fake.client, { repo: "org/repo", pr: 93 })).toMatchObject({ updated: false, reason: "not_found" });
  });

  it("transfers unresolved or recorded ownership and audits both", async () => {
    const fake = makeClient([row("transfer", "lease-x", "lease"), row("fill", null, null, { pr: 91 })]);
    expect(await transferPrFixClaimant(fake.client, { repo: "org/repo", pr: 90, claimant: " operator-x " })).toMatchObject({ updated: true, previousClaimant: "lease-x", previousSource: "lease" });
    expect(fake.rows[0]).toMatchObject({ claimant: "operator-x", claimantSource: "operator" });
    expect(await transferPrFixClaimant(fake.client, { repo: "org/repo", pr: 91, claimant: "smurf" })).toMatchObject({ updated: true, previousClaimant: null });
    expect(fake.history).toHaveLength(2);
    expect(await transferPrFixClaimant(fake.client, { repo: "org/repo", pr: 92, claimant: "smurf" })).toMatchObject({ updated: false, reason: "not_found" });
  });

  it("clear re-observes a concurrent transfer that kept the identity but flipped provenance", async () => {
    // Clear observed courier-x/agent-label; a concurrent operator transfer
    // committed courier-x/operator before clear's conditional write ran. A
    // claimant-only predicate would still match and clear the operator
    // decision without the re-read, its note claiming the stale provenance.
    const fake = makeClient([row("race", "courier-x", "agent-label")]);
    const updateMany = fake.client.prFixQueueItem.updateMany;
    let transferred = false;
    fake.client.prFixQueueItem.updateMany = async (args: any) => {
      if (!transferred) {
        transferred = true;
        Object.assign(fake.rows[0], { claimant: "courier-x", claimantSource: "operator" });
      }
      return updateMany(args);
    };
    expect(await clearPrFixClaimant(fake.client, { repo: "org/repo", pr: 90 })).toEqual({
      updated: true,
      previousClaimant: "courier-x",
      previousSource: "operator",
    });
    expect(fake.rows[0]).toMatchObject({ claimant: null, claimantSource: null });
    expect(fake.history).toHaveLength(1);
    expect(fake.history[0].note).toContain('courier-x (provenance "operator") -> (unset)');
  });

  it("transfer re-observes a concurrent write that kept the identity but flipped provenance", async () => {
    const fake = makeClient([row("race", "courier-x", "agent-label")]);
    const updateMany = fake.client.prFixQueueItem.updateMany;
    let flipped = false;
    fake.client.prFixQueueItem.updateMany = async (args: any) => {
      if (!flipped) {
        flipped = true;
        Object.assign(fake.rows[0], { claimant: "courier-x", claimantSource: "operator" });
      }
      return updateMany(args);
    };
    expect(await transferPrFixClaimant(fake.client, { repo: "org/repo", pr: 90, claimant: "operator-x" })).toEqual({
      updated: true,
      previousClaimant: "courier-x",
      previousSource: "operator",
    });
    expect(fake.rows[0]).toMatchObject({ claimant: "operator-x", claimantSource: "operator" });
    expect(fake.history).toHaveLength(1);
    expect(fake.history[0].note).toContain('courier-x (provenance "operator") -> operator-x');
  });

  it("still clears a legacy row whose provenance stayed NULL through the race window", async () => {
    // Legacy rows carry claimant with NULL provenance; the pinned pair
    // (claimant + claimantSource: null) matches them and only them.
    const fake = makeClient([row("legacy", "courier-x", null)]);
    expect(await clearPrFixClaimant(fake.client, { repo: "org/repo", pr: 90 })).toMatchObject({
      updated: true,
      previousClaimant: "courier-x",
      previousSource: null,
    });
    expect(fake.rows[0]).toMatchObject({ claimant: null, claimantSource: null });
    expect(fake.history).toHaveLength(1);
  });

  it("bounds contended writes without adding history", async () => {
    const fake = makeClient([row("contended", "courier-x", "agent-label")]);
    fake.contend();
    const result = await transferPrFixClaimant(fake.client, { repo: "org/repo", pr: 90, claimant: "operator-x" });
    expect(result).toMatchObject({ updated: false, reason: "contended" });
    expect(fake.history).toHaveLength(0);
  });
});
