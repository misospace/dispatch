import { describe, expect, it } from "vitest";
import {
  computeNeedsAttention,
  type AgentExecutionAttentionRow,
  type NoPrConclusionAttentionRow,
  type OwnershipIntentAttentionRow,
  type PrFixAttentionRow,
} from "./needs-attention";

const NOW = new Date("2026-11-04T12:00:00Z");

function prFix(overrides: Partial<PrFixAttentionRow> = {}): PrFixAttentionRow {
  return {
    id: "pfix1",
    repo: "org/repo",
    pr: 7,
    issue: 42,
    url: null,
    title: "Fix the thing",
    status: "BLOCKED",
    lane: "NEEDS_HUMAN",
    type: "CI_FAILURE",
    outcome: "human_decision",
    decisionDetail: { question: "Keep or revert?", options: ["keep", "revert"], evidence: "ci log" },
    queuedAt: "2026-11-04T10:00:00Z",
    ...overrides,
  };
}

function execution(overrides: Partial<AgentExecutionAttentionRow> = {}): AgentExecutionAttentionRow {
  return {
    id: "exec1",
    agentName: "alpha",
    executionState: "AWAITING_REVIEW",
    endedAt: null,
    startedAt: "2026-11-04T09:00:00Z",
    lastObservedAt: "2026-11-04T11:00:00Z",
    workRefUrl: "https://github.com/org/repo/pull/9",
    pullRequestNumber: 9,
    summary: null,
    ...overrides,
  };
}

function intent(overrides: Partial<OwnershipIntentAttentionRow> = {}): OwnershipIntentAttentionRow {
  return {
    id: "intent1",
    agentName: "alpha",
    agentLabel: "agent/alpha",
    phase: "pending",
    parkedAt: "2026-11-04T08:00:00Z",
    issue: { number: 5, repoFullName: "org/repo", title: "Stale claim", url: "https://github.com/org/repo/issues/5" },
    ...overrides,
  };
}

function noPr(overrides: Partial<NoPrConclusionAttentionRow> = {}): NoPrConclusionAttentionRow {
  return {
    id: "noprc1",
    agentName: "beta",
    outcome: "no_changes_needed",
    summary: null,
    createdAt: "2026-11-04T07:00:00Z",
    issue: { number: 11, repoFullName: "org/repo", title: "Already done", url: "https://github.com/org/repo/issues/11" },
    ...overrides,
  };
}

function compute(overrides: {
  prFixItems?: PrFixAttentionRow[];
  agentExecutions?: AgentExecutionAttentionRow[];
  ownershipIntents?: OwnershipIntentAttentionRow[];
  noPrConclusions?: NoPrConclusionAttentionRow[];
} = {}) {
  return computeNeedsAttention({
    now: NOW,
    prFixItems: [],
    agentExecutions: [],
    ownershipIntents: [],
    noPrConclusions: [],
    ...overrides,
  });
}

describe("computeNeedsAttention", () => {
  it("surfaces a human-decision block with structured decision payload and PR identity", () => {
    const { items } = compute({ prFixItems: [prFix()] });
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.category).toBe("human_decision");
    expect(item.id).toBe("human_decision:pfix1");
    expect(item.title).toBe("Fix the thing");
    expect(item.repo).toBe("org/repo");
    expect(item.prNumber).toBe(7);
    expect(item.issueNumber).toBe(42);
    expect(item.url).toBe("https://github.com/org/repo/pull/7");
    expect(item.decision).toEqual({
      question: "Keep or revert?",
      options: ["keep", "revert"],
      evidence: "ci log",
    });
    expect(item.urgency).toBe(1);
    expect(item.ageStartedAt).toBe("2026-11-04T10:00:00.000Z");
  });

  it("surfaces a human-owned conflict hold as semantic_conflict", () => {
    // A conflict/rebase row held BLOCKED without an automated outcome is
    // operator-owned work: BLOCKED is reserved for a human decision (#1218),
    // so the hold itself is the human-attention disposition (#1546).
    const { items } = compute({
      prFixItems: [prFix({ type: "REBASE", outcome: null, decisionDetail: null })],
    });
    expect(items.map((i) => i.category)).toEqual(["semantic_conflict"]);
    expect(items[0].urgency).toBe(2);
    expect(items[0].prNumber).toBe(7);
  });

  it("keeps a conflict type from overriding a transient automated outcome (#1546)", () => {
    // PARKED + no_progress / infra_failure are documented transient states;
    // the MERGE_CONFLICT / REBASE type must not surface them (#1544 contract).
    // A PARKED row without an outcome carries the implicit no_progress park.
    const { items } = compute({
      prFixItems: [
        prFix({ id: "rnp", status: "PARKED", type: "REBASE", outcome: "no_progress", decisionDetail: null }),
        prFix({ id: "mnp", status: "PARKED", type: "MERGE_CONFLICT", outcome: "no_progress", decisionDetail: null }),
        prFix({ id: "rif", status: "PARKED", type: "REBASE", outcome: "infra_failure", decisionDetail: null }),
        prFix({ id: "mif", status: "PARKED", type: "MERGE_CONFLICT", outcome: "infra_failure", decisionDetail: null }),
        prFix({ id: "rnul", status: "PARKED", type: "REBASE", outcome: null, decisionDetail: null }),
      ],
    });
    expect(items).toEqual([]);
  });

  it("classifies a fail-closed invalid_wait park by its disposition, not its type (#1548)", () => {
    // invalid_wait is not a transient automated state: an operator requeue is
    // required (#1250). The disposition decides visibility (#1548), so even a
    // conflict-typed row parked that way surfaces under the invalid_wait
    // category with the honest operator-requeue reason, not as a semantic
    // conflict.
    const { items } = compute({
      prFixItems: [prFix({ status: "PARKED", type: "REBASE", outcome: "invalid_wait", decisionDetail: null })],
    });
    expect(items.map((i) => i.category)).toEqual(["invalid_wait"]);
    expect(items[0].id).toBe("invalid_wait:pfix1");
    expect(items[0].urgency).toBe(2);
    expect(items[0].reason).toContain("operator requeue required");
  });

  it("surfaces a fail-closed invalid_wait park on every type (#1548)", () => {
    // The park waits on the same operator requeue regardless of the row's
    // type, so CI_FAILURE / OTHER / REVIEW_FEEDBACK rows parked invalid_wait
    // are no longer invisible.
    const { items } = compute({
      prFixItems: (["MERGE_CONFLICT", "CI_FAILURE", "REVIEW_FEEDBACK", "OTHER", "REBASE"] as const).map((type, i) =>
        prFix({ id: `iw${i}`, type, status: "PARKED", outcome: "invalid_wait", decisionDetail: null }),
      ),
    });
    expect(items.map((i) => i.category)).toEqual(["invalid_wait", "invalid_wait", "invalid_wait", "invalid_wait", "invalid_wait"]);
    for (const item of items) {
      expect(item.reason).toBe("fail-closed park: external wait without a verifiable dependency; operator requeue required");
    }
  });

  it("classifies a conflict-typed security_failure park by its outcome, not its type", () => {
    const { items } = compute({
      prFixItems: [prFix({ status: "PARKED", type: "MERGE_CONFLICT", outcome: "security_failure", decisionDetail: null })],
    });
    expect(items.map((i) => i.category)).toEqual(["security_failure"]);
  });

  it("human_decision takes precedence over the conflict classification for the same row", () => {
    const { items } = compute({ prFixItems: [prFix({ type: "REBASE", outcome: "human_decision" })] });
    expect(items.map((i) => i.category)).toEqual(["human_decision"]);
  });

  it("surfaces a durable security failure park", () => {
    const { items } = compute({ prFixItems: [prFix({ status: "PARKED", outcome: "security_failure", decisionDetail: null })] });
    expect(items.map((i) => i.category)).toEqual(["security_failure"]);
  });

  it("excludes retryable/transient states: QUEUED, WAITING_EXTERNAL, PARKED infra_failure, PARKED no_progress", () => {
    const { items } = compute({
      prFixItems: [
        prFix({ id: "q", status: "QUEUED", outcome: null }),
        prFix({ id: "we", status: "WAITING_EXTERNAL", outcome: null, decisionDetail: null }),
        prFix({ id: "infra", status: "PARKED", outcome: "infra_failure", decisionDetail: null }),
        prFix({ id: "noprogress", status: "PARKED", outcome: "no_progress", decisionDetail: null }),
        prFix({ id: "fixed", status: "FIXED", outcome: null, decisionDetail: null }),
      ],
    });
    expect(items).toEqual([]);
  });

  it("surfaces review-ready work only while the execution is not ended", () => {
    const live = compute({ agentExecutions: [execution()] }).items;
    expect(live.map((i) => i.category)).toEqual(["review_ready"]);
    expect(live[0].url).toBe("https://github.com/org/repo/pull/9");
    expect(live[0].repo).toBe("org/repo");
    expect(live[0].prNumber).toBe(9);
    expect(live[0].ageStartedAt).toBe("2026-11-04T09:00:00.000Z");
    expect(compute({ agentExecutions: [execution({ endedAt: new Date("2026-11-04T11:30:00Z") })] }).items).toEqual([]);
  });

  it("surfaces ownership intents only when pending AND parked", () => {
    expect(compute({ ownershipIntents: [intent()] }).items.map((i) => i.category)).toEqual(["ownership_parked"]);
    expect(compute({ ownershipIntents: [intent({ parkedAt: null })] }).items).toEqual([]);
    expect(compute({ ownershipIntents: [intent({ phase: "superseded" })] }).items).toEqual([]);
  });

  it("surfaces no-PR-conclusion parks with issue identity", () => {
    const { items } = compute({ noPrConclusions: [noPr()] });
    expect(items.map((i) => i.category)).toEqual(["no_pr_conclusion"]);
    expect(items[0].repo).toBe("org/repo");
    expect(items[0].issueNumber).toBe(11);
    expect(items[0].url).toBe("https://github.com/org/repo/issues/11");
    expect(items[0].reason).toContain("agent beta reported no_changes_needed");
  });

  it("drops a human-decision item once fresh evidence requeues it (resolution after new evidence)", () => {
    // mark-to-QUEUED with fresh evidence (#1105) clears outcome/decisionDetail
    // and bumps generation — the authoritative row no longer names a human.
    const before = compute({ prFixItems: [prFix()] });
    expect(before.items).toHaveLength(1);
    const after = compute({ prFixItems: [prFix({ status: "QUEUED", outcome: null, decisionDetail: null })] });
    expect(after.items).toEqual([]);
  });

  it("sorts by urgency then oldest first", () => {
    const { items } = compute({
      prFixItems: [
        prFix({ id: "sec", status: "PARKED", outcome: "security_failure", decisionDetail: null, queuedAt: "2026-11-04T11:00:00Z" }),
        prFix({ id: "hd", queuedAt: "2026-11-04T10:00:00Z" }),
      ],
      agentExecutions: [execution()],
    });
    expect(items.map((i) => i.category)).toEqual(["human_decision", "security_failure", "review_ready"]);
    // oldest-first within equal urgency: two urgency-2 rows below
    const twoUrgency = compute({
      prFixItems: [
        prFix({ id: "sec", status: "PARKED", outcome: "security_failure", decisionDetail: null, queuedAt: "2026-11-04T11:00:00Z" }),
        prFix({ id: "conf", status: "BLOCKED", type: "MERGE_CONFLICT", outcome: null, decisionDetail: null, queuedAt: "2026-11-04T09:00:00Z" }),
      ],
    }).items;
    expect(twoUrgency.map((i) => i.id)).toEqual(["semantic_conflict:conf", "security_failure:sec"]);
  });

  it("tolerates malformed decisionDetail without throwing", () => {
    const variants = [null, "nope", 42, ["array"], { options: [1, "keep", null] }, {}];
    for (const detail of variants) {
      const { items } = compute({ prFixItems: [prFix({ decisionDetail: detail })] });
      expect(items).toHaveLength(1);
      expect(items[0].decision).toEqual({
        question: null,
        options: expect.any(Array),
        evidence: null,
      });
    }
    const withFilteredOptions = compute({ prFixItems: [prFix({ decisionDetail: { options: [1, "keep", null] } })] });
    expect(withFilteredOptions.items[0].decision?.options).toEqual(["keep"]);
  });

  it("returns an empty snapshot for healthy state", () => {
    expect(compute()).toEqual({ now: NOW.toISOString(), items: [] });
  });
});
