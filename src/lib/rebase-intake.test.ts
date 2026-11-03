import { describe, expect, it } from "vitest";
import {
  buildIntakeAck,
  parseIntakeRequest,
  REBASE_EXECUTOR_CAPABILITY,
  REBASE_EXECUTOR_CAPABILITY_VERSION,
  REBASE_INTAKE_CONTRACT_VERSION,
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
