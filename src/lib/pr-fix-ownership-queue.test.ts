/**
 * #1569: PR-fix ORIGINAL CLAIMANT capture, backfill, recovery, and the
 * issuance ownership gate, against a minimal fake queue client. The pure
 * resolution rules live in src/lib/pr-fix-ownership.test.ts; the route-level
 * hand-out paths are covered in the next-task route suite's #1569 describe.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillPrFixClaimant,
  createLinkedPrFixItem,
  enqueuePrFixItem,
  evaluatePrFixHandoutOwnership,
  prFixOwnershipMode,
  requeuePrFixItem,
  setPrFixClaimant,
  toAgentQueuePrFixItem,
  type PrFixQueueClient,
} from "@/lib/pr-fix-queue";

function makeQueueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    repo: "org/repo",
    pr: 42,
    issue: null,
    lane: "NORMAL",
    type: "OTHER",
    status: "QUEUED",
    reason: "PR review: CHANGES_REQUESTED",
    feedback: [],
    evidenceKeys: [],
    generation: 1,
    agentHandouts: [],
    handoutAcks: [],
    handoutAckTimes: [],
    handoutReceipts: [],
    externalWaitBy: null,
    claimant: null,
    claimantSource: null,
    author: "bot",
    headSha: null,
    attemptHeadSha: null,
    outcome: null,
    decisionDetail: null,
    stagnationCount: 0,
    fixAttempts: 1,
    handoutReclaims: 0,
    staleDisposition: false,
    disposedAt: null,
    disposedEvidence: null,
    recoveryAppliedAt: null,
    dispatchedGeneration: null,
    dispatchedAt: null,
    postDispatchEvidenceKeys: [],
    evidenceSequence: 0,
    attemptEvidenceWatermark: null,
    ciParkState: null,
    url: null,
    title: null,
    branch: null,
    queuedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Minimal PrFixQueueClient surface: queue row store, history rows, plus the
 * #1569 claimant-fact surfaces (issue.findFirst / lease.findFirst) driven by
 * plain fixtures.
 */
function makeClient(
  row: ReturnType<typeof makeQueueRow> | null,
  facts: { issueRow?: { id: string; labels: string[] } | null; leaseAgent?: string | null; issueThrows?: boolean } = {},
) {
  const history: any[] = [];
  const client: any = {
    row,
    history,
    prFixQueueItem: {
      findUnique: async ({ where }: any) => {
        if (where.id !== undefined) return client.row && client.row.id === where.id ? client.row : null;
        if (where.repo_pr) return client.row && client.row.repo === where.repo_pr.repo && client.row.pr === where.repo_pr.pr ? client.row : null;
        return null;
      },
      create: async ({ data }: any) => {
        client.row = { ...makeQueueRow(), id: "item-new", ...data };
        return client.row;
      },
      update: async ({ where, data }: any) => {
        client.row = { ...client.row, ...data };
        return client.row;
      },
      updateMany: async ({ where, data }: any) => {
        if (!client.row) return { count: 0 };
        const matchesId = where.id === undefined || where.id === client.row.id;
        const matchesClaimantNull = where.claimant === undefined || where.claimant === client.row.claimant;
        if (matchesId && matchesClaimantNull) {
          client.row = { ...client.row, ...data };
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    prFixHistory: { create: async ({ data }: any) => history.push(data) },
    issue: {
      findFirst: async () => {
        if (facts.issueThrows) throw new Error("db down");
        return facts.issueRow === undefined ? null : facts.issueRow;
      },
    },
    lease: {
      findFirst: async () => (facts.leaseAgent ? { agentName: facts.leaseAgent } : null),
    },
    $transaction: async (fn: any) => fn(client),
  };
  return client as PrFixQueueClient & { row: any; history: any[] };
}

const ENQUEUE_INPUT = {
  repo: "org/repo",
  pr: 42,
  reason: "PR review: CHANGES_REQUESTED",
  feedback: "fix it",
  evidenceKey: "review:org/repo#42:1",
};

afterEach(() => {
  delete process.env.DISPATCH_PR_FIX_OWNERSHIP_MODE;
});

describe("prFixOwnershipMode (#1569)", () => {
  it("defaults to enforce and only opts out on exact off/audit", () => {
    const envWith = (value?: string) =>
      ({ NODE_ENV: "test", ...(value === undefined ? {} : { DISPATCH_PR_FIX_OWNERSHIP_MODE: value }) }) as NodeJS.ProcessEnv;
    expect(prFixOwnershipMode(envWith())).toBe("enforce");
    expect(prFixOwnershipMode(envWith("audit"))).toBe("audit");
    expect(prFixOwnershipMode(envWith(" OFF "))).toBe("off");
    // Unrecognized values fail closed to enforce.
    expect(prFixOwnershipMode(envWith("nope"))).toBe("enforce");
  });
});

describe("evaluatePrFixHandoutOwnership (#1569)", () => {
  const resolved = { repo: "org/repo", pr: 1, claimant: "courier-x", claimantSource: "agent-label", lane: "NORMAL" };
  const unresolved = { repo: "org/repo", pr: 1, claimant: null, claimantSource: null, lane: "NORMAL" };

  it("enforce: resolved passes, unresolved refuses; evidence ships either way", () => {
    expect(evaluatePrFixHandoutOwnership(resolved, "enforce")).toMatchObject({
      decision: "eligible",
      evidence: { contract: 1, originalClaimant: "courier-x", provenance: "agent-label", owningLane: "NORMAL" },
    });
    expect(evaluatePrFixHandoutOwnership(unresolved, "enforce")).toMatchObject({
      decision: "refuse",
      evidence: { originalClaimant: null, provenance: "legacy" },
    });
    expect(evaluatePrFixHandoutOwnership({ ...unresolved, claimantSource: "ambiguous" }, "enforce")).toMatchObject({
      decision: "refuse",
      evidence: { provenance: "ambiguous" },
    });
  });

  it("audit hands out anyway; off hands out without evaluating evidence refusal", () => {
    expect(evaluatePrFixHandoutOwnership(unresolved, "audit").decision).toBe("eligible");
    expect(evaluatePrFixHandoutOwnership(unresolved, "off").decision).toBe("eligible");
  });
});

describe("enqueuePrFixItem claimant capture (#1569)", () => {
  it("records the live lease holder on a brand-new row", async () => {
    const client = makeClient(null, { issueRow: { id: "iss-1", labels: [] }, leaseAgent: "courier-x" });
    await enqueuePrFixItem(client, { ...ENQUEUE_INPUT, issue: 7 });
    expect(client.row.claimant).toBe("courier-x");
    expect(client.row.claimantSource).toBe("lease");
  });

  it("records the single agent label, and the failure states on conflict or absence", async () => {
    const labeled = makeClient(null, { issueRow: { id: "iss-1", labels: ["agent/courier-x", "status/ready"] } });
    await enqueuePrFixItem(labeled, { ...ENQUEUE_INPUT, issue: 7 });
    expect(labeled.row.claimant).toBe("courier-x");
    expect(labeled.row.claimantSource).toBe("agent-label");

    const conflicting = makeClient(null, { issueRow: { id: "iss-1", labels: ["agent/one", "agent/two"] } });
    await enqueuePrFixItem(conflicting, { ...ENQUEUE_INPUT, issue: 7 });
    expect(conflicting.row.claimant).toBeNull();
    expect(conflicting.row.claimantSource).toBe("ambiguous");

    const bare = makeClient(null, { issueRow: { id: "iss-1", labels: ["status/ready"] } });
    await enqueuePrFixItem(bare, { ...ENQUEUE_INPUT, issue: 7 });
    expect(bare.row.claimantSource).toBe("missing");
  });

  it("falls back to the PR author only when no linked issue is present", async () => {
    const client = makeClient(null);
    await enqueuePrFixItem(client, { ...ENQUEUE_INPUT, author: "octocat" });
    expect(client.row.claimant).toBe("octocat");
    expect(client.row.claimantSource).toBe("pr-author");
  });

  it("backfills a legacy row on re-ingestion while the claimant is still NULL", async () => {
    const legacy = makeQueueRow({ claimant: null, claimantSource: null });
    const backfillClient = makeClient(legacy, { issueRow: { id: "iss-1", labels: ["agent/courier-x"] } });
    await enqueuePrFixItem(backfillClient, { ...ENQUEUE_INPUT, issue: 7 });
    expect(backfillClient.row.claimant).toBe("courier-x");
    expect(backfillClient.row.claimantSource).toBe("agent-label");
  });

  it("never clears or transfers a recorded claimant, even on a conflicting or failed re-observation", async () => {
    // The recovery race this guards: the periodic re-ingestion loop reads the
    // row while claimant is NULL, an operator stamp commits in the gap, and
    // the ingestion write lands with a DIFFERENT (or failure-state) value.
    const stamped = makeQueueRow({ claimant: "operator-owner", claimantSource: "operator" });
    const conflicting = makeClient(stamped, { issueRow: { id: "iss-1", labels: ["agent/someone-else"] } });
    await enqueuePrFixItem(conflicting, { ...ENQUEUE_INPUT, issue: 7 });
    expect(conflicting.row.claimant).toBe("operator-owner");
    expect(conflicting.row.claimantSource).toBe("operator");

    const failureState = makeClient(makeQueueRow({ claimant: "operator-owner", claimantSource: "operator" }), {
      issueRow: { id: "iss-1", labels: [] },
    });
    await enqueuePrFixItem(failureState, { ...ENQUEUE_INPUT, issue: 7 });
    expect(failureState.row.claimant).toBe("operator-owner");
    expect(failureState.row.claimantSource).toBe("operator");
  });

  it("leaves an existing unresolved row untouched on an unresolved observation (no churn, no stored failure state)", async () => {
    const legacy = makeQueueRow({ claimant: null, claimantSource: null });
    const client = makeClient(legacy, { issueRow: { id: "iss-1", labels: [] } });
    await enqueuePrFixItem(client, { ...ENQUEUE_INPUT, issue: 7 });
    expect(client.row.claimant).toBeNull();
    expect(client.row.claimantSource).toBeNull();
  });
});

describe("createLinkedPrFixItem claimant capture (#1569)", () => {
  it("resolves the linked issue's claimant at materialization", async () => {
    const client = makeClient(null, { issueRow: { id: "iss-1", labels: ["agent/courier-x"] } });
    const { item, created } = await createLinkedPrFixItem(client, {
      repo: "Org/Repo",
      pr: 99,
      issue: 7,
      lane: "NORMAL",
      reason: "linked follow-up",
      feedback: ["r"],
      evidenceKey: "linked-health:7:x",
    });
    expect(created).toBe(true);
    expect(item.claimant).toBe("courier-x");
    expect(item.claimantSource).toBe("agent-label");
  });

  it("records the failure state when the parent has no ownership evidence", async () => {
    const client = makeClient(null, { issueRow: { id: "iss-1", labels: [] } });
    const { item } = await createLinkedPrFixItem(client, {
      repo: "org/repo",
      pr: 99,
      issue: 7,
      lane: "NORMAL",
      reason: "linked follow-up",
      feedback: ["r"],
      evidenceKey: "linked-health:7:x",
    });
    expect(item.claimant).toBeNull();
    expect(item.claimantSource).toBe("missing");
  });

  it("records nothing when the claimant read fails, leaving the row legacy rather than storing a guess", async () => {
    const client = makeClient(null, { issueThrows: true });
    const { item } = await createLinkedPrFixItem(client, {
      repo: "org/repo",
      pr: 99,
      issue: 7,
      lane: "NORMAL",
      reason: "linked follow-up",
      feedback: ["r"],
      evidenceKey: "linked-health:7:x",
    });
    expect(item.claimant).toBeNull();
    expect(item.claimantSource).toBeNull();
  });
});

describe("requeuePrFixItem claimant recovery (#1569)", () => {
  it("re-resolves an unresolved claimant on operator requeue", async () => {
    const row = makeQueueRow({ status: "BLOCKED", lane: "NEEDS_HUMAN", issue: 7, claimant: null, claimantSource: "missing" });
    const client = makeClient(row, { issueRow: { id: "iss-1", labels: ["agent/courier-x"] } });
    await requeuePrFixItem(client, { repo: "org/repo", pr: 42 });
    expect(client.row.claimant).toBe("courier-x");
    expect(client.row.claimantSource).toBe("agent-label");
  });

  it("never re-derives or transfers a recorded claimant", async () => {
    const row = makeQueueRow({ status: "BLOCKED", lane: "NEEDS_HUMAN", claimant: "original-owner", claimantSource: "agent-label" });
    const client = makeClient(row, { leaseAgent: "someone-else" });
    await requeuePrFixItem(client, { repo: "org/repo", pr: 42 });
    expect(client.row.claimant).toBe("original-owner");
    expect(client.row.claimantSource).toBe("agent-label");
  });
});

describe("backfillPrFixClaimant (#1569)", () => {
  it("writes only when the claimant resolved, pinned on claimant IS NULL", async () => {
    const row = makeQueueRow({ claimant: null });
    const client = makeClient(row, { issueRow: { id: "iss-1", labels: ["agent/courier-x"] } });
    const result = await backfillPrFixClaimant(client, { id: "item-1", repo: "org/repo", issue: 7, author: "bot", claimant: null });
    expect(result).toEqual({ claimant: "courier-x", claimantSource: "agent-label" });
    expect(client.row.claimant).toBe("courier-x");

    const unresolvedClient = makeClient(makeQueueRow({ claimant: null }), { issueRow: { id: "iss-1", labels: [] } });
    const unresolved = await backfillPrFixClaimant(unresolvedClient, { id: "item-1", repo: "org/repo", issue: 7, author: null, claimant: null });
    expect(unresolved.claimant).toBeNull();
    expect(unresolvedClient.row.claimantSource).toBeNull(); // no churn write
  });

  it("a recorded claimant short-circuits: no facts read, no write", async () => {
    const row = makeQueueRow({ claimant: "original-owner", claimantSource: "agent-label" });
    const client = makeClient(row, { issueThrows: true });
    const result = await backfillPrFixClaimant(client, { id: "item-1", repo: "org/repo", issue: 7, author: null, claimant: "original-owner" });
    expect(result.claimant).toBe("original-owner");
    expect(client.row).toEqual(row);
  });
});

describe("setPrFixClaimant (#1569)", () => {
  it("stamps the operator provenance and records history", async () => {
    const client = makeClient(makeQueueRow({ claimant: null, claimantSource: "ambiguous" }));
    const result = await setPrFixClaimant(client, { repo: "Org/Repo", pr: 42, claimant: " external-claimant " });
    expect(result.updated).toBe(true);
    expect(client.row.claimant).toBe("external-claimant");
    expect(client.row.claimantSource).toBe("operator");
    expect(client.history.some((h: any) => String(h.note).includes("#1569 operator claimant stamp"))).toBe(true);
  });

  it("returns updated=false for an unknown row without writing", async () => {
    const client = makeClient(null);
    const result = await setPrFixClaimant(client, { repo: "org/repo", pr: 42, claimant: "x" });
    expect(result.updated).toBe(false);
    expect(result.reason).toBe("not_found");
    expect(client.history).toHaveLength(0);
  });

  it("refuses to transfer an already-recorded claimant and writes nothing (#1569)", async () => {
    const client = makeClient(makeQueueRow({ claimant: "original-owner", claimantSource: "lease" }));
    const result = await setPrFixClaimant(client, { repo: "org/repo", pr: 42, claimant: "usurper" });
    expect(result).toEqual({ updated: false, reason: "already_set" });
    expect(client.row.claimant).toBe("original-owner");
    expect(client.row.claimantSource).toBe("lease");
    expect(client.history).toHaveLength(0);
  });
});

describe("toAgentQueuePrFixItem ownership exposure (#1569)", () => {
  it("carries claimant, claimantSource, and the derived evidence additively", () => {
    const projected = toAgentQueuePrFixItem(makeQueueRow({ claimant: "courier-x", claimantSource: "lease", author: "bot", lane: "ESCALATED" }));
    expect(projected.claimant).toBe("courier-x");
    expect(projected.claimantSource).toBe("lease");
    expect(projected.ownership).toEqual({
      contract: 1,
      owningLane: "ESCALATED",
      originalClaimant: "courier-x",
      provenance: "lease",
      prAuthor: "bot",
    });
  });

  it("legacy rows expose null claimant with legacy provenance", () => {
    const projected = toAgentQueuePrFixItem(makeQueueRow({ author: null }));
    expect(projected.claimant).toBeNull();
    expect(projected.ownership.provenance).toBe("legacy");
  });
});
