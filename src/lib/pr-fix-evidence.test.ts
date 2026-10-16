import { describe, expect, it } from "vitest";
import {
  conditionEvidenceKey,
  computeEvidenceContentSignature,
  computeEvidenceVersion,
  CONTENT_SIGNATURE_LENGTH,
  evaluateEvidenceFreshness,
  isActionableEvidenceVersion,
  isPrFixEvidenceKind,
  ledgerRowsToPostDispatchEntries,
  type EvidenceLedgerSnapshot,
} from "./pr-fix-evidence";

function ledgerRow(overrides: Partial<EvidenceLedgerSnapshot> = {}): EvidenceLedgerSnapshot {
  return {
    identity: "review:acme/widgets#12:77",
    version: "state=changes_requested|commit=abc123",
    sequence: 7,
    contentSignature: "a".repeat(32),
    actionable: true,
    ...overrides,
  };
}

describe("isPrFixEvidenceKind", () => {
  it("accepts every known evidence kind", () => {
    for (const kind of ["review", "review_comment", "comment", "check_run", "merge_state", "merge_conflict", "unknown"] as const) {
      expect(isPrFixEvidenceKind(kind)).toBe(true);
    }
  });

  it("rejects unknown strings and null/undefined", () => {
    for (const value of ["REVIEW", "review_comment_draft", "pr_fix", "", "merge-state", null, undefined]) {
      expect(isPrFixEvidenceKind(value)).toBe(false);
    }
  });
});

describe("conditionEvidenceKey", () => {
  it("encodes the condition kinds as one stable identity per (kind, repo, PR)", () => {
    expect(conditionEvidenceKey("merge_state", "acme/widgets", 12)).toBe("merge_state:acme/widgets#12");
    expect(conditionEvidenceKey("merge_conflict", "acme/widgets", 12)).toBe("merge_conflict:acme/widgets#12");
  });

  it("keeps the parsePostDispatchEvidenceEntry eventType shape (kind before the first ':')", () => {
    for (const kind of ["merge_state", "merge_conflict"] as const) {
      const [eventType, rest] = conditionEvidenceKey(kind, "acme/widgets", 12).split(":");
      expect(eventType).toBe(kind);
      expect(rest).toBe("acme/widgets#12");
    }
  });
});

describe("computeEvidenceVersion", () => {
  it("is deterministic and stable across object key order", () => {
    const a = computeEvidenceVersion("check_run", { headSha: "h1", checkStatus: "completed", conclusion: "failure" });
    const b = computeEvidenceVersion("check_run", { conclusion: "failure", headSha: "h1", checkStatus: "completed" });
    const c = computeEvidenceVersion("check_run", { headSha: "h1", checkStatus: "completed", conclusion: "failure" });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("review: state+commitId only; case/trim-insensitive; updatedAt irrelevant", () => {
    const base = computeEvidenceVersion("review", { state: "changes_requested", commitId: "abc123" });
    expect(computeEvidenceVersion("review", { state: " CHANGES_REQUESTED ", commitId: " abc123 " })).toBe(base);
    expect(computeEvidenceVersion("review", { state: "changes_requested", commitId: "abc123", updatedAt: "2026-01-01T00:00:00Z" })).toBe(base);
  });

  it("review_comment: a flip of resolved or outdated changes the version; same values do not", () => {
    const base = computeEvidenceVersion("review_comment", { commitId: "abc", updatedAt: "t1", resolved: false, outdated: false });
    expect(computeEvidenceVersion("review_comment", { commitId: "abc", updatedAt: "t1", resolved: false, outdated: false })).toBe(base);
    expect(computeEvidenceVersion("review_comment", { commitId: "abc", updatedAt: "t1", resolved: true, outdated: false })).not.toBe(base);
    expect(computeEvidenceVersion("review_comment", { commitId: "abc", updatedAt: "t1", resolved: false, outdated: true })).not.toBe(base);
  });

  it("review_comment: unknown (unread) thread flags are a DISTINCT version token, never conflated with 'n'", () => {
    const known = computeEvidenceVersion("review_comment", { commitId: "abc", updatedAt: "t1", resolved: false, outdated: false });
    const unknown = computeEvidenceVersion("review_comment", { commitId: "abc", updatedAt: "t1", resolved: null, outdated: null });
    expect(unknown).not.toBe(known);
    expect(unknown).toContain("resolved=u");
    expect(unknown).toContain("outdated=u");
    // A failed re-read after a KNOWN observation never silently reuses the
    // known version — and (paired with ingestion deferral) never overwrites it.
    expect(computeEvidenceVersion("review_comment", { commitId: "abc", updatedAt: "t1" })).toBe(unknown);
  });

  it("check_run: head, status, and conclusion all participate", () => {
    const base = computeEvidenceVersion("check_run", { headSha: "h", checkStatus: "completed", conclusion: "failure" });
    expect(computeEvidenceVersion("check_run", { headSha: "h2", checkStatus: "completed", conclusion: "failure" })).not.toBe(base);
    expect(computeEvidenceVersion("check_run", { headSha: "h", checkStatus: "in_progress", conclusion: "failure" })).not.toBe(base);
    expect(computeEvidenceVersion("check_run", { headSha: "h", checkStatus: "completed", conclusion: "success" })).not.toBe(base);
  });

  it("merge_state: state+head; merge_conflict: mergeable+head", () => {
    const ms = computeEvidenceVersion("merge_state", { mergeStateStatus: "dirty", headSha: "h" });
    expect(computeEvidenceVersion("merge_state", { mergeStateStatus: "dirty", headSha: "h2" })).not.toBe(ms);
    expect(computeEvidenceVersion("merge_state", { mergeStateStatus: "behind", headSha: "h" })).not.toBe(ms);
    const mc = computeEvidenceVersion("merge_conflict", { mergeable: "CONFLICTING", headSha: "h" });
    expect(computeEvidenceVersion("merge_conflict", { mergeable: "MERGEABLE", headSha: "h" })).not.toBe(mc);
    expect(computeEvidenceVersion("merge_conflict", { mergeable: "CONFLICTING", headSha: "h2" })).not.toBe(mc);
  });

  it("unknown kind maps to the constant version", () => {
    expect(computeEvidenceVersion("unknown", {})).toBe("unknown");
  });
});

describe("isActionableEvidenceVersion", () => {
  it("review: only CHANGES_REQUESTED is actionable (APPROVED/DISMISSED/COMMENTED recorded, never reopened)", () => {
    expect(isActionableEvidenceVersion("review", { state: "CHANGES_REQUESTED" })).toBe(true);
    expect(isActionableEvidenceVersion("review", { state: "APPROVED" })).toBe(false);
    expect(isActionableEvidenceVersion("review", { state: "DISMISSED" })).toBe(false);
    expect(isActionableEvidenceVersion("review", { state: "COMMENTED" })).toBe(false);
  });

  it("review_comment: explicit resolved/outdated is inert; unknown (undefined) flags stay conservatively actionable", () => {
    expect(isActionableEvidenceVersion("review_comment", {})).toBe(true);
    expect(isActionableEvidenceVersion("review_comment", { resolved: false, outdated: false })).toBe(true);
    expect(isActionableEvidenceVersion("review_comment", { resolved: true })).toBe(false);
    expect(isActionableEvidenceVersion("review_comment", { outdated: true })).toBe(false);
  });

  it("comment is always actionable", () => {
    expect(isActionableEvidenceVersion("comment", {})).toBe(true);
    expect(isActionableEvidenceVersion("comment", { updatedAt: "t", actorLogin: "alice" })).toBe(true);
  });

  it("check_run: failing conclusions actionable, passing not", () => {
    for (const failing of ["failure", "cancelled", "timed_out", "action_required"]) {
      expect(isActionableEvidenceVersion("check_run", { conclusion: failing })).toBe(true);
    }
    for (const passing of ["success", "neutral"]) {
      expect(isActionableEvidenceVersion("check_run", { conclusion: passing })).toBe(false);
    }
  });

  it("merge_state: problematic states actionable, clean/blocked not", () => {
    for (const bad of ["dirty", "behind", "unstable", "has_hooks"]) {
      expect(isActionableEvidenceVersion("merge_state", { mergeStateStatus: bad })).toBe(true);
    }
    for (const good of ["clean", "blocked"]) {
      expect(isActionableEvidenceVersion("merge_state", { mergeStateStatus: good })).toBe(false);
    }
  });

  it("merge_conflict: only CONFLICTING is actionable", () => {
    expect(isActionableEvidenceVersion("merge_conflict", { mergeable: "CONFLICTING" })).toBe(true);
    expect(isActionableEvidenceVersion("merge_conflict", { mergeable: "conflicting" })).toBe(true);
    expect(isActionableEvidenceVersion("merge_conflict", { mergeable: "MERGEABLE" })).toBe(false);
    expect(isActionableEvidenceVersion("merge_conflict", { mergeable: "UNKNOWN" })).toBe(false);
  });

  it("unknown kind is never actionable (defer-and-audit, never silently resolved)", () => {
    expect(isActionableEvidenceVersion("unknown", {})).toBe(false);
  });
});

describe("computeEvidenceContentSignature", () => {
  it("returns null for empty or missing body", () => {
    expect(computeEvidenceContentSignature({})).toBeNull();
    expect(computeEvidenceContentSignature({ body: "" })).toBeNull();
    expect(computeEvidenceContentSignature({ body: "   \n\t " })).toBeNull();
  });

  it("is invariant to whitespace runs and case in the body", () => {
    const a = computeEvidenceContentSignature({ body: "Please   fix\n  the  tests", actorLogin: "alice" });
    const b = computeEvidenceContentSignature({ body: "please fix the tests", actorLogin: "alice" });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("differs when the commit id differs (same body against a newer head is NOT a signature match)", () => {
    const a = computeEvidenceContentSignature({ body: "lgtm", actorLogin: "alice", commitId: "h1" });
    const b = computeEvidenceContentSignature({ body: "lgtm", actorLogin: "alice", commitId: "h2" });
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("differs when the actor differs", () => {
    const a = computeEvidenceContentSignature({ body: "lgtm", actorLogin: "alice" });
    const b = computeEvidenceContentSignature({ body: "lgtm", actorLogin: "bob" });
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("is a 32-char lowercase hex digest", () => {
    const sig = computeEvidenceContentSignature({ body: "lgtm" });
    expect(sig).not.toBeNull();
    expect(CONTENT_SIGNATURE_LENGTH).toBe(32);
    expect(sig).toHaveLength(CONTENT_SIGNATURE_LENGTH);
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("evaluateEvidenceFreshness", () => {
  it("null ledger → unknown_provenance (never silently resolved, never fresh on its own say-so)", () => {
    expect(evaluateEvidenceFreshness({ ledger: null, watermark: 5 })).toEqual({ fresh: false, reason: "unknown_provenance" });
  });

  it("non-actionable stored version → not_actionable even when sequence > watermark (rule order)", () => {
    expect(evaluateEvidenceFreshness({ ledger: ledgerRow({ actionable: false, sequence: 9 }), watermark: 5 })).toEqual({ fresh: false, reason: "not_actionable" });
  });

  it("actionable row with null watermark → no_watermark (bounded cache keeps deciding)", () => {
    expect(evaluateEvidenceFreshness({ ledger: ledgerRow(), watermark: null })).toEqual({ fresh: false, reason: "no_watermark" });
  });

  it("actionable row whose signature another identity already holds → repeated_content_signature (checked before the watermark)", () => {
    expect(evaluateEvidenceFreshness({ ledger: ledgerRow({ sequence: 9 }), watermark: 5, repeatedContentSignature: true })).toEqual({ fresh: false, reason: "repeated_content_signature" });
  });

  it("transition after the watermark (seq 7 > 5) → fresh", () => {
    expect(evaluateEvidenceFreshness({ ledger: ledgerRow({ sequence: 7 }), watermark: 5 })).toEqual({ fresh: true, reason: "fresh_transition_after_watermark" });
  });

  it("transition at the watermark (seq 5 = 5) → not fresh (at-the-watermark is inside the hand-out snapshot)", () => {
    expect(evaluateEvidenceFreshness({ ledger: ledgerRow({ sequence: 5 }), watermark: 5 })).toEqual({ fresh: false, reason: "transition_at_or_before_watermark" });
  });

  it("replayed transition re-reads at its ORIGINAL sequence (seq 3 < 5) and stays inert forever — replays never mint a new sequence", () => {
    expect(evaluateEvidenceFreshness({ ledger: ledgerRow({ sequence: 3 }), watermark: 5 })).toEqual({ fresh: false, reason: "transition_at_or_before_watermark" });
  });

  it("control-17: a row recorded after the watermark is fresh regardless of forge timestamps — the decision takes no clock input at all", () => {
    // A webhook delivered long after settlement still lands after the watermark;
    // there is no timestamp parameter to forge, so no ancient observation time can
    // demote the decision.
    const delayed = { ledger: ledgerRow({ sequence: 10 }), watermark: 5 };
    expect(evaluateEvidenceFreshness(delayed)).toEqual({ fresh: true, reason: "fresh_transition_after_watermark" });
  });
});

describe("ledgerRowsToPostDispatchEntries", () => {
  it("encodes each row as identity@head", () => {
    expect(ledgerRowsToPostDispatchEntries([{ identity: "review:acme/widgets#12:77", headSha: "abc123" }])).toEqual(["review:acme/widgets#12:77@abc123"]);
  });

  it("missing, null, empty, and whitespace head → identity@unknown", () => {
    expect(
      ledgerRowsToPostDispatchEntries([
        { identity: "check_run:acme/widgets#12:9", headSha: undefined },
        { identity: "check_run:acme/widgets#12:10", headSha: null },
        { identity: "check_run:acme/widgets#12:11", headSha: "" },
        { identity: "check_run:acme/widgets#12:12", headSha: "   " },
      ]),
    ).toEqual([
      "check_run:acme/widgets#12:9@unknown",
      "check_run:acme/widgets#12:10@unknown",
      "check_run:acme/widgets#12:11@unknown",
      "check_run:acme/widgets#12:12@unknown",
    ]);
  });

  it("preserves row order", () => {
    expect(ledgerRowsToPostDispatchEntries([{ identity: "b", headSha: "1" }, { identity: "a", headSha: "2" }])).toEqual(["b@1", "a@2"]);
  });

  it("empty input → []", () => {
    expect(ledgerRowsToPostDispatchEntries([])).toEqual([]);
  });
});
