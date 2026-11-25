/**
 * #1532: the rebase-only intake contract.
 *
 * A worker client that can execute ONLY mechanical rebase work must be able
 * to poll and receive ONLY eligible REBASE work — never an ordinary PR fix,
 * never linked-PR repair, never issue implementation. The contract is
 * versioned and fails CLOSED: an unsupported scope, an unsupported scope
 * version, or a malformed capability declaration is refused (HTTP 400) before
 * any queue read, and an unknown capability — name OR version — grants
 * nothing and never broadens the queue.
 *
 * A capability declaration means "this client implements that client-side
 * execution contract". It is a PROOF the caller can execute the work, not a
 * request for it: the REBASE lane is mechanical (git is its tool surface), so
 * an allowlisted agent NAME alone does not prove the client can run it — a
 * new Dispatch paired with an old Courier would otherwise hand a rebase to a
 * client that never learned the contract.
 */

/** Version of the intake contract itself (the `intake.version` ack field). */
export const REBASE_INTAKE_CONTRACT_VERSION = 1;

/** The only work scope defined in contract version 1. */
export const REBASE_ONLY_SCOPE = "rebase-only";

/** The client-side execution capability the mechanical rebase lane requires. */
export const REBASE_EXECUTOR_CAPABILITY = "rebase-executor";

/** The supported version of the `rebase-executor` capability. */
export const REBASE_EXECUTOR_CAPABILITY_VERSION = 1;

/**
 * #1674: the model-assisted rebase execution capability. A client that
 * declares it claims the configured-model rebase executor contract
 * (misospace/courier#732): non-mechanical (semantic) conflicts are resolved
 * by the lane's ONE configured coordinator model, concurrency one, no
 * delegation, no silent cloud substitution — the deterministic rules stay
 * the fast path, and publication authority (existing approved branch,
 * `--force-with-lease`, expected-head lease) is unchanged.
 *
 * The declaration is negotiated, never inferred from a lane name or an agent
 * name: a grant requires the exact capability version below AND the
 * operator-declared model-worker pool (`DISPATCH_REBASE_MODEL_AGENTS`,
 * see `isRebaseModelLaneAgent`). A deterministic-only consumer (no grant)
 * never receives model-required work and keeps the mechanical instruction
 * wall; missing or ambiguous support fails closed with a clear disposition.
 *
 * It is declared ALONGSIDE `rebase-executor:1`, never instead of it: the
 * mechanical execution contract remains the base capability, and the model
 * assist is an authorized extension of that lane.
 */
export const REBASE_MODEL_EXECUTOR_CAPABILITY = "rebase-model-executor";

/** The supported version of the `rebase-model-executor` capability. */
export const REBASE_MODEL_EXECUTOR_CAPABILITY_VERSION = 1;

/**
 * #1569: the PR-fix ownership-evidence capability. A poll that declares and
 * is granted `pr-ownership-evidence:1` receives the versioned ownership
 * evidence block on every followup-pr task and can require it before
 * accepting a hand-out. Rows whose ownership is unresolved are refused at
 * issuance for declared consumers, so a negotiated peer never silently
 * receives work whose owning lane / original claimant it cannot see.
 * The constants are defined once in `pr-fix-ownership.ts` and re-exported
 * here so the negotiation and the payload cannot drift.
 */
export {
  PR_OWNERSHIP_EVIDENCE_CAPABILITY,
  PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION,
} from "@/lib/pr-fix-ownership";
import {
  PR_OWNERSHIP_EVIDENCE_CAPABILITY,
  PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION,
} from "@/lib/pr-fix-ownership";

/**
 * The only work-scope version defined in contract version 1. The scope
 * version is separate from the contract version: a scope version pins the
 * SHAPE of one scope, while the contract version pins the whole contract.
 */
const SUPPORTED_SCOPE_VERSION = "1";

/**
 * Bounded declaration size: a capability list is a short, fixed shape, so an
 * unbounded one is a malformed request rather than a negotiation.
 */
const MAX_CAPABILITIES_LENGTH = 512;
const MAX_CAPABILITIES = 16;

/**
 * Bound on the scope parameters. A scope id and a scope version are short
 * tokens, so a long value is a malformed request. The bound also keeps the
 * rejection message (which quotes the value) small.
 */
const MAX_SCOPE_LENGTH = 64;

/**
 * A capability token is `<name>:<version>`: a lowercase kebab-case name and
 * a positive integer version. The version is part of the token because the
 * capability CONTRACT is versioned — "rebase-executor:1" and
 * "rebase-executor:2" are different claims.
 */
const CAPABILITY_TOKEN = /^([a-z][a-z0-9-]*):([1-9][0-9]*)$/;

/** The work scopes a client may request (contract version 1: one). */
export type IntakeScope = "rebase-only";

/**
 * The verdict for one declared capability: whether Dispatch granted it, and
 * why not when it did not.
 */
export interface CapabilityNegotiation {
  name: string;
  requested: number;
  granted: boolean;
  /** Present only when `granted` is false. */
  reason?: "unsupported-version" | "unknown-capability";
}

/**
 * The versioned acknowledgment Dispatch returns for a client that opted into
 * the intake contract. A client that declared nothing gets no acknowledgment
 * at all — the ordinary response stays byte-identical.
 */
export interface IntakeAck {
  version: number;
  scope: IntakeScope | null;
  scopeEnforced: boolean;
  capabilities: CapabilityNegotiation[];
}

/** The negotiated intake state of one poll. */
export interface IntakeNegotiation {
  scope: IntakeScope | null;
  scopeEnforced: boolean;
  capabilities: CapabilityNegotiation[];
  /** Whether the client declared anything at all (a scope or a capability). */
  optedIn: boolean;
  /** Whether the `rebase-executor` v1 capability was declared AND granted. */
  rebaseExecutorGranted: boolean;
  /**
   * #1569: whether the `pr-ownership-evidence` v1 capability was declared
   * AND granted. A granted poll receives the versioned ownership evidence
   * block on followup-pr tasks, and unresolved-ownership rows are refused
   * to it at issuance.
   */
  prOwnershipEvidenceGranted: boolean;
  /**
   * #1674: whether the `rebase-model-executor` v1 capability was declared
   * AND granted. A granted poll is a candidate for model-assisted rebase
   * work: it may receive model-required REBASE items and its REBASE
   * hand-outs carry the model-assist contract, provided the agent is also
   * in the operator-declared model-worker pool (`DISPATCH_REBASE_MODEL_AGENTS`).
   * The negotiation alone never authorizes model execution.
   */
  rebaseModelExecutorGranted: boolean;
}

/**
 * The capability versions THIS deployment knows, keyed by capability name.
 * Adding a capability is additive: a poll that declares a name this table
 * lacks gets an `unknown-capability` verdict and grants nothing — which is
 * exactly what an older Dispatch answers a newer client, so the mixed-order
 * behavior is pinned by the same code path (`negotiateCapabilityAgainst`).
 */
const KNOWN_CAPABILITIES: Record<string, number> = {
  [REBASE_EXECUTOR_CAPABILITY]: REBASE_EXECUTOR_CAPABILITY_VERSION,
  [PR_OWNERSHIP_EVIDENCE_CAPABILITY]: PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION,
  [REBASE_MODEL_EXECUTOR_CAPABILITY]: REBASE_MODEL_EXECUTOR_CAPABILITY_VERSION,
};

/**
 * The capability knowledge set of the PREVIOUS release (through #1569), kept
 * as an exported constant so the mixed-version contract tests can drive the
 * SAME negotiation code an old Dispatch runs and pin its exact verdicts for
 * a new-Courier declaration (#1674). Never mutate this table.
 */
export const LEGACY_KNOWN_CAPABILITIES: Record<string, number> = {
  [REBASE_EXECUTOR_CAPABILITY]: REBASE_EXECUTOR_CAPABILITY_VERSION,
  [PR_OWNERSHIP_EVIDENCE_CAPABILITY]: PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION,
};

/**
 * The verdict for one declared capability against a knowledge set.
 *
 * - A known name at its exact supported version → granted.
 * - A known name at any other version → NOT granted (`unsupported-version`).
 *   Fail closed: an unknown capability version must never unlock REBASE
 *   work, and must never broaden the queue either.
 * - Any unknown name → NOT granted (`unknown-capability`). Forward
 *   compatibility: a newer client may declare capabilities this server does
 *   not know yet, and an unknown name is not an error — it simply grants
 *   nothing. This arm is precisely what an older Dispatch answers a newer
 *   client, which is why the knowledge set is a parameter.
 */
export function negotiateCapabilityAgainst(
  known: Record<string, number>,
  name: string,
  version: number,
): CapabilityNegotiation {
  const supported = known[name];
  if (supported === undefined) {
    return { name, requested: version, granted: false, reason: "unknown-capability" };
  }
  if (version !== supported) {
    return { name, requested: version, granted: false, reason: "unsupported-version" };
  }
  return { name, requested: version, granted: true };
}

/**
 * The verdict for one declared capability against THIS deployment's
 * knowledge set (see `negotiateCapabilityAgainst`).
 */
function negotiateCapability(name: string, version: number): CapabilityNegotiation {
  return negotiateCapabilityAgainst(KNOWN_CAPABILITIES, name, version);
}

/**
 * Parse the intake parameters of a poll request.
 *
 * Returns the negotiated intake state, or a human-readable error the caller
 * turns into HTTP 400. Every rejection is fail closed: a malformed or
 * unsupported declaration is NEVER read as "no contract declared", because
 * that would silently widen the queue for a client that asked for a narrower
 * one.
 */
export function parseIntakeRequest(
  params: URLSearchParams,
): { ok: true; negotiation: IntakeNegotiation } | { ok: false; error: string } {
  const scopeParam = params.get("work_scope");
  const versionParam = params.get("work_scope_version");
  // Repeated `capabilities` parameters are joined, so a client cannot smuggle
  // entries past the size limit by splitting the declaration.
  const rawCapabilities = params.getAll("capabilities").join(",");

  // A repeated scope parameter is ambiguous: two values cannot both be the
  // scope, and taking the first would let a request hide an unsupported value
  // behind a supported one. The sibling exclusion contract in this route
  // refuses a repeated version parameter for the same reason.
  if (params.getAll("work_scope").length > 1) {
    return { ok: false, error: "Repeated work_scope" };
  }
  if (params.getAll("work_scope_version").length > 1) {
    return { ok: false, error: "Repeated work_scope_version" };
  }
  if (scopeParam !== null && scopeParam.length > MAX_SCOPE_LENGTH) {
    return { ok: false, error: `work_scope exceeds the size limit (${MAX_SCOPE_LENGTH} characters)` };
  }
  if (versionParam !== null && versionParam.length > MAX_SCOPE_LENGTH) {
    return { ok: false, error: `work_scope_version exceeds the size limit (${MAX_SCOPE_LENGTH} characters)` };
  }
  if (scopeParam !== null && scopeParam !== REBASE_ONLY_SCOPE) {
    return { ok: false, error: `Unsupported work_scope "${scopeParam}"; supported: ${REBASE_ONLY_SCOPE}` };
  }
  if (versionParam !== null && scopeParam === null) {
    return { ok: false, error: "work_scope_version requires work_scope" };
  }
  if (scopeParam !== null && versionParam === null) {
    return { ok: false, error: "work_scope requires work_scope_version" };
  }
  if (versionParam !== null && versionParam !== SUPPORTED_SCOPE_VERSION) {
    return { ok: false, error: `Unsupported work_scope_version "${versionParam}"; supported: ${SUPPORTED_SCOPE_VERSION}` };
  }

  const capabilities: CapabilityNegotiation[] = [];
  const declared = new Set<string>();
  // An empty declaration is no declaration (a client that sends nothing
  // declares nothing); anything else must be a well-formed token list.
  if (rawCapabilities.trim() !== "") {
    if (rawCapabilities.length > MAX_CAPABILITIES_LENGTH) {
      return { ok: false, error: "capabilities declaration exceeds the size limit" };
    }
    const tokens = rawCapabilities
      .split(",")
      .map((token) => token.trim())
      // An empty element is not a declaration: a client that appends the
      // parameter unconditionally (`&capabilities=${caps}` with an empty
      // value) must not be refused for a token it never sent. A token that is
      // present but malformed is still refused.
      .filter((token) => token !== "");
    if (tokens.length > MAX_CAPABILITIES) {
      return { ok: false, error: "capabilities declaration exceeds the size limit" };
    }
    for (const token of tokens) {
      const match = CAPABILITY_TOKEN.exec(token);
      if (!match) {
        return { ok: false, error: `Malformed capabilities entry "${token}"` };
      }
      const name = match[1];
      const version = Number(match[2]);
      if (declared.has(name)) {
        // Two declarations of the same name are contradictory even when the
        // versions agree: the client cannot mean two contracts at once.
        return { ok: false, error: `Contradictory capability declaration for "${name}"` };
      }
      declared.add(name);
      capabilities.push(negotiateCapability(name, version));
    }
  }

  const scope: IntakeScope | null = scopeParam === REBASE_ONLY_SCOPE ? REBASE_ONLY_SCOPE : null;
  const rebaseExecutor = capabilities.find((capability) => capability.name === REBASE_EXECUTOR_CAPABILITY);
  if (scope === REBASE_ONLY_SCOPE) {
    // The rebase-only scope is a CLAIM about the client's execution
    // capability. Without the granted capability the claim cannot be
    // honored, and honoring it anyway would serve mechanical work to a
    // client that never declared it can execute it.
    if (!rebaseExecutor) {
      return {
        ok: false,
        error: `rebase-only intake requires the ${REBASE_EXECUTOR_CAPABILITY}:${REBASE_EXECUTOR_CAPABILITY_VERSION} capability declaration`,
      };
    }
    if (!rebaseExecutor.granted) {
      return {
        ok: false,
        error: `rebase-only intake requires a supported rebase-executor capability (v${REBASE_EXECUTOR_CAPABILITY_VERSION}); requested v${rebaseExecutor.requested} is unsupported`,
      };
    }
  }

  // Contract version 1 defines exactly one scope, and it is always enforced
  // when requested, so the flag is unconditionally true: a poll that declares
  // no scope has nothing to enforce, and a poll that declares rebase-only
  // never runs the unrestricted queue. The flag exists so a client can tell
  // "scope honored" from "scope declared but not enforceable" without a
  // contract version bump.
  const scopeEnforced = true;

  return {
    ok: true,
    negotiation: {
      scope,
      scopeEnforced,
      capabilities,
      optedIn: scope !== null || capabilities.length > 0,
      rebaseExecutorGranted: rebaseExecutor?.granted === true,
      prOwnershipEvidenceGranted:
        capabilities.find((capability) => capability.name === PR_OWNERSHIP_EVIDENCE_CAPABILITY)?.granted === true,
      rebaseModelExecutorGranted:
        capabilities.find((capability) => capability.name === REBASE_MODEL_EXECUTOR_CAPABILITY)?.granted === true,
    },
  };
}

/**
 * Build the versioned acknowledgment for a negotiated intake state. The
 * acknowledgment is what makes the contract observable: a client can see
 * which scope was honored and which capabilities were granted.
 */
export function buildIntakeAck(negotiation: IntakeNegotiation): IntakeAck {
  return {
    version: REBASE_INTAKE_CONTRACT_VERSION,
    scope: negotiation.scope,
    scopeEnforced: negotiation.scopeEnforced,
    capabilities: negotiation.capabilities,
  };
}
