import { describe, expect, it } from "vitest";
import {
  buildIntakeAck,
  LEGACY_KNOWN_CAPABILITIES,
  negotiateCapabilityAgainst,
  parseIntakeRequest,
  PR_OWNERSHIP_EVIDENCE_CAPABILITY,
  PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION,
  REBASE_EXECUTOR_CAPABILITY,
  REBASE_EXECUTOR_CAPABILITY_VERSION,
  REBASE_INTAKE_CONTRACT_VERSION,
  REBASE_MODEL_EXECUTOR_CAPABILITY,
  REBASE_MODEL_EXECUTOR_CAPABILITY_VERSION,
  REBASE_ONLY_SCOPE,
} from "./rebase-intake";

function parse(query: string) {
  return parseIntakeRequest(new URLSearchParams(query));
}

function negotiationOf(query: string) {
  const result = parse(query);
  if (!result.ok) throw new Error(`expected a successful parse, got: ${result.error}`);
  return result.negotiation;
}

function errorOf(query: string) {
  const result = parse(query);
  if (result.ok) throw new Error("expected a rejected parse");
  return result.error;
}

describe("parseIntakeRequest — rebase-only scope (#1532)", () => {
  it("accepts a rebase-only request that declares the rebase-executor capability", () => {
    const negotiation = negotiationOf(
      `work_scope=${REBASE_ONLY_SCOPE}&work_scope_version=1&capabilities=${REBASE_EXECUTOR_CAPABILITY}:1`,
    );

    expect(negotiation.scope).toBe(REBASE_ONLY_SCOPE);
    expect(negotiation.scopeEnforced).toBe(true);
    expect(negotiation.optedIn).toBe(true);
    expect(negotiation.rebaseExecutorGranted).toBe(true);
    expect(negotiation.capabilities).toEqual([
      { name: REBASE_EXECUTOR_CAPABILITY, requested: 1, granted: true },
    ]);
  });

  it("treats an ordinary request (no intake parameters) as no contract at all", () => {
    const negotiation = negotiationOf("");

    expect(negotiation.optedIn).toBe(false);
    expect(negotiation.scope).toBeNull();
    expect(negotiation.scopeEnforced).toBe(true);
    expect(negotiation.capabilities).toEqual([]);
    expect(negotiation.rebaseExecutorGranted).toBe(false);
  });

  it("treats a capability-only request as opted in without a scope", () => {
    const negotiation = negotiationOf(`capabilities=${REBASE_EXECUTOR_CAPABILITY}:1`);

    expect(negotiation.optedIn).toBe(true);
    expect(negotiation.scope).toBeNull();
    expect(negotiation.rebaseExecutorGranted).toBe(true);
    expect(negotiation.capabilities).toEqual([
      { name: REBASE_EXECUTOR_CAPABILITY, requested: 1, granted: true },
    ]);
  });

  it("rejects an unknown scope", () => {
    expect(errorOf("work_scope=rebase&work_scope_version=1")).toBe(
      'Unsupported work_scope "rebase"; supported: rebase-only',
    );
  });

  it("rejects a scope without its version", () => {
    expect(errorOf(`work_scope=${REBASE_ONLY_SCOPE}`)).toBe("work_scope requires work_scope_version");
  });

  it("rejects a version without its scope", () => {
    expect(errorOf("work_scope_version=1")).toBe("work_scope_version requires work_scope");
  });

  it("rejects an unsupported scope version", () => {
    expect(errorOf(`work_scope=${REBASE_ONLY_SCOPE}&work_scope_version=2`)).toBe(
      'Unsupported work_scope_version "2"; supported: 1',
    );
  });

  it("rejects a rebase-only request without the capability declaration", () => {
    expect(errorOf(`work_scope=${REBASE_ONLY_SCOPE}&work_scope_version=1`)).toBe(
      "rebase-only intake requires the rebase-executor:1 capability declaration",
    );
  });

  it("rejects a rebase-only request whose capability version is unsupported", () => {
    expect(
      errorOf(`work_scope=${REBASE_ONLY_SCOPE}&work_scope_version=1&capabilities=${REBASE_EXECUTOR_CAPABILITY}:2`),
    ).toBe(
      "rebase-only intake requires a supported rebase-executor capability (v1); requested v2 is unsupported",
    );
  });

  it("rejects a repeated scope parameter instead of taking the first value", () => {
    expect(errorOf("work_scope=rebase-only&work_scope=bogus")).toBe("Repeated work_scope");
    expect(errorOf("work_scope_version=1&work_scope_version=2")).toBe("Repeated work_scope_version");
  });

  it("rejects a scope value beyond the size limit", () => {
    expect(errorOf(`work_scope=${"s".repeat(65)}`)).toBe("work_scope exceeds the size limit (64 characters)");
    expect(errorOf("work_scope_version=" + "v".repeat(65))).toBe(
      "work_scope_version exceeds the size limit (64 characters)",
    );
  });
});

describe("parseIntakeRequest — capability declarations (#1532)", () => {
  it("rejects a malformed capability token", () => {
    expect(errorOf("capabilities=rebase-executor")).toBe('Malformed capabilities entry "rebase-executor"');
    expect(errorOf("capabilities=rebase-executor:0")).toBe('Malformed capabilities entry "rebase-executor:0"');
    expect(errorOf("capabilities=Rebase-Executor:1")).toBe('Malformed capabilities entry "Rebase-Executor:1"');
  });

  it("rejects the same capability name declared twice", () => {
    expect(errorOf("capabilities=rebase-executor:1,rebase-executor:1")).toBe(
      'Contradictory capability declaration for "rebase-executor"',
    );
    expect(errorOf("capabilities=rebase-executor:1,rebase-executor:2")).toBe(
      'Contradictory capability declaration for "rebase-executor"',
    );
  });

  it("grants nothing for an unknown capability name, without failing", () => {
    const negotiation = negotiationOf("capabilities=future-capability:3");

    expect(negotiation.optedIn).toBe(true);
    expect(negotiation.rebaseExecutorGranted).toBe(false);
    expect(negotiation.capabilities).toEqual([
      { name: "future-capability", requested: 3, granted: false, reason: "unknown-capability" },
    ]);
  });

  it("grants nothing for an unknown capability version, without failing", () => {
    const negotiation = negotiationOf(`capabilities=${REBASE_EXECUTOR_CAPABILITY}:2`);

    expect(negotiation.rebaseExecutorGranted).toBe(false);
    expect(negotiation.capabilities).toEqual([
      { name: REBASE_EXECUTOR_CAPABILITY, requested: 2, granted: false, reason: "unsupported-version" },
    ]);
  });

  it("rejects a declaration beyond the size limit", () => {
    const long = Array.from({ length: 40 }, (_, i) => `capability-${i}:1`).join(",");
    expect(errorOf(`capabilities=${long}`)).toBe("capabilities declaration exceeds the size limit");
    expect(errorOf(`capabilities=${"a".repeat(513)}`)).toBe("capabilities declaration exceeds the size limit");
  });

  it("accepts a declaration at the size limit", () => {
    const tokens = Array.from({ length: 16 }, (_, i) => `capability-${i}:1`);
    const negotiation = negotiationOf(`capabilities=${tokens.join(",")}`);

    expect(negotiation.capabilities).toHaveLength(16);
    expect(negotiation.capabilities.every((capability) => !capability.granted)).toBe(true);
  });

  it("treats an empty declaration as no declaration", () => {
    const negotiation = negotiationOf("capabilities=");

    expect(negotiation.optedIn).toBe(false);
    expect(negotiation.capabilities).toEqual([]);
  });

  it("ignores an empty element in a declaration", () => {
    // A client that appends the parameter unconditionally sends an empty
    // element when it has nothing to declare. An empty element is not a
    // declaration and must not fail the poll.
    const negotiation = negotiationOf("capabilities=rebase-executor:1&capabilities=");

    expect(negotiation.rebaseExecutorGranted).toBe(true);
    expect(negotiation.capabilities).toEqual([
      { name: REBASE_EXECUTOR_CAPABILITY, requested: 1, granted: true },
    ]);
  });
});

describe("buildIntakeAck (#1532)", () => {
  it("carries the contract version, the scope, and the capability verdicts", () => {
    const ack = buildIntakeAck(
      negotiationOf(`work_scope=${REBASE_ONLY_SCOPE}&work_scope_version=1&capabilities=${REBASE_EXECUTOR_CAPABILITY}:1`),
    );

    expect(ack).toEqual({
      version: REBASE_INTAKE_CONTRACT_VERSION,
      scope: REBASE_ONLY_SCOPE,
      scopeEnforced: true,
      capabilities: [{ name: REBASE_EXECUTOR_CAPABILITY, requested: 1, granted: true }],
    });
  });

  it("reports a not-granted capability with its reason", () => {
    const ack = buildIntakeAck(negotiationOf(`capabilities=${REBASE_EXECUTOR_CAPABILITY}:7`));

    expect(ack.version).toBe(REBASE_INTAKE_CONTRACT_VERSION);
    expect(ack.scope).toBeNull();
    expect(ack.capabilities).toEqual([
      { name: REBASE_EXECUTOR_CAPABILITY, requested: 7, granted: false, reason: "unsupported-version" },
    ]);
  });
});

describe("parseIntakeRequest — the model-assisted rebase capability (#1674)", () => {
  // The EXACT requested capability: the token is part of the negotiated
  // contract, so these tests pin the name and the version byte-for-byte.
  const MODEL_DECLARATION = `${REBASE_MODEL_EXECUTOR_CAPABILITY}:${REBASE_MODEL_EXECUTOR_CAPABILITY_VERSION}`;

  it("grants the exact model capability alongside the mechanical executor", () => {
    const negotiation = negotiationOf(
      `work_scope=${REBASE_ONLY_SCOPE}&work_scope_version=1&capabilities=${REBASE_EXECUTOR_CAPABILITY}:${REBASE_EXECUTOR_CAPABILITY_VERSION},${MODEL_DECLARATION}`,
    );

    expect(negotiation.rebaseExecutorGranted).toBe(true);
    expect(negotiation.rebaseModelExecutorGranted).toBe(true);
    expect(negotiation.capabilities).toEqual([
      { name: REBASE_EXECUTOR_CAPABILITY, requested: 1, granted: true },
      { name: REBASE_MODEL_EXECUTOR_CAPABILITY, requested: 1, granted: true },
    ]);
  });

  it("grants the model capability alone without a scope (opted in, nothing unlocked)", () => {
    const negotiation = negotiationOf(`capabilities=${MODEL_DECLARATION}`);

    expect(negotiation.optedIn).toBe(true);
    expect(negotiation.scope).toBeNull();
    expect(negotiation.rebaseModelExecutorGranted).toBe(true);
    // The model capability never substitutes for the mechanical executor
    // contract: the rebase-only scope still requires rebase-executor:1.
    expect(negotiation.rebaseExecutorGranted).toBe(false);
  });

  it("still refuses a rebase-only scope declared with only the model capability", () => {
    // The model capability is an EXTENSION of the mechanical lane, never a
    // replacement for it.
    expect(
      errorOf(`work_scope=${REBASE_ONLY_SCOPE}&work_scope_version=1&capabilities=${MODEL_DECLARATION}`),
    ).toBe("rebase-only intake requires the rebase-executor:1 capability declaration");
  });

  it("rejects the model capability at an unsupported version (fail closed)", () => {
    const negotiation = negotiationOf(`capabilities=${REBASE_MODEL_EXECUTOR_CAPABILITY}:2`);

    expect(negotiation.rebaseModelExecutorGranted).toBe(false);
    expect(negotiation.capabilities).toEqual([
      { name: REBASE_MODEL_EXECUTOR_CAPABILITY, requested: 2, granted: false, reason: "unsupported-version" },
    ]);
  });

  it("rejects a contradictory model-capability declaration", () => {
    expect(errorOf(`capabilities=${MODEL_DECLARATION},${REBASE_MODEL_EXECUTOR_CAPABILITY}:2`)).toBe(
      `Contradictory capability declaration for "${REBASE_MODEL_EXECUTOR_CAPABILITY}"`,
    );
  });

  it("reports the model capability verdict in the acknowledgment", () => {
    const ack = buildIntakeAck(
      negotiationOf(
        `capabilities=${REBASE_EXECUTOR_CAPABILITY}:${REBASE_EXECUTOR_CAPABILITY_VERSION},${MODEL_DECLARATION}`,
      ),
    );

    expect(ack.version).toBe(REBASE_INTAKE_CONTRACT_VERSION);
    expect(ack.capabilities).toEqual([
      { name: REBASE_EXECUTOR_CAPABILITY, requested: 1, granted: true },
      { name: REBASE_MODEL_EXECUTOR_CAPABILITY, requested: 1, granted: true },
    ]);
  });
});

describe("mixed-version negotiation contract (#1674)", () => {
  // The negotiation code is table-driven so BOTH release orders run through
  // the SAME function: `LEGACY_KNOWN_CAPABILITIES` is the knowledge set of a
  // pre-#1674 Dispatch (rebase-executor + pr-ownership-evidence only), and
  // these tests pin the exact verdicts an old server answers a new-Courier
  // declaration with — the wire shape new Courier must fail closed against.
  const NEW_COURIER_DECLARATION = `${REBASE_MODEL_EXECUTOR_CAPABILITY}:1`;

  it("NEW COURIER / OLD DISPATCH: the old server answers unknown-capability, not an error", () => {
    const verdict = negotiateCapabilityAgainst(LEGACY_KNOWN_CAPABILITIES, REBASE_MODEL_EXECUTOR_CAPABILITY, 1);

    expect(verdict).toEqual({
      name: REBASE_MODEL_EXECUTOR_CAPABILITY,
      requested: 1,
      granted: false,
      reason: "unknown-capability",
    });
  });

  it("NEW COURIER / OLD DISPATCH: the old server keeps its existing grants intact", () => {
    // The new declaration must not disturb the capabilities the old server
    // already negotiates: unknown names grant nothing and never broaden or
    // narrow the known verdicts.
    expect(negotiateCapabilityAgainst(LEGACY_KNOWN_CAPABILITIES, REBASE_EXECUTOR_CAPABILITY, REBASE_EXECUTOR_CAPABILITY_VERSION)).toEqual({
      name: REBASE_EXECUTOR_CAPABILITY,
      requested: REBASE_EXECUTOR_CAPABILITY_VERSION,
      granted: true,
    });
    expect(negotiateCapabilityAgainst(LEGACY_KNOWN_CAPABILITIES, PR_OWNERSHIP_EVIDENCE_CAPABILITY, PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION)).toEqual({
      name: PR_OWNERSHIP_EVIDENCE_CAPABILITY,
      requested: PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION,
      granted: true,
    });
  });

  it("NEW COURIER / OLD DISPATCH: the legacy poll of the new capability still parses as no-scope opted-in", () => {
    // An old Dispatch parses the new-Courier poll through the same
    // parseIntakeRequest shape: a capabilities-only declaration is opted in,
    // scopeless, and granted nothing it did not already grant — the request
    // is never failed and the queue is never broadened.
    const legacy = parseIntakeRequest(new URLSearchParams(`capabilities=${NEW_COURIER_DECLARATION}`));
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    // The negotiation granted the model capability on THIS server; the
    // mixed-order assertion is the verdict SHAPE the legacy table produces
    // (tested above) — the parse itself is identical in both releases.
    expect(legacy.negotiation.optedIn).toBe(true);
    expect(legacy.negotiation.scope).toBeNull();
    expect(legacy.negotiation.rebaseExecutorGranted).toBe(false);
    // And the legacy knowledge set grants nothing for the same declaration.
    expect(negotiateCapabilityAgainst(LEGACY_KNOWN_CAPABILITIES, REBASE_MODEL_EXECUTOR_CAPABILITY, 1).granted).toBe(false);
  });

  it("NEW DISPATCH / OLD COURIER: the old client's exact declaration stays fully granted", () => {
    // Old Courier sends exactly `rebase-executor:1,pr-ownership-evidence:1`
    // (no model capability). The new server must grant both and grant nothing
    // the old client did not declare.
    const negotiation = negotiationOf(
      `capabilities=${REBASE_EXECUTOR_CAPABILITY}:${REBASE_EXECUTOR_CAPABILITY_VERSION},${PR_OWNERSHIP_EVIDENCE_CAPABILITY}:${PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION}`,
    );

    expect(negotiation.rebaseExecutorGranted).toBe(true);
    expect(negotiation.prOwnershipEvidenceGranted).toBe(true);
    expect(negotiation.rebaseModelExecutorGranted).toBe(false);
    expect(negotiation.capabilities).toHaveLength(2);
  });

  it("NEW DISPATCH / OLD COURIER: a newer client declaration fails closed without breaking the poll", () => {
    // A Courier NEWER than this Dispatch (a future model capability version)
    // gets the fail-closed verdict, and the poll itself still succeeds.
    const negotiation = negotiationOf(`capabilities=${REBASE_MODEL_EXECUTOR_CAPABILITY}:2`);

    expect(negotiation.rebaseModelExecutorGranted).toBe(false);
    expect(negotiation.optedIn).toBe(true);
  });
});
