import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildWorkItemDeliveryChain,
  type WorkAttemptPrFixItemRecord,
  type WorkAttemptRunRecord,
} from "./work-attempt-chain";
import type { LifecycleEventRecord } from "./issue-lifecycle-read";

/**
 * Pure-fixture tests: the projection is a function of plain rows, so no
 * client stand-in is needed here — the rows are exactly the shape the
 * lifecycle GET route builds (#1183).
 */

const workItem = { repoFullName: "octocat/hello-world", issueNumber: 42 };

function event(
  overrides: Partial<LifecycleEventRecord> & { kind: string; occurredAt: Date | string },
): LifecycleEventRecord {
  return {
    kind: overrides.kind,
    source: overrides.source ?? "api:claim",
    actor: overrides.actor ?? "alpha",
    agentName: overrides.agentName ?? null,
    fromStatus: overrides.fromStatus ?? null,
    toStatus: overrides.toStatus ?? null,
    sourceEventId: overrides.sourceEventId ?? null,
    occurredAt: overrides.occurredAt,
    observedAt: overrides.observedAt ?? overrides.occurredAt,
    metadata: overrides.metadata ?? null,
  };
}

function run(overrides: Partial<WorkAttemptRunRecord> & { id: string; startedAt: Date | string }): WorkAttemptRunRecord {
  return {
    agentName: overrides.agentName ?? "alpha",
    runType: overrides.runType ?? "implement",
    status: overrides.status ?? "completed",
    finishedAt: overrides.finishedAt ?? null,
    executionMetadata: overrides.executionMetadata ?? null,
    ...overrides,
  };
}

function prFixItem(
  overrides: Partial<WorkAttemptPrFixItemRecord> & { id: string; pr: number },
): WorkAttemptPrFixItemRecord {
  return {
    repo: overrides.repo ?? "octocat/hello-world",
    issue: overrides.issue ?? 42,
    generation: overrides.generation ?? 1,
    fixAttempts: overrides.fixAttempts ?? 1,
    status: overrides.status ?? "QUEUED",
    outcome: overrides.outcome ?? null,
    queuedAt: overrides.queuedAt ?? "2026-10-01T12:00:00.000Z",
    history: overrides.history ?? [],
    ...overrides,
  };
}

function chain(inputs: Partial<{ events: LifecycleEventRecord[]; runs: WorkAttemptRunRecord[]; prFixItems: WorkAttemptPrFixItemRecord[] }> = {}) {
  return buildWorkItemDeliveryChain(workItem, {
    events: inputs.events ?? [],
    runs: inputs.runs ?? [],
    prFixItems: inputs.prFixItems ?? [],
  });
}

/**
 * Mirrors the documented execution-attempt identity scheme (#1183):
 * `exec-<first 12 hex of sha256 over the claim's canonical dedupe identity
 * [kind, fromStatus, toStatus, occurredAtMs, agentName]>` after dedupe.
 * `source`/`actor` are NOT part of the identity — the same claim observed by
 * two writers is one fact and must keep one id. Pins the contract: if the
 * join changes, this — and the doc — must change with it.
 */
function execId(claim: LifecycleEventRecord): string {
  const ms = typeof claim.occurredAt === "string" ? Date.parse(claim.occurredAt) : claim.occurredAt.getTime();
  const key = [
    claim.kind,
    claim.fromStatus ?? "",
    claim.toStatus ?? "",
    ms,
    claim.agentName ?? "",
    "",
  ].join("\u0000");
  return `exec-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

const fixId = (itemId: string, generation: number) => `fix-${itemId}-g${generation}`;

describe("buildWorkItemDeliveryChain", () => {
  it("carries the schema tag and work-item identity", () => {
    const result = chain();
    expect(result.schema).toBe("dispatch.work-item-attempt-chain/v1");
    expect(result.units).toBe("milliseconds");
    expect(result.workItem).toEqual(workItem);
    expect(result.attempts).toEqual([]);
    expect(result.totalExecutionWallTimeMs).toBeNull();
  });

  it("orders an initial execution attempt and multiple fix generations oldest-first (a)", () => {
    const claim = event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" });
    const result = chain({
      events: [
        claim,
        event({
          kind: "attempt_failed",
          source: "agent-report",
          agentName: "alpha",
          occurredAt: "2026-10-01T11:00:00.000Z",
          metadata: { outcome: "failed" },
        }),
      ],
      prFixItems: [
        prFixItem({
          id: "item-1",
          pr: 7,
          generation: 2,
          fixAttempts: 2,
          status: "FIXED",
          queuedAt: "2026-10-01T12:00:00.000Z",
          history: [
            { at: "2026-10-01T12:00:00.000Z", action: "enqueue", status: "QUEUED", outcome: null },
            { at: "2026-10-01T13:00:00.000Z", action: "mark", status: "FIXED", outcome: null },
          ],
        }),
      ],
    });

    expect(result.attempts.map((a) => a.attemptId)).toEqual([
      execId(claim),
      fixId("item-1", 1),
      fixId("item-1", 2),
    ]);
    expect(result.attempts.map((a) => a.outcome)).toEqual(["failed", "superseded", "success"]);
    expect(result.attempts[0].kind).toBe("execution");
    expect(result.attempts[0].prFix).toBeNull();
    expect(result.attempts[1].kind).toBe("fix-round");
    expect(result.attempts[1].prFix).toEqual({ itemId: "item-1", repo: "octocat/hello-world", pr: 7 });
    expect(result.attempts[2].outcome).toBe("success");
  });

  it("collapses duplicate runs and duplicate events into one attempt (b)", () => {
    const claim = () =>
      event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" });
    const result = chain({
      events: [
        // Same transition observed by two writers: api vs webhook style.
        claim(),
        claim(),
        event({
          kind: "claim",
          source: "webhook",
          agentName: "alpha",
          occurredAt: "2026-10-01T10:00:00.000Z",
        }),
      ],
      runs: [
        run({ id: "run-1", startedAt: "2026-10-01T10:05:00.000Z", finishedAt: "2026-10-01T11:00:00.000Z" }),
        run({ id: "run-1", startedAt: "2026-10-01T10:05:00.000Z", finishedAt: "2026-10-01T11:00:00.000Z" }),
      ],
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].attemptId).toBe(execId(claim()));
    expect(result.attempts[0].artifacts.agentRunIds).toEqual(["run-1"]);
    expect(result.attempts[0].wallTimeMs).toBe(3300000);
    expect(result.notes).toContain("duplicate observation collapsed");
    expect(result.notes).toContain("duplicate agent run collapsed");
  });

  it("keeps missing execution metadata null and infers nothing from run times (c)", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
      ],
      runs: [
        run({ id: "run-1", startedAt: "2026-10-01T10:05:00.000Z", finishedAt: "2026-10-01T11:00:00.000Z" }),
      ],
    });

    expect(result.attempts[0].executionMetadata).toEqual({
      workerProduct: null,
      model: null,
      reasoningEffort: null,
      runtimeRevision: null,
      cohortLabel: null,
    });
    expect(result.attempts[0].startedAt).toBe("2026-10-01T10:05:00.000Z");
    expect(result.attempts[0].endedAt).toBe("2026-10-01T11:00:00.000Z");
  });

  it("unions overlapping run intervals instead of summing them (d)", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
      ],
      runs: [
        run({ id: "run-a", startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T11:00:00.000Z" }),
        run({ id: "run-b", startedAt: "2026-10-01T10:30:00.000Z", finishedAt: "2026-10-01T11:30:00.000Z" }),
      ],
    });

    expect(result.attempts[0].artifacts.agentRunIds).toEqual(["run-a", "run-b"]);
    // Union [10:00, 11:30] = 90 minutes, not the 120-minute sum.
    expect(result.attempts[0].wallTimeMs).toBe(5400000);
    expect(result.totalExecutionWallTimeMs).toBe(5400000);
  });

  it("reads cross-product workers without product-specific branching (e)", () => {
    const alphaClaim = event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" });
    const betaClaim = event({ kind: "claim", agentName: "beta", occurredAt: "2026-10-02T10:00:00.000Z" });
    const result = chain({
      events: [
        alphaClaim,
        event({
          kind: "claim_released",
          source: "api:unclaim",
          agentName: "alpha",
          occurredAt: "2026-10-01T11:00:00.000Z",
        }),
        betaClaim,
        event({
          kind: "claim_released",
          source: "api:unclaim",
          agentName: "beta",
          occurredAt: "2026-10-02T11:00:00.000Z",
        }),
      ],
      runs: [
        run({
          id: "run-1",
          agentName: "alpha",
          startedAt: "2026-10-01T10:05:00.000Z",
          finishedAt: "2026-10-01T10:30:00.000Z",
          executionMetadata: { worker: "courier", model: "gpt-5.5" },
        }),
        run({
          id: "run-2",
          agentName: "beta",
          startedAt: "2026-10-02T10:05:00.000Z",
          finishedAt: "2026-10-02T10:30:00.000Z",
          executionMetadata: { worker: "some-other-harness" },
        }),
      ],
    });

    expect(result.attempts.map((a) => a.attemptId)).toEqual([execId(alphaClaim), execId(betaClaim)]);
    expect(result.attempts[0].executionMetadata.workerProduct).toBe("courier");
    expect(result.attempts[1].executionMetadata.workerProduct).toBe("some-other-harness");
    // Overlapping-in-time? No — disjoint windows; the total unions them all.
    expect(result.totalExecutionWallTimeMs).toBe(2 * 1500000);
  });

  it("preserves failed, blocked, superseded, and open outcomes; a completed report is never merge evidence (f)", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
        event({
          kind: "attempt_failed",
          source: "agent-report",
          agentName: "alpha",
          occurredAt: "2026-10-01T10:30:00.000Z",
          metadata: { outcome: "failed" },
        }),
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T11:00:00.000Z" }),
        event({
          kind: "attempt_failed",
          source: "agent-report",
          agentName: "alpha",
          occurredAt: "2026-10-01T11:30:00.000Z",
          metadata: { outcome: "blocked" },
        }),
        // Superseded: closed by a newer claim with no intervening release.
        event({ kind: "claim", agentName: "beta", occurredAt: "2026-10-01T12:00:00.000Z" }),
        event({ kind: "claim", agentName: "gamma", occurredAt: "2026-10-01T13:00:00.000Z" }),
        event({
          kind: "completed",
          source: "agent-report",
          agentName: "gamma",
          occurredAt: "2026-10-01T14:00:00.000Z",
        }),
        // An open attempt after the completion: no closing evidence.
        event({ kind: "claim", agentName: "gamma", occurredAt: "2026-10-02T09:00:00.000Z" }),
        // A merge inside the completed attempt's window: merge evidence in
        // artifacts, but never the attempt's outcome.
        event({
          kind: "pr_merged",
          source: "reconciler",
          sourceEventId: "pr-7",
          occurredAt: "2026-10-01T13:30:00.000Z",
          metadata: { pullRequestNumber: 7 },
        }),
      ],
    });

    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "failed",
      "blocked",
      "superseded",
      "success",
      "unclassified",
    ]);
    expect(result.notes).toContain("attempt closed by a newer claim without a release");
    // Merge evidence stays where it belongs — artifacts, not outcome. No
    // attempt outcome ever reads "merged": the chain has no merge outcome.
    expect(result.attempts[3].artifacts.pullRequestNumbers).toEqual([7]);
    const validOutcomes = ["success", "failed", "blocked", "abandoned", "superseded", "unclassified"];
    expect(result.attempts.every((a) => validOutcomes.includes(a.outcome))).toBe(true);
  });

  it("marks a superseded fix generation and a FIXED terminal outcome (g)", () => {
    const result = chain({
      prFixItems: [
        prFixItem({
          id: "item-1",
          pr: 7,
          generation: 2,
          fixAttempts: 2,
          status: "FIXED",
          queuedAt: "2026-10-01T12:00:00.000Z",
        }),
      ],
    });

    expect(result.attempts.map((a) => a.attemptId)).toEqual([
      fixId("item-1", 1),
      fixId("item-1", 2),
    ]);
    expect(result.attempts[0].outcome).toBe("superseded");
    expect(result.attempts[1].outcome).toBe("success");
  });

  it("keeps fix ids unique across two items sharing the same repo#pr, one round per generation", () => {
    const result = chain({
      prFixItems: [
        prFixItem({ id: "item-1", pr: 7, generation: 2, fixAttempts: 5, status: "FIXED" }),
        prFixItem({ id: "item-2", pr: 7, generation: 1, fixAttempts: 3, status: "QUEUED" }),
      ],
    });

    // fixAttempts (a worker-execution count) fabricates no extra rounds; the
    // ids key off the item id, so shared repo#pr cannot collide. (At equal
    // anchors the deterministic order tie-breaks on generation.)
    expect(new Set(result.attempts.map((a) => a.attemptId))).toEqual(
      new Set([fixId("item-1", 1), fixId("item-1", 2), fixId("item-2", 1)]),
    );
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map((a) => a.prFix && a.prFix.itemId)).toEqual(["item-1", "item-2", "item-1"]);
  });

  it("keeps an attempt id stable when a later duplicate observation of the same claim arrives", () => {
    // The claim was first observed by the webhook writer only.
    const observed = event({
      kind: "claim",
      source: "webhook",
      actor: "system",
      agentName: "alpha",
      fromStatus: "status/ready",
      toStatus: "status/in-progress",
      occurredAt: "2026-10-01T10:00:00.000Z",
    });
    const before = chain({ events: [observed] });
    expect(before.attempts).toHaveLength(1);
    const idBefore = before.attempts[0].attemptId;

    // The SAME logical claim, later observed by the API writer: a different
    // source AND actor, the same fact. It must collapse into the existing
    // attempt and must not rename it.
    const duplicate = event({
      kind: "claim",
      source: "api:claim",
      actor: "agent/alpha",
      agentName: "alpha",
      fromStatus: "status/ready",
      toStatus: "status/in-progress",
      occurredAt: "2026-10-01T10:00:00.000Z",
    });
    const after = chain({ events: [observed, duplicate] });

    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0].attemptId).toBe(idBefore);
    // The id is the fact's identity, not either observer's row: both rows
    // hash to the same attempt.
    expect(execId(duplicate)).toBe(execId(observed));
    expect(after.notes).toContain("duplicate observation collapsed");
  });

  it("gives distinct claims distinct attempt ids even when only the observer differs", () => {
    const first = event({
      kind: "claim",
      source: "webhook",
      agentName: "alpha",
      fromStatus: "status/ready",
      toStatus: "status/in-progress",
      occurredAt: "2026-10-01T10:00:00.000Z",
    });
    // A different agent claiming in the same instant is a different fact.
    const other = event({
      kind: "claim",
      source: "api:claim",
      agentName: "beta",
      fromStatus: "status/ready",
      toStatus: "status/in-progress",
      occurredAt: "2026-10-01T10:00:00.000Z",
    });
    // A different transition in the same instant is a different fact too.
    const otherTransition = event({
      kind: "claim",
      source: "api:claim",
      agentName: "alpha",
      fromStatus: "status/backlog",
      toStatus: "status/in-progress",
      occurredAt: "2026-10-01T10:00:00.000Z",
    });

    const result = chain({ events: [first, other, otherTransition] });
    expect(result.attempts).toHaveLength(3);
    expect(new Set(result.attempts.map((a) => a.attemptId)).size).toBe(3);
    expect([...result.attempts.map((a) => a.attemptId)].sort()).toEqual(
      [execId(first), execId(other), execId(otherTransition)].sort(),
    );
  });

  it("merges a fact's evidence across its observations instead of trusting the representative row", () => {
    // A backfilled reconstruction of the claim and a live observation of the
    // same claim are one fact. The backfilled row sorts FIRST (source
    // "api:claim" < "webhook"), so a representative-only read would report
    // the fact as backfilled even though a source recorded it live.
    const backfilled = event({
      kind: "claim",
      source: "api:claim",
      agentName: "alpha",
      fromStatus: "status/ready",
      toStatus: "status/in-progress",
      occurredAt: "2026-10-01T10:00:00.000Z",
      metadata: { backfilled: true },
    });
    const live = event({
      kind: "claim",
      source: "webhook",
      agentName: "alpha",
      fromStatus: "status/ready",
      toStatus: "status/in-progress",
      occurredAt: "2026-10-01T10:00:00.000Z",
    });
    const merged = chain({ events: [backfilled, live] });
    expect(merged.attempts).toHaveLength(1);
    expect(merged.attempts[0].claimedAt.provenance).toBe("observed");
    // The fact was recorded live, so the id is the same one it had before
    // the backfilled observation arrived.
    expect(merged.attempts[0].attemptId).toBe(execId(live));

    // A claim that ONLY a backfill observed stays backfilled.
    const onlyBackfilled = chain({ events: [backfilled] });
    expect(onlyBackfilled.attempts[0].claimedAt.provenance).toBe("backfilled");
  });

  it("keeps an attested failure outcome when a duplicate observation carries no outcome", () => {
    const failure = event({
      kind: "attempt_failed",
      source: "webhook",
      agentName: "alpha",
      occurredAt: "2026-10-01T11:00:00.000Z",
      metadata: { outcome: "failed" },
    });
    const before = chain({
      events: [event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }), failure],
    });
    expect(before.attempts[0].outcome).toBe("failed");

    // The same failure observed by another writer, without the outcome
    // metadata: the attested outcome survives. This duplicate sorts FIRST
    // ("agent-report" < "webhook"), so a representative-only read would
    // report the attempt as unclassified.
    const withoutOutcome = event({
      kind: "attempt_failed",
      source: "agent-report",
      actor: "system",
      agentName: "alpha",
      occurredAt: "2026-10-01T11:00:00.000Z",
    });
    const after = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
        failure,
        withoutOutcome,
      ],
    });
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0].outcome).toBe("failed");
    expect(after.attempts[0].attemptId).toBe(before.attempts[0].attemptId);
  });

  it("attributes the outcome to the claim's own agent when another agent closes at the same instant", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
        // A cross-agent closing that sorts FIRST (source "agent-report" <
        // "zz-agent-report") — it must not mask the claim's own report.
        event({
          kind: "completed",
          source: "agent-report",
          actor: "beta",
          agentName: "beta",
          occurredAt: "2026-10-01T11:00:00.000Z",
        }),
        event({
          kind: "completed",
          source: "zz-agent-report",
          actor: "alpha",
          agentName: "alpha",
          occurredAt: "2026-10-01T11:00:00.000Z",
        }),
      ],
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].outcome).toBe("success");
    expect(result.attempts[0].reportedAt).toBe("2026-10-01T11:00:00.000Z");
    expect(result.notes).not.toContain(
      "closing report from a different agent ignored for outcome attribution",
    );
  });

  it("never lets a closing observation that PRECEDES the claim close the attempt", () => {
    const result = chain({
      events: [
        // Same instant as the claim, but sorted first ("attempt_failed" <
        // "claim"): it belongs to an earlier attempt, not to this one.
        event({
          kind: "attempt_failed",
          source: "agent-report",
          agentName: "alpha",
          occurredAt: "2026-10-01T12:00:00.000Z",
          metadata: { outcome: "failed" },
        }),
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T12:00:00.000Z" }),
        event({
          kind: "completed",
          source: "agent-report",
          agentName: "beta",
          occurredAt: "2026-10-01T12:00:00.000Z",
        }),
      ],
    });

    expect(result.attempts).toHaveLength(1);
    // The only closing evidence AFTER the claim is another agent's report:
    // it closes the window but never decides the outcome.
    expect(result.attempts[0].outcome).toBe("unclassified");
    expect(result.notes).toContain(
      "closing report from a different agent ignored for outcome attribution",
    );
  });

  it("keeps execution attempt ids stable when a backfilled EARLIER claim arrives", () => {
    const originalClaim = event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" });
    const closing = event({
      kind: "attempt_failed",
      source: "agent-report",
      agentName: "alpha",
      occurredAt: "2026-10-01T11:00:00.000Z",
      metadata: { outcome: "failed" },
    });

    const before = chain({
      events: [originalClaim, closing],
      runs: [run({ id: "run-1", startedAt: "2026-10-01T10:05:00.000Z", finishedAt: "2026-10-01T10:30:00.000Z" })],
    });
    expect(before.attempts.map((a) => a.attemptId)).toEqual([execId(originalClaim)]);

    // A backfilled claim that PREDATES the original arrives later. A
    // positional ordinal would rename the original attempt from 2nd... it
    // shifts every ordinal; the content-derived ids must not move.
    const backfilled = event({
      kind: "claim",
      agentName: "alpha",
      occurredAt: "2026-10-01T09:00:00.000Z",
      metadata: { backfilled: true },
    });
    const after = chain({
      events: [backfilled, originalClaim, closing],
      runs: [run({ id: "run-1", startedAt: "2026-10-01T10:05:00.000Z", finishedAt: "2026-10-01T10:30:00.000Z" })],
    });

    expect(after.attempts).toHaveLength(2);
    expect(after.attempts.map((a) => a.attemptId)).toEqual([
      execId(backfilled),
      execId(originalClaim),
    ]);
    expect(after.attempts[1].outcome).toBe("failed");
    expect(after.attempts[1].artifacts.agentRunIds).toEqual(["run-1"]);
  });

  it("ignores a different agent's closing report for outcome attribution, but still closes the window", () => {
    const claim = event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" });
    const mismatched = chain({
      events: [
        claim,
        event({
          kind: "completed",
          source: "agent-report",
          agentName: "someone-else",
          occurredAt: "2026-10-01T11:00:00.000Z",
        }),
      ],
    });
    expect(mismatched.attempts[0].reportedAt).toBe("2026-10-01T11:00:00.000Z");
    expect(mismatched.attempts[0].outcome).toBe("unclassified");
    expect(mismatched.notes).toContain("closing report from a different agent ignored for outcome attribution");

    const mismatchedFailure = chain({
      events: [
        claim,
        event({
          kind: "attempt_failed",
          source: "agent-report",
          agentName: "someone-else",
          occurredAt: "2026-10-01T11:00:00.000Z",
          metadata: { outcome: "failed" },
        }),
      ],
    });
    expect(mismatchedFailure.attempts[0].outcome).toBe("unclassified");

    // Same-agent completed keeps the existing success behavior.
    const sameAgent = chain({
      events: [
        claim,
        event({
          kind: "completed",
          source: "agent-report",
          agentName: "alpha",
          occurredAt: "2026-10-01T11:00:00.000Z",
        }),
      ],
    });
    expect(sameAgent.attempts[0].outcome).toBe("success");
    expect(sameAgent.notes).not.toContain("closing report from a different agent ignored for outcome attribution");
  });

  it("maps a BLOCKED fix item to blocked and a PARKED one to abandoned", () => {
    const blocked = chain({
      prFixItems: [prFixItem({ id: "item-1", pr: 7, status: "BLOCKED" })],
    });
    expect(blocked.attempts[0].outcome).toBe("blocked");

    const parked = chain({
      prFixItems: [prFixItem({ id: "item-2", pr: 8, status: "PARKED" })],
    });
    expect(parked.attempts[0].outcome).toBe("abandoned");
  });

  it("classifies a release that retained status/in-review as waiting-review, without run evidence", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
        event({
          kind: "claim_released",
          source: "api:unclaim",
          agentName: "alpha",
          toStatus: "status/in-review",
          occurredAt: "2026-10-01T11:00:00.000Z",
        }),
      ],
    });

    expect(result.attempts[0].classification).toBe("waiting-review");
    expect(result.attempts[0].outcome).toBe("unclassified");
    expect(result.attempts[0].startedAt).toBeNull();
  });

  it("reports merge evidence inside an execution window without changing classification", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
        event({
          kind: "claim_released",
          source: "api:unclaim",
          agentName: "alpha",
          occurredAt: "2026-10-01T12:00:00.000Z",
        }),
        event({
          kind: "pr_merged",
          source: "reconciler",
          sourceEventId: "pr-7",
          occurredAt: "2026-10-01T11:00:00.000Z",
          metadata: { pullRequestNumber: 7 },
        }),
      ],
    });

    expect(result.attempts[0].classification).toBe("unclassified");
    expect(result.attempts[0].artifacts.pullRequestNumbers).toEqual([7]);
  });

  it("keeps claim time distinct from run execution time", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
        event({
          kind: "claim_released",
          source: "api:unclaim",
          agentName: "alpha",
          occurredAt: "2026-10-01T12:00:00.000Z",
        }),
      ],
      runs: [
        run({ id: "run-1", startedAt: "2026-10-01T10:10:00.000Z", finishedAt: "2026-10-01T10:40:00.000Z" }),
      ],
    });

    expect(result.attempts[0].claimedAt.at).toBe("2026-10-01T10:00:00.000Z");
    expect(result.attempts[0].startedAt).toBe("2026-10-01T10:10:00.000Z");
    expect(result.attempts[0].endedAt).toBe("2026-10-01T10:40:00.000Z");
    expect(result.attempts[0].reportedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(result.attempts[0].wallTimeMs).toBe(1800000);
  });

  it("unions execution metadata across matched runs, first non-null per field in run order", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
      ],
      runs: [
        run({
          id: "run-a",
          startedAt: "2026-10-01T10:05:00.000Z",
          finishedAt: "2026-10-01T10:20:00.000Z",
          executionMetadata: { worker: "courier", model: "gpt-5.5" },
        }),
        run({
          id: "run-b",
          startedAt: "2026-10-01T10:20:00.000Z",
          finishedAt: "2026-10-01T10:40:00.000Z",
          executionMetadata: { model: "claude-opus", cohortLabel: "exp-42" },
        }),
      ],
    });

    expect(result.attempts[0].executionMetadata).toEqual({
      workerProduct: "courier",
      model: "gpt-5.5",
      reasoningEffort: null,
      runtimeRevision: null,
      cohortLabel: "exp-42",
    });
  });

  it("skips unparseable timestamps with a note, never fatally", () => {
    const result = chain({
      events: [
        event({ kind: "claim", agentName: "alpha", occurredAt: "not-a-date", source: "api:claim" }),
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
      ],
      runs: [run({ id: "run-bad", startedAt: "also-not-a-date" })],
      prFixItems: [
        prFixItem({
          id: "item-1",
          pr: 7,
          history: [{ at: "nope", action: "enqueue", status: null, outcome: null }],
        }),
      ],
    });

    expect(result.attempts).toHaveLength(2);
    expect(result.notes).toContain("event claim (api:claim) skipped: unparseable occurredAt");
    expect(result.notes).toContain("agent run run-bad skipped: unparseable startedAt");
    expect(result.notes).toContain(
      "pr-fix item octocat/hello-world#7 history entry skipped: unparseable at",
    );
  });

  it("is invariant to the order rows arrive in", () => {
    const events = [
      event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T10:00:00.000Z" }),
      event({
        kind: "attempt_failed",
        source: "agent-report",
        agentName: "alpha",
        occurredAt: "2026-10-01T11:00:00.000Z",
        metadata: { outcome: "failed" },
      }),
      event({ kind: "claim", agentName: "beta", occurredAt: "2026-10-01T12:00:00.000Z" }),
    ];
    const runs = [
      run({
        id: "run-2",
        agentName: "beta",
        startedAt: "2026-10-01T12:05:00.000Z",
        finishedAt: "2026-10-01T12:30:00.000Z",
        executionMetadata: { worker: "some-other-harness" },
      }),
      run({
        id: "run-1",
        agentName: "alpha",
        startedAt: "2026-10-01T10:05:00.000Z",
        finishedAt: "2026-10-01T10:30:00.000Z",
        executionMetadata: { worker: "courier" },
      }),
    ];

    const forward = buildWorkItemDeliveryChain(workItem, { events, runs, prFixItems: [] });
    const reversed = buildWorkItemDeliveryChain(workItem, {
      events: [...events].reverse(),
      runs: [...runs].reverse(),
      prFixItems: [],
    });

    expect(reversed).toEqual(forward);
  });
});
