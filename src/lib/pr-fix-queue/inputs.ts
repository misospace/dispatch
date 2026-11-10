import { normalizePrFixOutcome, normalizePrFixStatus, PrFixDecisionContext, PrFixLane, PrFixStatus } from "@/types";
import { MAX_EVIDENCE_LENGTH, nonEmpty, parseDecisionContext, resolvePrFixOutcome } from "./shared";

export function alreadyAddressedHistoryNote(input: MarkPrFixInput): string {
  const evidence = input.evidence?.trim();
  return [
    input.note ?? null,
    evidence ? `Evidence: ${evidence}` : null,
    evidence
      ? "Settled as already_addressed: the PR head may be unchanged; the evidence is recorded for the next review (#1121)."
      : "Settled as already_addressed: the PR head may be unchanged; no new push was expected (#1121).",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface EnqueuePrFixInput {
  repo: string;
  pr: number;
  lane?: string | null;
  type?: string | null;
  reason: string;
  feedback: string;
  evidenceKey: string;
  issue?: number | null;
  branch?: string | null;
  /** Item identity — should be the PR URL. Set at first enqueue, only backfilled while empty (#1098). */
  url?: string | null;
  title?: string | null;
  headSha?: string | null;
  author?: string | null;
  /**
   * Structured outcome (#1218). Only meaningful when the enqueue resolves to a
   * PARKED state (e.g. an explicit infra/security failure); a BLOCKED result
   * always records `human_decision`. Defaults to `no_progress` for PARKED.
   */
  outcome?: string | null;
  /** Human-decision payload persisted on a BLOCKED result (#1218). */
  decision?: PrFixDecisionContext | null;
  /**
   * Durable evidence-snapshot fields (#1249). When `evidenceKey` carries these,
   * the enqueue records a versioned transition in the item's durable evidence
   * ledger (one row per identity), and the ledger — not the bounded 40-entry
   * `evidenceKeys` cache — decides whether the observation is known evidence.
   * All optional: legacy callers keep the pre-#1249 identity-only behavior.
   * Build these with the pure helpers in `pr-fix-evidence.ts`.
   */
  /** One of `PrFixEvidenceKind` ("review", "check_run", ...). Unknown kinds
   * are recorded for audit and never treated as fresh work. */
  evidenceKind?: string | null;
  /** Canonical version of the identity's state-bearing fields
   * (`computeEvidenceVersion`). A change is a ledger transition. */
  evidenceVersion?: string | null;
  /** Bounded anti-repetition signature (`computeEvidenceContentSignature`).
   * A new identity whose signature already exists in the ledger at the same
   * commit is recorded but not treated as new evidence. */
  evidenceContentSignature?: string | null;
  /** Forge-side event timestamp (review submitted_at, comment updated_at,
   * check completed_at). Audit provenance ONLY — never a freshness boundary. */
  evidenceObservedAt?: Date | string | null;
  /** Whether the observation's CURRENT version is actionable by kind
   * (`isActionableEvidenceVersion`). Unknown provenance defers, never
   * silently resolves. */
  evidenceActionable?: boolean | null;
  /** Head the observation was taken against (ledger row's head; entries
   * re-encoded for settlement use it). */
  evidenceHeadSha?: string | null;
  /** Ingestion source label recorded on the ledger row for audit
   * ("webhook" | "sync" | ...). */
  evidenceSource?: string | null;
}

export interface CreateLinkedPrFixInput {
  repo: string;
  pr: number;
  issue: number;
  lane: PrFixLane;
  reason: string;
  feedback: string[];
  /**
   * Queue type for the materialized row (#1327). Absent/null writes the
   * ordinary fix lane (OTHER); "REBASE" routes a conflicted PR into the
   * mechanical rebase lane, whose contract the caller supplies in `feedback`.
   */
  type?: string | null;
  evidenceKey: string;
  url?: string | null;
  title?: string | null;
  /**
   * Head observed when the linked follow-up was discovered (#1074). Stored as
   * both the mutable `headSha` and the immutable per-attempt `attemptHeadSha`
   * so the #940 no-progress guard can refuse a FIXED tombstone for a worker
   * that pushed nothing. Null when GitHub could not be read.
   */
  headSha?: string | null;
}

export interface MarkPrFixInput {
  repo: string;
  pr: number;
  status: string;
  note?: string | null;
  // #1250: structured external-wait contract, REQUIRED for a new
  // WAITING_EXTERNAL mark. Absent or malformed → fail-closed PARKED
  // (outcome `invalid_wait`), generation-pinned.
  externalWait?: unknown;
  // Commit-time revalidation (#1074): when provided, every status write goes
  // through `updateMany({ where: { id, generation } })` and the mark is
  // skipped (no mutation) if the row's generation no longer matches — i.e.
  // the attempt was re-issued (new evidence, requeue) between read and write.
  expectedGeneration?: number | null;
  // Fresh per-attempt head baseline carried into the row when this mark bumps
  // the item back to QUEUED as a new attempt (#1074).
  attemptHeadSha?: string | null;
  // #1121: an explicit "already addressed" settlement. When true (and status is
  // FIXED), the #940 no-progress head-moved guard is bypassed and `evidence` is
  // recorded in the settlement history: the worker asserts the feedback was
  // already handled, so no new push is expected. New evidence still reopens the
  // item; a repeated disagreement reopens via #940 and consumes the
  // consecutive-stagnation budget (#1543).
  alreadyAddressed?: boolean;
  evidence?: string | null;
  /**
   * Structured outcome (#1218) for a BLOCKED/PARKED mark. BLOCKED defaults to
   * `human_decision`; PARKED defaults to `no_progress`. Ignored for other
   * statuses.
   */
  outcome?: string | null;
  /** Human-decision payload persisted when the mark resolves to BLOCKED (#1218). */
  decision?: PrFixDecisionContext | null;
  /**
   * Caller's auth tier (#1218 review): used to gate the BLOCKED/PARKED status
   * pin at commit time. A worker-tier mark to BLOCKED/PARKED on an already
   * recorded BLOCKED/PARKED/FIXED row must no-op (return `generation-mismatch`)
   * so a same-generation second mark cannot erase a genuine human decision —
   * with one exception (#1340): a worker-tier BLOCKED mark may escalate a
   * same-generation PARKED row to BLOCKED (bounded exhaustion that turned out
   * to need a human decision); a recorded BLOCKED stays sticky against every
   * other worker mark, and de-escalation (BLOCKED → PARKED/QUEUED) remains
   * operator-only via `allowStickyReclassify`.
   * Defaults to `"worker"` (fail-closed): callers that don't explicitly assert
   * a maintainer tier cannot bypass the pin. The route handler is the only
   * trusted source of this value — `parseMarkPrFixInput` does not accept it
   * from a request body, so a worker cannot forge a maintainer tier.
   */
  actorTier?: "worker" | "maintainer";
  /**
   * Explicit reclassification opt-in (#1218 review). When `true` AND
   * `actorTier === "maintainer"`, the BLOCKED/PARKED status pin is relaxed
   * for a single mark so an operator can correct a recorded classification
   * (BLOCKED → PARKED for an outdated decision, or vice versa). Honored only
   * for non-worker callers; a worker request that sets this is silently
   * ignored (fail-closed). Intended for explicit operator reclassification —
   * it is NEVER the path used by routine worker settlement, which always
   * settles QUEUED → BLOCKED/PARKED.
   */
  allowStickyReclassify?: boolean;
  /**
   * Hand-out binding for worker-tier settlements (#1428). When set, the mark
   * is authorized ONLY for rows whose `agentHandouts` carry this agent's
   * marker at the settled generation (the same `<agentName>@<generation>`
   * envelope `agentAlreadyHanded`/`ackPrFixHandout` match): a bound worker
   * credential may settle only the attempt it was handed, never another
   * agent's. A row without the marker returns `not-handed` — a refusal
   * distinct from the row's outcome vocabulary, with no mutation. The route
   * handler is the only trusted source of this value (the bound token's
   * agent identity); `parseMarkPrFixInput` never accepts it from a body.
   * Unset (maintainer/operator paths and internal report settlement) keeps
   * the existing unconstrained behavior.
   */
  handoutScopedAgent?: string;
}

export interface RequeuePrFixInput {
  repo: string;
  pr: number;
  note?: string | null;
  isPrMergedOrClosed?: boolean;
  isRepoArchived?: boolean;
}

export function parseEnqueuePrFixInput(body: unknown): EnqueuePrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  if (!nonEmpty(input.reason)) return { error: "Missing required field: reason" };
  if (!nonEmpty(input.feedback)) return { error: "Missing required field: feedback" };
  if (!nonEmpty(input.evidenceKey)) return { error: "Missing required field: evidenceKey" };
  if (input.outcome !== undefined && input.outcome !== null) {
    if (typeof input.outcome !== "string" || !normalizePrFixOutcome(input.outcome)) {
      return { error: "Invalid outcome" };
    }
  }
  const decisionResult = parseDecisionContext(input.decision);
  if (decisionResult.error) return { error: decisionResult.error };

  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    lane: typeof input.lane === "string" ? input.lane : undefined,
    type: typeof input.type === "string" ? input.type : undefined,
    reason: input.reason.trim(),
    feedback: input.feedback.trim(),
    evidenceKey: input.evidenceKey.trim(),
    issue: input.issue === undefined || input.issue === null ? null : Number(input.issue),
    branch: typeof input.branch === "string" ? input.branch : null,
    url: typeof input.url === "string" ? input.url : null,
    title: typeof input.title === "string" ? input.title : null,
    headSha: typeof input.headSha === "string" ? input.headSha : null,
    author: typeof input.author === "string" ? input.author : null,
    ...(typeof input.outcome === "string" ? { outcome: normalizePrFixOutcome(input.outcome) } : {}),
    ...(decisionResult.decision ? { decision: decisionResult.decision } : {}),
  };
}

export function parseMarkPrFixInput(body: unknown): MarkPrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  if (!nonEmpty(input.status)) return { error: "Missing required field: status" };
  if (!normalizePrFixStatus(input.status)) return { error: "Invalid status" };
  if (input.generation !== undefined && input.generation !== null) {
    if (typeof input.generation !== "number" || !Number.isInteger(input.generation) || input.generation < 1) {
      return { error: "generation must be an integer >= 1" };
    }
  }
  if (input.attemptHeadSha !== undefined && input.attemptHeadSha !== null) {
    if (typeof input.attemptHeadSha !== "string" || !/^[0-9a-fA-F]{7,40}$/.test(input.attemptHeadSha.trim())) {
      return { error: "Invalid attemptHeadSha" };
    }
  }
  if (input.alreadyAddressed !== undefined && typeof input.alreadyAddressed !== "boolean") {
    return { error: "alreadyAddressed must be a boolean" };
  }
  const alreadyAddressed = input.alreadyAddressed === true;
  if (alreadyAddressed && normalizePrFixStatus(input.status) !== "FIXED") {
    return { error: "alreadyAddressed requires status FIXED" };
  }
  if (input.evidence !== undefined && input.evidence !== null && typeof input.evidence !== "string") {
    return { error: "evidence must be a string" };
  }
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : null;
  if (evidence && evidence.length > MAX_EVIDENCE_LENGTH) {
    return { error: `evidence must be at most ${MAX_EVIDENCE_LENGTH} characters` };
  }
  const status = normalizePrFixStatus(input.status) as PrFixStatus;
  if (input.outcome !== undefined && input.outcome !== null) {
    if (typeof input.outcome !== "string" || !normalizePrFixOutcome(input.outcome)) {
      return { error: "Invalid outcome" };
    }
  }
  const decisionResult = parseDecisionContext(input.decision);
  if (decisionResult.error) return { error: decisionResult.error };
  const explicitOutcome = typeof input.outcome === "string" ? normalizePrFixOutcome(input.outcome) : null;
  const outcome = resolvePrFixOutcome(status, explicitOutcome);
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    status,
    note: typeof input.note === "string" ? input.note : null,
    expectedGeneration:
      typeof input.generation === "number" && input.generation !== null ? input.generation : undefined,
    attemptHeadSha: typeof input.attemptHeadSha === "string" ? input.attemptHeadSha.trim() : null,
    ...(alreadyAddressed ? { alreadyAddressed: true } : {}),
    ...(evidence ? { evidence } : {}),
    ...(outcome ? { outcome } : {}),
    ...(decisionResult.decision ? { decision: decisionResult.decision } : {}),
    // #1250: validated again at mark time; parse here only to reject a
    // structurally impossible body early with a clear error.
    ...(input.externalWait !== undefined ? { externalWait: input.externalWait } : {}),
  };
}

/**
 * Acknowledgement of a PR-fix hand-out (#1211). A worker calls this after it
 * has durably materialized its attempt (e.g. created the executor run that
 * owns the work), so the reclaimer knows the stamped hand-out was not lost.
 */
export interface AckPrFixHandoutInput {
  repo: string;
  pr: number;
  generation: number;
  agentName: string;
}

export type AckPrFixHandoutResult =
  | { acknowledged: true; item: any }
  | {
      acknowledged: false;
      reason:
        | "not-found"
        | "generation-mismatch"
        | "not-queued"
        | "already-acknowledged"
        | "not-stamped"
        | "not-handed";
    };

export function parseAckPrFixHandoutInput(body: unknown): AckPrFixHandoutInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) {
    return { error: "Missing required field: pr" };
  }
  if (
    input.generation === undefined ||
    input.generation === null ||
    typeof input.generation !== "number" ||
    !Number.isInteger(input.generation) ||
    input.generation < 1
  ) {
    return { error: "generation must be an integer >= 1" };
  }
  // agentName is required (#1211 review, reframed by #1425): it is the
  // subject of the ack, supplied by the caller's transport (the MCP client
  // and Courier's dispatch adapter both forward it). The route layer gates
  // WHO may ack for it — a worker-tier bearer must be bound to this agent,
  // the legacy unbound token is refused — and this lib pins the ack to a
  // hand-out actually issued to (agentName, generation). The route rejects
  // basic / oidc callers entirely.
  // Type check first so a non-string value (e.g. 7) surfaces as the type
  // error, not as "Missing required field" (nonEmpty is type-agnostic).
  if (input.agentName !== undefined && input.agentName !== null && typeof input.agentName !== "string") {
    return { error: "agentName must be a string" };
  }
  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName" };
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    generation: input.generation,
    agentName: (input.agentName as string).trim(),
  };
}

export function parseRequeuePrFixInput(body: unknown): RequeuePrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    note: typeof input.note === "string" ? input.note : null,
    isPrMergedOrClosed: input.isPrMergedOrClosed === true,
  };
}
