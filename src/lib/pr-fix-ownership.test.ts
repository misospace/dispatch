/**
 * #1569: PR-fix ownership evidence contract.
 *
 * Unit coverage for the claimant resolution ladder (lease > agent-label >
 * owner-label > pr-author), its failure states (missing / ambiguous /
 * legacy), the versioned evidence derivation, and the fail-closed hand-out
 * predicate.
 */
import { describe, expect, it } from "vitest";
import {
  claimantSourceValue,
  type ClaimantFactsClient,
  ingestionClaimantPatch,
  ownershipAuthorizesHandout,
  PR_FIX_OWNERSHIP_CONTRACT_VERSION,
  prFixOwnershipEvidence,
  resolveClaimantFromIssueFacts,
  resolveIngestionClaimant,
  resolvePrFixClaimantFacts,
  splitClaimantLabels,
} from "./pr-fix-ownership";

function fakeFactsClient(opts: {
  issue?: { id: string; labels: string[] } | null;
  lease?: { agentName: string } | null;
  throw?: string;
}): { client: ClaimantFactsClient; leaseWhere: { issueId: string | null; expiredAt: { gt: Date } | null } } {
  const leaseWhere: { issueId: string | null; expiredAt: { gt: Date } | null } = { issueId: null, expiredAt: null };
  if (opts.throw !== undefined) {
    const fail = () => {
      throw new Error(opts.throw);
    };
    return { client: { issue: { findFirst: fail }, lease: { findFirst: fail } }, leaseWhere };
  }
  const client: ClaimantFactsClient = {};
  if (opts.issue !== undefined) {
    client.issue = { findFirst: async () => opts.issue };
  }
  if (opts.lease !== undefined) {
    client.lease = {
      findFirst: (query: { where: { issueId: string; expiredAt: { gt: Date } } }) => {
        leaseWhere.issueId = query.where.issueId;
        leaseWhere.expiredAt = query.where.expiredAt;
        return Promise.resolve(opts.lease);
      },
    };
  }
  return { client, leaseWhere };
}

describe("resolveClaimantFromIssueFacts", () => {
  it("resolves the lease holder when the live lease and a single agent label agree", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: "alpha", agentLabelNames: ["alpha"], ownerLabelNames: [] }),
    ).toEqual({ state: "resolved", claimant: "alpha", source: "lease" });
  });

  it("parks as ambiguous when the live lease names a different agent than the label", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: "alpha", agentLabelNames: ["beta"], ownerLabelNames: [] }),
    ).toEqual({ state: "ambiguous" });
  });

  it("does not create ambiguity from duplicate labels naming the same agent", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: "alpha", agentLabelNames: ["alpha", "alpha"], ownerLabelNames: [] }),
    ).toEqual({ state: "resolved", claimant: "alpha", source: "lease" });
  });

  it("resolves a live lease alone with no labels", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: "alpha", agentLabelNames: [], ownerLabelNames: [] }),
    ).toEqual({ state: "resolved", claimant: "alpha", source: "lease" });
  });

  it("resolves a single distinct agent label without a lease", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: null, agentLabelNames: ["alpha", "alpha"], ownerLabelNames: [] }),
    ).toEqual({ state: "resolved", claimant: "alpha", source: "agent-label" });
  });

  it("parks as ambiguous for two distinct agent labels", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: null, agentLabelNames: ["alpha", "beta"], ownerLabelNames: [] }),
    ).toEqual({ state: "ambiguous" });
  });

  it("resolves a single distinct owner label when no lease or agent label exists", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: null, agentLabelNames: [], ownerLabelNames: ["alice"] }),
    ).toEqual({ state: "resolved", claimant: "alice", source: "owner-label" });
  });

  it("parks as ambiguous for two distinct owner labels", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: null, agentLabelNames: [], ownerLabelNames: ["alice", "bob"] }),
    ).toEqual({ state: "ambiguous" });
  });

  it("parks as ambiguous for conflicting owner labels even with a live lease", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: "alpha", agentLabelNames: [], ownerLabelNames: ["alice", "bob"] }),
    ).toEqual({ state: "ambiguous" });
  });

  it("parks as ambiguous for conflicting owner labels even with a single agent label", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: null, agentLabelNames: ["alpha"], ownerLabelNames: ["alice", "bob"] }),
    ).toEqual({ state: "ambiguous" });
  });

  it("resolves the lease with a lease and a single distinct owner label coexisting", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: "alpha", agentLabelNames: [], ownerLabelNames: ["alice"] }),
    ).toEqual({ state: "resolved", claimant: "alpha", source: "lease" });
  });

  it("returns missing when no source is present", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: null, agentLabelNames: [], ownerLabelNames: [] }),
    ).toEqual({ state: "missing" });
  });

  describe("#1615: excluded claimant names (rebase-executor pool)", () => {
    const excluded = new Set(["courier-rebase"]);

    it("skips an excluded agent label and falls through to missing", () => {
      expect(
        resolveClaimantFromIssueFacts(
          { leaseAgent: null, agentLabelNames: ["courier-rebase"], ownerLabelNames: [] },
          { excludeClaimantNames: excluded },
        ),
      ).toEqual({ state: "missing" });
    });

    it("skips an excluded name case-insensitively", () => {
      expect(
        resolveClaimantFromIssueFacts(
          { leaseAgent: null, agentLabelNames: ["Courier-Rebase"], ownerLabelNames: [] },
          { excludeClaimantNames: excluded },
        ),
      ).toEqual({ state: "missing" });
    });

    it("an excluded name falls through to a single owner label", () => {
      expect(
        resolveClaimantFromIssueFacts(
          { leaseAgent: null, agentLabelNames: ["courier-rebase"], ownerLabelNames: ["alice"] },
          { excludeClaimantNames: excluded },
        ),
      ).toEqual({ state: "resolved", claimant: "alice", source: "owner-label" });
    });

    it("an excluded agent label neither resolves nor manufactures ambiguity against the lease", () => {
      // Without the exclusion this is "ambiguous" (lease vs disagreeing
      // label); the excluded label is not ownership evidence, so the live
      // lease resolves alone.
      expect(
        resolveClaimantFromIssueFacts(
          { leaseAgent: "courier-local", agentLabelNames: ["courier-rebase"], ownerLabelNames: [] },
          { excludeClaimantNames: excluded },
        ),
      ).toEqual({ state: "resolved", claimant: "courier-local", source: "lease" });
    });

    it("a live lease HELD by an excluded name is treated as absent", () => {
      // The rebase executor is not a fix-work owner from ANY source: a lease
      // it holds on a non-REBASE item's issue must not resolve as the
      // claimant, because a recorded lease-provenance poison claimant has no
      // recovery path (the operator stamp pins on claimant IS NULL). The
      // exclusion keeps the row in the operator-recoverable "missing" state.
      expect(
        resolveClaimantFromIssueFacts(
          { leaseAgent: "courier-rebase", agentLabelNames: [], ownerLabelNames: [] },
          { excludeClaimantNames: excluded },
        ),
      ).toEqual({ state: "missing" });
      // And it falls through to the owner label when one exists.
      expect(
        resolveClaimantFromIssueFacts(
          { leaseAgent: "courier-rebase", agentLabelNames: [], ownerLabelNames: ["alice"] },
          { excludeClaimantNames: excluded },
        ),
      ).toEqual({ state: "resolved", claimant: "alice", source: "owner-label" });
    });

    it("leaves ordinary resolution untouched when no names are excluded", () => {
      expect(
        resolveClaimantFromIssueFacts(
          { leaseAgent: null, agentLabelNames: ["alpha"], ownerLabelNames: [] },
          { excludeClaimantNames: new Set() },
        ),
      ).toEqual({ state: "resolved", claimant: "alpha", source: "agent-label" });
      expect(
        resolveClaimantFromIssueFacts(
          { leaseAgent: null, agentLabelNames: ["alpha"], ownerLabelNames: [] },
          undefined,
        ),
      ).toEqual({ state: "resolved", claimant: "alpha", source: "agent-label" });
    });
  });

  it("treats a whitespace-only lease agent as absent", () => {
    expect(
      resolveClaimantFromIssueFacts({ leaseAgent: "   ", agentLabelNames: [], ownerLabelNames: ["alice"] }),
    ).toEqual({ state: "resolved", claimant: "alice", source: "owner-label" });
  });
});

describe("splitClaimantLabels", () => {
  it("extracts agent and owner names and ignores unrelated labels", () => {
    expect(
      splitClaimantLabels(["agent/alpha", "status/ready", "owner/alice", "priority/p1", "agent/ beta "]),
    ).toEqual({ agentLabelNames: ["alpha", "beta"], ownerLabelNames: ["alice"] });
  });

  it("drops agent/owner labels with empty names", () => {
    expect(splitClaimantLabels(["agent/", "agent/  ", "owner/"])).toEqual({
      agentLabelNames: [],
      ownerLabelNames: [],
    });
  });

  it("treats null and undefined as no labels", () => {
    expect(splitClaimantLabels(null)).toEqual({ agentLabelNames: [], ownerLabelNames: [] });
    expect(splitClaimantLabels(undefined)).toEqual({ agentLabelNames: [], ownerLabelNames: [] });
  });
});

describe("resolvePrFixClaimantFacts", () => {
  it("returns the definitive missing state when the issue row does not exist", async () => {
    const { client } = fakeFactsClient({ issue: null, lease: { agentName: "alpha" } });

    await expect(resolvePrFixClaimantFacts(client, "org/repo", 42)).resolves.toEqual({ state: "missing" });
  });

  it("combines the live lease with the issue's labels", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { client, leaseWhere } = fakeFactsClient({
      issue: { id: "row-1", labels: ["agent/alpha", "status/ready"] },
      lease: { agentName: "alpha" },
    });

    await expect(resolvePrFixClaimantFacts(client, "org/repo", 42, now)).resolves.toEqual({
      state: "resolved",
      claimant: "alpha",
      source: "lease",
    });
    expect(leaseWhere.issueId).toBe("row-1");
    expect(leaseWhere.expiredAt).toEqual({ gt: now });
  });

  it("falls through to the agent label when no live lease is recorded", async () => {
    const { client } = fakeFactsClient({
      issue: { id: "row-1", labels: ["agent/alpha", "owner/alice"] },
      lease: null,
    });

    await expect(resolvePrFixClaimantFacts(client, "org/repo", 42)).resolves.toEqual({
      state: "resolved",
      claimant: "alpha",
      source: "agent-label",
    });
  });

  it("returns null on a read failure rather than a confident state", async () => {
    const { client } = fakeFactsClient({ throw: "db down" });

    await expect(resolvePrFixClaimantFacts(client, "org/repo", 42)).resolves.toBeNull();
  });

  it("does not fabricate a lease when the lease surface is absent", async () => {
    const { client } = fakeFactsClient({
      issue: { id: "row-1", labels: ["owner/alice"] },
    });

    await expect(resolvePrFixClaimantFacts(client, "org/repo", 42)).resolves.toEqual({
      state: "resolved",
      claimant: "alice",
      source: "owner-label",
    });
  });
});

describe("resolveIngestionClaimant", () => {
  it("delegates to the issue facts when a linked issue is present", async () => {
    const { client } = fakeFactsClient({
      issue: { id: "row-1", labels: ["agent/alpha"] },
      lease: { agentName: "alpha" },
    });

    await expect(resolveIngestionClaimant(client, "org/repo", 7, "someone")).resolves.toEqual({
      state: "resolved",
      claimant: "alpha",
      source: "lease",
    });
  });

  it("falls back to the PR author when no issue is linked", async () => {
    const { client } = fakeFactsClient({ issue: null });

    await expect(resolveIngestionClaimant(client, "org/repo", null, "bot")).resolves.toEqual({
      state: "resolved",
      claimant: "bot",
      source: "pr-author",
    });
  });

  it("returns missing when no issue is linked and no author is known", async () => {
    const { client } = fakeFactsClient({ issue: null });

    await expect(resolveIngestionClaimant(client, "org/repo", null, null)).resolves.toEqual({
      state: "missing",
    });
    await expect(resolveIngestionClaimant(client, "org/repo", undefined, "  ")).resolves.toEqual({
      state: "missing",
    });
  });

  it("reports unavailable, never a stored failure state, when the facts cannot be read", async () => {
    const { client } = fakeFactsClient({ throw: "db down" });

    await expect(resolveIngestionClaimant(client, "org/repo", 7, "someone")).resolves.toEqual({
      state: "unavailable",
    });
    // A read failure must not become a durable provenance.
    expect(ingestionClaimantPatch({ state: "unavailable" })).toBeNull();
    expect(claimantSourceValue({ state: "unavailable" })).toBeNull();
  });
});

describe("ingestionClaimantPatch", () => {
  it("persists a resolved identity with its source", () => {
    expect(ingestionClaimantPatch({ state: "resolved", claimant: "alpha", source: "lease" })).toEqual({
      claimant: "alpha",
      claimantSource: "lease",
    });
  });

  it("persists an honest failure state as a NULL claimant", () => {
    expect(ingestionClaimantPatch({ state: "missing" })).toEqual({ claimant: null, claimantSource: "missing" });
    expect(ingestionClaimantPatch({ state: "ambiguous" })).toEqual({ claimant: null, claimantSource: "ambiguous" });
  });

  it("writes nothing on a failed fact read", () => {
    expect(ingestionClaimantPatch({ state: "unavailable" })).toBeNull();
  });
});

describe("prFixOwnershipEvidence", () => {
  it("derives the lease provenance and carries the owning lane for a resolved claimant", () => {
    expect(prFixOwnershipEvidence({ lane: "REBASE", claimant: "alpha", claimantSource: "lease" })).toEqual({
      contract: PR_FIX_OWNERSHIP_CONTRACT_VERSION,
      owningLane: "REBASE",
      originalClaimant: "alpha",
      provenance: "lease",
    });
  });

  it("defaults a null lane to NORMAL", () => {
    const evidence = prFixOwnershipEvidence({ lane: null, claimant: "alpha", claimantSource: "lease" });

    expect(evidence.owningLane).toBe("NORMAL");
    expect(evidence.provenance).toBe("lease");
  });

  it("treats a claimant with an unknown or absent source as legacy", () => {
    expect(prFixOwnershipEvidence({ lane: "NORMAL", claimant: "alpha", claimantSource: null }).provenance).toBe(
      "legacy",
    );
    expect(
      prFixOwnershipEvidence({ lane: "NORMAL", claimant: "alpha", claimantSource: "future-source" }).provenance,
    ).toBe("legacy");
  });

  it("preserves a recorded failure state when no claimant was resolved", () => {
    expect(
      prFixOwnershipEvidence({ lane: "NORMAL", claimant: null, claimantSource: "ambiguous" }).provenance,
    ).toBe("ambiguous");
    expect(
      prFixOwnershipEvidence({ lane: "NORMAL", claimant: null, claimantSource: "missing" }).provenance,
    ).toBe("missing");
  });

  it("treats a claimantless row with no recorded source as legacy", () => {
    expect(prFixOwnershipEvidence({ lane: "NORMAL", claimant: null, claimantSource: null }).provenance).toBe(
      "legacy",
    );
    expect(prFixOwnershipEvidence({ lane: "NORMAL" }).provenance).toBe("legacy");
  });

  it("rides the PR author along when the row carries an author field", () => {
    expect(
      prFixOwnershipEvidence({ lane: "NORMAL", claimant: "alpha", claimantSource: "lease", author: "carol" }),
    ).toEqual({
      contract: PR_FIX_OWNERSHIP_CONTRACT_VERSION,
      owningLane: "NORMAL",
      originalClaimant: "alpha",
      provenance: "lease",
      prAuthor: "carol",
    });
    expect(
      prFixOwnershipEvidence({ lane: "NORMAL", claimant: "alpha", claimantSource: "lease" }).prAuthor,
    ).toBeUndefined();
  });
});

describe("ownershipAuthorizesHandout", () => {
  it("authorizes only when a claimant is recorded", () => {
    expect(
      ownershipAuthorizesHandout({
        contract: PR_FIX_OWNERSHIP_CONTRACT_VERSION,
        owningLane: "NORMAL",
        originalClaimant: "alpha",
        provenance: "lease",
      }),
    ).toBe(true);
    expect(
      ownershipAuthorizesHandout({
        contract: PR_FIX_OWNERSHIP_CONTRACT_VERSION,
        owningLane: "NORMAL",
        originalClaimant: null,
        provenance: "missing",
      }),
    ).toBe(false);
    expect(
      ownershipAuthorizesHandout({
        contract: PR_FIX_OWNERSHIP_CONTRACT_VERSION,
        owningLane: "NORMAL",
        originalClaimant: null,
        provenance: "ambiguous",
      }),
    ).toBe(false);
    expect(
      ownershipAuthorizesHandout({
        contract: PR_FIX_OWNERSHIP_CONTRACT_VERSION,
        owningLane: "NORMAL",
        originalClaimant: null,
        provenance: "legacy",
      }),
    ).toBe(false);
  });
});

describe("claimantSourceValue", () => {
  it("persists the source for a resolved claimant", () => {
    expect(claimantSourceValue({ state: "resolved", claimant: "alpha", source: "lease" })).toBe("lease");
    expect(claimantSourceValue({ state: "resolved", claimant: "alice", source: "owner-label" })).toBe("owner-label");
  });

  it("persists the failure state itself for unresolved resolutions", () => {
    expect(claimantSourceValue({ state: "missing" })).toBe("missing");
    expect(claimantSourceValue({ state: "ambiguous" })).toBe("ambiguous");
  });
});
