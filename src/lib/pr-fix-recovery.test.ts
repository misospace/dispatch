// @vitest-environment node
// Transition-table coverage for the #1253 recovery policy
// (docs/pr-fix-recovery-policy.md, rows 8-16/19 and negative controls
// 6/7/13). `evaluateRecovery` is pure: every input — including `now` — is
// supplied, so these pins carry no clock or I/O.
import { describe, expect, it } from "vitest";
import {
  classifyParkedBudget,
  evaluateRecovery,
  recoveryCooldownMs,
  DEFAULT_PR_FIX_RECOVERY_COOLDOWN_MS,
  type RecoveryEvaluationInput,
} from "./pr-fix-recovery";

const NOW = new Date("2026-10-18T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function base(overrides: Partial<RecoveryEvaluationInput> = {}): RecoveryEvaluationInput {
  return {
    status: "PARKED",
    outcome: "no_progress",
    fixAttempts: 1,
    handoutReclaims: 0,
    hasValidExternalWait: true,
    freshEvidence: true,
    ledgerProvenance: true,
    now: NOW,
    disposedAt: new Date(NOW.getTime() - 2 * 24 * HOUR),
    recoveryAppliedAt: null,
    maxAttempts: 5,
    maxReclaims: 3,
    cooldownMs: 6 * HOUR,
    ...overrides,
  };
}

describe("recoveryCooldownMs", () => {
  const ORIGINAL = process.env.PR_FIX_RECOVERY_COOLDOWN_MS;
  const set = (value: string | undefined) => {
    if (value === undefined) delete process.env.PR_FIX_RECOVERY_COOLDOWN_MS;
    else process.env.PR_FIX_RECOVERY_COOLDOWN_MS = value;
  };

  it.afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PR_FIX_RECOVERY_COOLDOWN_MS;
    else process.env.PR_FIX_RECOVERY_COOLDOWN_MS = ORIGINAL;
  });

  it("defaults to 6h when unset, non-integer, or out of the clamp range", () => {
    set(undefined);
    expect(recoveryCooldownMs()).toBe(DEFAULT_PR_FIX_RECOVERY_COOLDOWN_MS);
    set("not-a-number");
    expect(recoveryCooldownMs()).toBe(DEFAULT_PR_FIX_RECOVERY_COOLDOWN_MS);
    set("59999"); // below the 1-minute floor
    expect(recoveryCooldownMs()).toBe(DEFAULT_PR_FIX_RECOVERY_COOLDOWN_MS);
    set(String(7 * 24 * 60 * 60 * 1000 + 1)); // above the 7-day ceiling
    expect(recoveryCooldownMs()).toBe(DEFAULT_PR_FIX_RECOVERY_COOLDOWN_MS);
  });

  it("accepts integers inside the clamp range", () => {
    set("60000");
    expect(recoveryCooldownMs()).toBe(60000);
    set(String(7 * 24 * 60 * 60 * 1000));
    expect(recoveryCooldownMs()).toBe(7 * 24 * 60 * 60 * 1000);
    set(String(2 * HOUR));
    expect(recoveryCooldownMs()).toBe(2 * HOUR);
  });
});

describe("classifyParkedBudget", () => {
  it("classifies infra/security/invalid_wait parks fail-closed regardless of budget (B1)", () => {
    expect(classifyParkedBudget({ status: "PARKED", outcome: "infra_failure", fixAttempts: 0 }, 5, 3)).toBe("fail-closed");
    expect(classifyParkedBudget({ status: "PARKED", outcome: "security_failure", fixAttempts: 0 }, 5, 3)).toBe("fail-closed");
    // The #1250 fail-closed downgrade park (negative control 16).
    expect(classifyParkedBudget({ status: "PARKED", outcome: "invalid_wait", fixAttempts: 0 }, 5, 3)).toBe("fail-closed");
  });

  it("classifies cap-exhausted parks by attempts or reclaims", () => {
    expect(classifyParkedBudget({ status: "PARKED", outcome: "no_progress", fixAttempts: 5 }, 5, 3)).toBe("exhausted");
    expect(classifyParkedBudget({ status: "PARKED", outcome: "no_progress", fixAttempts: 2, handoutReclaims: 3 }, 5, 3)).toBe("exhausted");
  });

  it("classifies budget-available parks and stays PARKED-shaped elsewhere", () => {
    expect(classifyParkedBudget({ status: "PARKED", outcome: "no_progress", fixAttempts: 4 }, 5, 3)).toBe("available");
    expect(classifyParkedBudget({ status: "PARKED", outcome: null, fixAttempts: null }, 5, 3)).toBe("available");
    // Non-PARKED statuses read "available": the class is only meaningful
    // for PARKED (documented contract).
    expect(classifyParkedBudget({ status: "QUEUED" }, 5, 3)).toBe("available");
    expect(classifyParkedBudget({ status: "BLOCKED", outcome: "human_decision", fixAttempts: 99 }, 5, 3)).toBe("available");
  });
});

describe("evaluateRecovery — BLOCKED (row 16, control 13)", () => {
  it("holds and flags the stale disposition on fresh evidence; never reactivates", () => {
    const decision = evaluateRecovery(base({ status: "BLOCKED", outcome: "human_decision" }));
    expect(decision).toMatchObject({ action: "hold", charged: false, setStaleDisposition: true });
  });

  it("holds without flagging on duplicate evidence", () => {
    const decision = evaluateRecovery(base({ status: "BLOCKED", outcome: "human_decision", freshEvidence: false }));
    expect(decision).toMatchObject({ action: "hold", setStaleDisposition: false });
  });

  it("still flags on fresh evidence WITHOUT ledger provenance — only reactivation needs the ledger (N3)", () => {
    const decision = evaluateRecovery(
      base({ status: "BLOCKED", outcome: "human_decision", ledgerProvenance: false }),
    );
    expect(decision).toMatchObject({ action: "hold", setStaleDisposition: true });
  });
});

describe("evaluateRecovery — PARKED fail-closed (rows 10/11)", () => {
  it("holds and flags on fresh evidence for infra_failure and security_failure", () => {
    for (const outcome of ["infra_failure", "security_failure"]) {
      const decision = evaluateRecovery(base({ outcome }));
      expect(decision).toMatchObject({ action: "hold", charged: false, setStaleDisposition: true });
      expect(decision.reason).toContain(outcome);
    }
  });

  it("holds without flagging on duplicate evidence", () => {
    expect(
      evaluateRecovery(base({ outcome: "infra_failure", freshEvidence: false })).setStaleDisposition,
    ).toBe(false);
  });
});

describe("evaluateRecovery — PARKED exhausted (row 9, control 7)", () => {
  it("holds and flags when fixAttempts reach the cap; no reactivation", () => {
    const decision = evaluateRecovery(base({ fixAttempts: 5, maxAttempts: 5 }));
    expect(decision).toMatchObject({ action: "hold", charged: false, setStaleDisposition: true });
  });

  it("holds and flags when handoutReclaims reach the reclaim cap", () => {
    const decision = evaluateRecovery(base({ handoutReclaims: 3, maxReclaims: 3 }));
    expect(decision).toMatchObject({ action: "hold", setStaleDisposition: true });
  });

  it("holds without flagging on duplicate evidence", () => {
    expect(
      evaluateRecovery(base({ fixAttempts: 5, maxAttempts: 5, freshEvidence: false })).setStaleDisposition,
    ).toBe(false);
  });
});

describe("evaluateRecovery — PARKED available (row 8, control 6)", () => {
  it("reactivates charged after the cooldown (anchor: recoveryAppliedAt when it is the latest stamp)", () => {
    const decision = evaluateRecovery(
      base({
        disposedAt: null,
        recoveryAppliedAt: new Date(NOW.getTime() - 7 * HOUR),
      }),
    );
    expect(decision).toMatchObject({
      action: "reactivate",
      charged: true,
      setStaleDisposition: false,
      clearRetryAt: true,
      clearExternalWait: true,
      clearOutcome: true,
    });
  });

  it("falls back to the disposedAt anchor when never reactivated", () => {
    const decision = evaluateRecovery(base({ disposedAt: new Date(NOW.getTime() - 7 * HOUR) }));
    expect(decision.action).toBe("reactivate");
  });

  it("holds while the cooldown is still running from the disposedAt anchor", () => {
    const decision = evaluateRecovery(base({ disposedAt: new Date(NOW.getTime() - HOUR) }));
    expect(decision).toMatchObject({ action: "hold", setStaleDisposition: false });
  });

  it("anchors on the LATEST stamp: a fresh re-park's disposedAt re-arms the cooldown even though recoveryAppliedAt survives (S1)", () => {
    // recoveryAppliedAt is stale (-7h, past the cooldown) but the re-park's
    // disposedAt is recent (-1h): the max anchor holds.
    const held = evaluateRecovery(
      base({
        disposedAt: new Date(NOW.getTime() - HOUR),
        recoveryAppliedAt: new Date(NOW.getTime() - 7 * HOUR),
      }),
    );
    expect(held).toMatchObject({ action: "hold", setStaleDisposition: false });
    // Mirror image: recoveryAppliedAt newer than disposedAt anchors on it.
    const heldOtherWay = evaluateRecovery(
      base({
        disposedAt: new Date(NOW.getTime() - 7 * HOUR),
        recoveryAppliedAt: new Date(NOW.getTime() - HOUR),
      }),
    );
    expect(heldOtherWay.action).toBe("hold");
  });

  it("is eligible immediately when neither anchor exists (legacy rows; caps still bound the cycle)", () => {
    const decision = evaluateRecovery(base({ disposedAt: null, recoveryAppliedAt: null }));
    expect(decision.action).toBe("reactivate");
    expect(decision.charged).toBe(true);
  });

  it("holds without flagging on duplicate evidence, regardless of the cooldown", () => {
    const decision = evaluateRecovery(base({ freshEvidence: false, disposedAt: new Date(NOW.getTime() - 7 * HOUR) }));
    expect(decision).toMatchObject({ action: "hold", setStaleDisposition: false });
  });

  it("downgrades a would-be reactivation to an unflagged hold without durable-ledger provenance (N3, control 8)", () => {
    const decision = evaluateRecovery(
      base({ disposedAt: new Date(NOW.getTime() - 7 * HOUR), ledgerProvenance: false }),
    );
    expect(decision).toMatchObject({ action: "hold", charged: false, setStaleDisposition: false });
    expect(decision.reason).toContain("ledger provenance");
  });
});

describe("evaluateRecovery — WAITING_EXTERNAL (rows 13/15, #1250 fail-closed)", () => {
  it("reactivates charged on fresh evidence, independent of the cooldown", () => {
    const decision = evaluateRecovery(
      base({ status: "WAITING_EXTERNAL", outcome: null, disposedAt: NOW, recoveryAppliedAt: NOW }),
    );
    expect(decision).toMatchObject({
      action: "reactivate",
      charged: true,
      clearRetryAt: true,
      clearExternalWait: true,
      clearOutcome: true,
      setStaleDisposition: false,
    });
  });

  it("holds a legacy (unparseable) wait without flagging", () => {
    const decision = evaluateRecovery(
      base({ status: "WAITING_EXTERNAL", outcome: null, hasValidExternalWait: false }),
    );
    expect(decision).toMatchObject({ action: "hold", setStaleDisposition: false });
  });

  it("holds on duplicate evidence during a structured wait", () => {
    const decision = evaluateRecovery(
      base({ status: "WAITING_EXTERNAL", outcome: null, freshEvidence: false }),
    );
    expect(decision).toMatchObject({ action: "hold", setStaleDisposition: false });
  });

  it("downgrades a would-be wait reactivation to an unflagged hold without ledger provenance (N3)", () => {
    const decision = evaluateRecovery(
      base({ status: "WAITING_EXTERNAL", outcome: null, ledgerProvenance: false }),
    );
    expect(decision).toMatchObject({ action: "hold", setStaleDisposition: false });
  });
});

describe("evaluateRecovery — terminal states (row 19)", () => {
  it("holds STALE and IGNORED, never flags, never reactivates", () => {
    for (const status of ["STALE", "IGNORED"] as const) {
      const decision = evaluateRecovery(base({ status }));
      expect(decision).toMatchObject({ action: "hold", charged: false, setStaleDisposition: false });
      const duplicate = evaluateRecovery(base({ status, freshEvidence: false }));
      expect(duplicate).toMatchObject({ action: "hold", setStaleDisposition: false });
    }
  });
});
