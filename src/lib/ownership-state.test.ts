// Unit tests for the derived ownership state model (#1251,
// docs/ownership-reconciliation.md §4/§5). Pure logic: every case supplies a
// frozen `NOW` and explicit windows, so no clock, env, or network is needed.
import { describe, expect, it } from "vitest";

import {
  deriveOwnershipState,
  latestEvidenceTimestamp,
  type OwnershipAgentWorkEvidence,
  type OwnershipEvidence,
  type OwnershipLeaseEvidence,
  type OwnershipWindows,
} from "./ownership-state";

const NOW = new Date("2026-10-18T12:00:00.000Z");

const WINDOWS: OwnershipWindows = {
  activeMs: 15 * 60_000,
  longRunGraceMs: 30 * 60_000,
};

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function ahead(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function makeEvidence(overrides: Partial<OwnershipEvidence> = {}): OwnershipEvidence {
  return {
    issueState: "open",
    labels: [],
    labelSource: "live",
    ...overrides,
  };
}

function makeLease(overrides: Partial<OwnershipLeaseEvidence> = {}): OwnershipLeaseEvidence {
  return {
    agentName: "alice",
    expiredAt: NOW,
    renewedAt: null,
    claimToken: null,
    registeredAt: null,
    registrationOccurredAt: null,
    renewCount: 0,
    lastRenewalObservedAt: null,
    lastRenewalOccurredAt: null,
    retryAfter: null,
    disposition: null,
    ...overrides,
  };
}

function makeAgentWork(overrides: Partial<OwnershipAgentWorkEvidence> = {}): OwnershipAgentWorkEvidence {
  return {
    agentName: "alice",
    state: "IN_PROGRESS",
    lastHeartbeatAt: ago(60_000),
    ...overrides,
  };
}

describe("deriveOwnershipState", () => {
  describe("closed issue (step 1)", () => {
    it("returns UNOWNED with issue_closed even when a live, fresh claim exists", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          issueState: "closed",
          labels: ["agent/alice", "status/in-progress"],
          lease: makeLease({ lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNOWNED");
      expect(result.reasonCodes).toEqual(["issue_closed"]);
    });

    it("prefers issue_closed over conflict detection", () => {
      const result = deriveOwnershipState(
        makeEvidence({ issueState: "closed", labels: ["agent/alice", "agent/bob"] }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNOWNED");
      expect(result.reasonCodes).toEqual(["issue_closed"]);
    });
  });

  describe("conflicts (step 2)", () => {
    it("flags more than one distinct agent/* label as CONFLICTED with no owner", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice", "agent/bob", "status/in-progress"] }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CONFLICTED");
      expect(result.reasonCodes).toEqual(["multiple_agent_labels"]);
      expect(result.ownerAgent).toBeNull();
    });

    it("does not treat a duplicated single agent label as a conflict", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice", "agent/alice"] }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNKNOWN");
      expect(result.reasonCodes).not.toContain("multiple_agent_labels");
    });

    it("flags a live-vs-cached agent/* set divergence as CONFLICTED", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice"], cachedLabels: ["agent/bob"] }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CONFLICTED");
      expect(result.reasonCodes).toEqual(["live_cache_divergence"]);
    });

    it("does not flag divergence when the live and cached agent/* sets match", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice"], cachedLabels: ["agent/alice"] }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNKNOWN");
      expect(result.reasonCodes).not.toContain("live_cache_divergence");
    });

    it("flags a lease owned by a different agent than the sole label as CONFLICTED, keeping the label owner", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice"], lease: makeLease({ agentName: "bob" }) }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CONFLICTED");
      expect(result.reasonCodes).toEqual(["lease_owner_mismatch"]);
      expect(result.ownerAgent).toBe("alice");
    });

    it("flags an active AgentWork owned by a different agent than the sole label (no lease) as CONFLICTED", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice"], agentWork: makeAgentWork({ agentName: "bob" }) }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CONFLICTED");
      expect(result.reasonCodes).toEqual(["agent_work_owner_mismatch"]);
      expect(result.ownerAgent).toBe("alice");
    });

    it("does not treat a non-active AgentWork as an owner mismatch", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice"], agentWork: makeAgentWork({ agentName: "bob", state: "STALE" }) }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNKNOWN");
      expect(result.reasonCodes).not.toContain("agent_work_owner_mismatch");
    });

    it("collects all applicable conflict reasons in a stable order", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice"],
          cachedLabels: ["agent/bob"],
          lease: makeLease({ agentName: "bob" }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CONFLICTED");
      expect(result.reasonCodes).toEqual(["live_cache_divergence", "lease_owner_mismatch"]);
    });

    it("prefers CONFLICTED over HELD when both apply", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "agent/bob", "status/blocked"],
          blockedReason: "waiting on upstream",
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CONFLICTED");
      expect(result.reasonCodes).toEqual(["multiple_agent_labels"]);
    });
  });

  describe("HELD (step 3)", () => {
    it("returns HELD for status/blocked with a non-empty blockedReason, even with a fresh live claim", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/blocked"],
          blockedReason: "waiting on upstream API",
          lease: makeLease({ lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("HELD");
      expect(result.reasonCodes).toEqual(["human_hold"]);
      expect(result.ownerAgent).toBe("alice");
    });

    it("returns HELD for a blocked reason even without any claim", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["status/blocked"], blockedReason: "operator hold" }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("HELD");
      expect(result.reasonCodes).toEqual(["human_hold"]);
      expect(result.ownerAgent).toBeNull();
    });

    it("prefers HELD over EXTERNAL_WAIT when both apply", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/blocked"],
          blockedReason: "operator hold",
          lease: makeLease({ retryAfter: ahead(60_000), lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("HELD");
      expect(result.reasonCodes).toEqual(["human_hold"]);
    });

    it("does not hold a status/blocked issue without a blockedReason", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/blocked"],
          blockedReason: null,
          lease: makeLease({ lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_ACTIVE");
      expect(result.reasonCodes).toEqual(["evidence_recent"]);
    });

    it("treats a whitespace-only blockedReason as absent", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/blocked"],
          blockedReason: "   ",
          lease: makeLease({ lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_ACTIVE");
    });
  });

  describe("EXTERNAL_WAIT (step 4)", () => {
    it("returns EXTERNAL_WAIT when a claim's retryAfter is in the future", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/blocked"],
          lease: makeLease({ retryAfter: ahead(60_000), lastRenewalObservedAt: ago(10 * 60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("EXTERNAL_WAIT");
      expect(result.reasonCodes).toEqual(["external_wait_retry_after"]);
      expect(result.ownerAgent).toBe("alice");
    });

    it("falls through to the ladder when the retryAfter has elapsed", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice"],
          lease: makeLease({ retryAfter: ago(60_000), lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_ACTIVE");
      expect(result.reasonCodes).toEqual(["evidence_recent"]);
    });

    it("treats a blocked disposition with a future retryAfter as EXTERNAL_WAIT", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/blocked"],
          lease: makeLease({
            disposition: "blocked",
            retryAfter: ahead(60_000),
            lastRenewalObservedAt: ago(10 * 60_000),
          }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("EXTERNAL_WAIT");
    });

    it("prefers EXTERNAL_WAIT over REVIEW_OWNED when both apply", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-review"],
          openPrFix: true,
          lease: makeLease({ retryAfter: ahead(60_000), lastRenewalObservedAt: ago(90 * 60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("EXTERNAL_WAIT");
      expect(result.reasonCodes).toEqual(["external_wait_retry_after"]);
    });
  });

  describe("REVIEW_OWNED (step 5)", () => {
    it("returns REVIEW_OWNED with open_linked_pr for status/in-review with an open linked PR", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-review"],
          linkedPrNumber: 50,
          linkedPrMergeState: "open",
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("REVIEW_OWNED");
      expect(result.reasonCodes).toEqual(["open_linked_pr"]);
    });

    it("treats an unknown (null) linked-PR merge state as open", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-review"],
          linkedPrNumber: 50,
          linkedPrMergeState: null,
          agentWork: makeAgentWork({ lastHeartbeatAt: ago(90 * 60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("REVIEW_OWNED");
      expect(result.reasonCodes).toEqual(["open_linked_pr"]);
    });

    it("returns REVIEW_OWNED with open_pr_fix_queue for status/in-review with only an open PR-fix row", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["status/in-review"],
          openPrFix: true,
          agentWork: makeAgentWork({ lastHeartbeatAt: ago(90 * 60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("REVIEW_OWNED");
      expect(result.reasonCodes).toEqual(["open_pr_fix_queue"]);
    });

    it("returns REVIEW_OWNED with open_pr_fix_queue for an open PR-fix row with a claim outside in-review", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-progress"],
          openPrFix: true,
          agentWork: makeAgentWork({ lastHeartbeatAt: ago(90 * 60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("REVIEW_OWNED");
      expect(result.reasonCodes).toEqual(["open_pr_fix_queue"]);
    });

    it("keeps REVIEW_OWNED even when the liveness evidence is stale beyond the grace", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-review"],
          linkedPrNumber: 50,
          linkedPrMergeState: "open",
          lease: makeLease({ lastRenewalObservedAt: ago(90 * 60_000), expiredAt: ago(90 * 60_000) }),
          agentWork: makeAgentWork({ lastHeartbeatAt: ago(90 * 60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("REVIEW_OWNED");
      expect(result.reasonCodes).toEqual(["open_linked_pr"]);
    });

    it("prefers REVIEW_OWNED over a terminal disposition with stale evidence", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-review"],
          linkedPrNumber: 50,
          linkedPrMergeState: "open",
          lease: makeLease({
            disposition: "completed",
            lastRenewalObservedAt: ago(90 * 60_000),
            expiredAt: ago(90 * 60_000),
          }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("REVIEW_OWNED");
      expect(result.reasonCodes).toEqual(["open_linked_pr"]);
    });

    it("does not treat a merged linked PR as review-owned", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-review"],
          linkedPrNumber: 50,
          linkedPrMergeState: "merged",
          lease: makeLease({ lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_ACTIVE");
    });

    it("does not treat an open linked PR without in-review and without a claim as owned", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["status/ready"],
          linkedPrNumber: 50,
          linkedPrMergeState: "open",
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNOWNED");
      expect(result.reasonCodes).toEqual(["unowned"]);
    });

    it("does not treat an open PR-fix row without any claim and without in-review as owned", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["status/ready"], openPrFix: true }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNOWNED");
      expect(result.reasonCodes).toEqual(["unowned"]);
    });
  });

  describe("UNOWNED (step 6)", () => {
    it("returns UNOWNED with unowned when no claim exists", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["status/ready", "priority/p1"] }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNOWNED");
      expect(result.reasonCodes).toEqual(["unowned"]);
      expect(result.ownerAgent).toBeNull();
      expect(result.evidenceAgeMs).toBeNull();
    });

    it.each(["DONE", "RELEASED", "STALE"])("does not treat %s AgentWork as a claim", (state) => {
      const result = deriveOwnershipState(
        makeEvidence({ agentWork: makeAgentWork({ state }) }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNOWNED");
      expect(result.reasonCodes).toEqual(["unowned"]);
    });
  });

  describe("terminal dispositions (step 7)", () => {
    it.each(["completed", "released", "handed_off"])(
      "yields ABANDONED_CANDIDATE with terminal_disposition_%s even for a fresh renewal and a live lease",
      (disposition) => {
        const result = deriveOwnershipState(
          makeEvidence({
            labels: ["agent/alice", "status/in-progress"],
            lease: makeLease({
              disposition,
              lastRenewalObservedAt: ago(30_000),
              expiredAt: ahead(20 * 60_000),
            }),
          }),
          WINDOWS,
          NOW,
        );
        expect(result.state).toBe("ABANDONED_CANDIDATE");
        expect(result.reasonCodes).toEqual([`terminal_disposition_${disposition}`]);
      },
    );

    it.each([null, "elapsed"])(
      "keeps a blocked disposition with a %s retryAfter on the ladder (no short-circuit)",
      (retryAfter) => {
        const result = deriveOwnershipState(
          makeEvidence({
            labels: ["agent/alice", "status/blocked"],
            lease: makeLease({
              disposition: "blocked",
              retryAfter: retryAfter === "elapsed" ? ago(60_000) : null,
              lastRenewalObservedAt: ago(60_000),
            }),
          }),
          WINDOWS,
          NOW,
        );
        expect(result.state).toBe("CLAIMED_ACTIVE");
        expect(result.reasonCodes).toEqual(["disposition_blocked_no_retry_after", "evidence_recent"]);
      },
    );
  });

  describe("liveness ladder (step 8)", () => {
    it("returns CLAIMED_ACTIVE when the freshest evidence is within the active window", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-progress"],
          lease: makeLease({
            lastRenewalObservedAt: ago(10 * 60_000),
            lastRenewalOccurredAt: ago(20 * 60_000),
            expiredAt: ago(60 * 60_000),
          }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_ACTIVE");
      expect(result.reasonCodes).toEqual(["evidence_recent"]);
      expect(result.evidenceAgeMs).toBe(10 * 60_000);
      expect(result.ownerAgent).toBe("alice");
    });

    it("uses the active AgentWork heartbeat as liveness evidence and as the owner fallback", () => {
      const result = deriveOwnershipState(
        makeEvidence({ agentWork: makeAgentWork({ lastHeartbeatAt: ago(60_000) }) }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_ACTIVE");
      expect(result.reasonCodes).toEqual(["evidence_recent"]);
      expect(result.ownerAgent).toBe("alice");
    });

    it("falls back to the lease owner when no agent label is present", () => {
      const result = deriveOwnershipState(
        makeEvidence({ lease: makeLease({ lastRenewalObservedAt: ago(60_000) }) }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_ACTIVE");
      expect(result.ownerAgent).toBe("alice");
    });

    it("returns CLAIMED_LONG_RUNNING with long_run_grace when beyond the active window but within the grace", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice"],
          lease: makeLease({
            lastRenewalObservedAt: ago(20 * 60_000),
            expiredAt: ago(20 * 60_000),
          }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_LONG_RUNNING");
      expect(result.reasonCodes).toEqual(["long_run_grace"]);
      expect(result.evidenceAgeMs).toBe(20 * 60_000);
    });

    it("returns CLAIMED_LONG_RUNNING with lease_still_live when beyond the grace but the lease is not expired", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice"],
          lease: makeLease({
            lastRenewalObservedAt: ago(45 * 60_000),
            expiredAt: ahead(10 * 60_000),
          }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_LONG_RUNNING");
      expect(result.reasonCodes).toEqual(["lease_still_live"]);
    });

    it("falls to ABANDONED_CANDIDATE when beyond the grace with no live lease to extend it", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice"],
          agentWork: makeAgentWork({ lastHeartbeatAt: ago(45 * 60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("ABANDONED_CANDIDATE");
      expect(result.reasonCodes).toEqual(["evidence_stale"]);
    });

    it("returns ABANDONED_CANDIDATE with evidence_stale when the evidence is beyond both windows", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-progress"],
          lease: makeLease({
            lastRenewalObservedAt: ago(90 * 60_000),
            expiredAt: ago(90 * 60_000),
          }),
          agentWork: makeAgentWork({ lastHeartbeatAt: ago(90 * 60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("ABANDONED_CANDIDATE");
      expect(result.reasonCodes).toEqual(["evidence_stale"]);
      expect(result.evidenceAgeMs).toBe(90 * 60_000);
    });

    it("picks the newer of client-reported and server-observed renewal timestamps", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice"],
          lease: makeLease({
            lastRenewalObservedAt: ago(30 * 60_000),
            lastRenewalOccurredAt: ago(10 * 60_000),
          }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.evidenceAgeMs).toBe(10 * 60_000);
      expect(result.state).toBe("CLAIMED_ACTIVE");
    });
  });

  describe("UNKNOWN (step 9)", () => {
    it("returns UNKNOWN with owner_unverified_no_dispatch_evidence for a label-only legacy claim", () => {
      const result = deriveOwnershipState(
        makeEvidence({ labels: ["agent/courier", "status/in-progress"] }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNKNOWN");
      expect(result.reasonCodes).toEqual(["owner_unverified_no_dispatch_evidence"]);
      expect(result.evidenceAgeMs).toBeNull();
      expect(result.ownerAgent).toBe("courier");
    });

    it("returns UNKNOWN with labels_unverifiable when the label read is unavailable and only the cached set shows a claim", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/courier", "status/in-progress"],
          labelSource: "unavailable",
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("UNKNOWN");
      expect(result.reasonCodes).toEqual(["labels_unverifiable"]);
      expect(result.verified).toBe(false);
      expect(result.evidenceAgeMs).toBeNull();
    });

    it("continues the ladder with a labels_unverified annotation when labels are unavailable but first-party evidence exists", () => {
      const result = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/in-progress"],
          labelSource: "unavailable",
          lease: makeLease({ lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(result.state).toBe("CLAIMED_ACTIVE");
      expect(result.reasonCodes).toEqual(["labels_unverified", "evidence_recent"]);
      expect(result.verified).toBe(false);
    });
  });

  describe("assessment metadata", () => {
    it("sets verified only for the live label source", () => {
      const live = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice"], labelSource: "live" }),
        WINDOWS,
        NOW,
      );
      const cache = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice"], labelSource: "cache" }),
        WINDOWS,
        NOW,
      );
      const unavailable = deriveOwnershipState(
        makeEvidence({ labels: ["agent/alice"], labelSource: "unavailable" }),
        WINDOWS,
        NOW,
      );
      expect(live.verified).toBe(true);
      expect(cache.verified).toBe(false);
      expect(unavailable.verified).toBe(false);
    });

    it("reports evidenceAgeMs for non-ladder states too, and null when no liveness evidence exists", () => {
      const held = deriveOwnershipState(
        makeEvidence({
          labels: ["agent/alice", "status/blocked"],
          blockedReason: "operator hold",
          lease: makeLease({ lastRenewalObservedAt: ago(60_000) }),
        }),
        WINDOWS,
        NOW,
      );
      expect(held.evidenceAgeMs).toBe(60_000);

      const unowned = deriveOwnershipState(
        makeEvidence({ labels: ["status/ready"] }),
        WINDOWS,
        NOW,
      );
      expect(unowned.evidenceAgeMs).toBeNull();
    });
  });
});

describe("latestEvidenceTimestamp", () => {
  it("returns null when no liveness evidence exists", () => {
    expect(latestEvidenceTimestamp(null, null, NOW)).toBeNull();
  });

  it("returns null for a lease with no registration or renewal timestamps", () => {
    expect(latestEvidenceTimestamp(makeLease({ expiredAt: ago(60_000), retryAfter: ago(30_000) }), null, NOW)).toBeNull();
  });

  it("picks the newest of the lease registration/renewal timestamps", () => {
    const ts = latestEvidenceTimestamp(
      makeLease({
        renewedAt: ago(60 * 60_000),
        registeredAt: ago(2 * 60 * 60_000),
        registrationOccurredAt: ago(3 * 60 * 60_000),
        lastRenewalObservedAt: ago(30 * 60_000),
        lastRenewalOccurredAt: ago(10 * 60_000),
      }),
      null,
      NOW,
    );
    expect(ts).toBe(ago(10 * 60_000).getTime());
  });

  it("includes the active AgentWork heartbeat and prefers the freshest", () => {
    const ts = latestEvidenceTimestamp(
      makeLease({ lastRenewalObservedAt: ago(20 * 60_000) }),
      makeAgentWork({ lastHeartbeatAt: ago(5 * 60_000) }),
      NOW,
    );
    expect(ts).toBe(ago(5 * 60_000).getTime());
  });

  it("ignores the heartbeat of a non-active AgentWork", () => {
    expect(latestEvidenceTimestamp(null, makeAgentWork({ state: "DONE", lastHeartbeatAt: ago(60_000) }), NOW)).toBeNull();
  });

  it("clamps a future-dated timestamp to now so the derived age is never negative", () => {
    const ts = latestEvidenceTimestamp(
      makeLease({ lastRenewalOccurredAt: ahead(60_000) }),
      null,
      NOW,
    );
    expect(ts).toBe(NOW.getTime());
  });

  it("defaults to the current instant when now is omitted", () => {
    const before = Date.now();
    const ts = latestEvidenceTimestamp(makeLease({ lastRenewalObservedAt: new Date(before) }), null);
    expect(ts).toBe(before);
  });
});
