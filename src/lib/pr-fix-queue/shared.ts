import { normalizePrFixOutcome, PrFixDecisionContext, PrFixOutcome, PrFixStatus } from "@/types";

// #1121: upper bound on an already_addressed evidence string, shared by the
// tasks/report route and the pr-fix-queue/mark parser.
export const MAX_EVIDENCE_LENGTH = 2000;

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The structured outcome a status implies (#1218). BLOCKED is reserved for a
 * genuine human decision; PARKED carries the explicit outcome or `no_progress`.
 * Any other status has no outcome.
 */
export function resolvePrFixOutcome(status: PrFixStatus, explicit?: string | null): PrFixOutcome | null {
  if (status === "BLOCKED") return "human_decision";
  if (status === "PARKED") return normalizePrFixOutcome(explicit) ?? "no_progress";
  return null;
}

/**
 * Validate and normalize a `decision` payload (#1218). Returns the cleaned
 * context, `null` when absent, or an error string when malformed.
 */
export function parseDecisionContext(value: unknown): { decision: PrFixDecisionContext | null; error?: string } {
  if (value === undefined || value === null) return { decision: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { decision: null, error: "decision must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const decision: PrFixDecisionContext = {};
  if (raw.question !== undefined && raw.question !== null) {
    if (typeof raw.question !== "string") return { decision: null, error: "decision.question must be a string" };
    if (raw.question.trim()) decision.question = raw.question.trim();
  }
  if (raw.options !== undefined && raw.options !== null) {
    if (!Array.isArray(raw.options) || raw.options.some((o) => typeof o !== "string")) {
      return { decision: null, error: "decision.options must be an array of strings" };
    }
    const options = raw.options.map((o) => (o as string).trim()).filter(Boolean);
    if (options.length > 0) decision.options = options;
  }
  if (raw.evidence !== undefined && raw.evidence !== null) {
    if (typeof raw.evidence !== "string") return { decision: null, error: "decision.evidence must be a string" };
    if (raw.evidence.trim()) decision.evidence = raw.evidence.trim();
  }
  return { decision };
}

/**
 * Canonical queue identity for a repository (#1145).
 *
 * GitHub treats `owner/repo` case-insensitively, but the `(repo, pr)` unique
 * key does not. A row written as `Org/Repo` and a lookup for `org/repo` are
 * different records, so two rows could own the same PR — one of them `BLOCKED`
 * — and the second would shadow the human verdict. Every queue write and every
 * identity lookup folds the repo through this so the key is stable regardless
 * of the casing the caller derived it from (GitHub payload, issue cache, or a
 * hand-written API call).
 */
export function normalizeQueueRepo(repo: string): string {
  return repo.trim().toLowerCase();
}

// ─── Escalation-lane exclusivity (#1503) ────────────────────────────────────

export function uniqueAppend(values: string[], value: string, maxItems: number): string[] {
  const next = values.includes(value) ? values : [...values, value];
  return next.slice(-maxItems);
}

// ─── Durable evidence ledger helpers (#1249) ────────────────────────────────

/**
 * Normalize a forge-side event timestamp for audit storage. Malformed values
 * store NULL rather than throwing: provenance is audit data and must never
 * block an enqueue.
 */
export function parseEvidenceObservedAt(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Build a Prisma update patch from enqueue input.
 * `issue` maps to Prisma PrFixQueueItem.issue (Int?) which stores the linked GitHub issue number.
 */
export function laneLabel(lane: string | null | undefined): string {
  if (!lane) return "unknown";
  const normalized = lane.trim().toUpperCase();
  return normalized || "unknown";
}

/**
 * How long a stamped hand-out may sit unacknowledged before the reclaimer
 * treats it as abandoned (#1211). A worker that durably materialized its
 * attempt acknowledges it; a stamped hand-out with no ack past this window
 * means the executor likely died before creating its run. Overridable via
 * PR_FIX_HANDOUT_TIMEOUT_MS; defaults to 30 minutes.
 */
export const DEFAULT_PR_FIX_HANDOUT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Bound on automatic reclamations of a stale unacknowledged hand-out (#1211).
 * Each reclaim reopens the item as a fresh generation; past this cap the item
 * is routed to a human instead of being reclaimed again. Overridable via
 * PR_FIX_MAX_RECLAIMS; defaults to 3.
 */
export const DEFAULT_PR_FIX_MAX_RECLAIMS = 3;

export function prFixHandoutTimeoutMs(): number {
  const n = Number(process.env.PR_FIX_HANDOUT_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PR_FIX_HANDOUT_TIMEOUT_MS;
}

export function maxPrFixReclaims(): number {
  const n = Number(process.env.PR_FIX_MAX_RECLAIMS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PR_FIX_MAX_RECLAIMS;
}

/**
 * How long an ACKNOWLEDGED hand-out remains authoritative without fresh
 * liveness evidence (#1419). Past this window, an acked generation whose
 * owning agent shows no recent activity and no open associated run is
 * reclaimable like an unacknowledged one. Deliberately far longer than the
 * unacknowledged hand-out timeout: a live model run can take hours, and
 * reclaiming it would duplicate execution the ack was written to protect.
 * Overridable via PR_FIX_ACK_LIVENESS_MS; defaults to 24 hours.
 */
export const DEFAULT_PR_FIX_ACK_LIVENESS_MS = 24 * 60 * 60 * 1000;

export function prFixAckLivenessMs(): number {
  const n = Number(process.env.PR_FIX_ACK_LIVENESS_MS);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_PR_FIX_ACK_LIVENESS_MS;
  // Clamped like every sibling knob (#1419 review): a value below 1h makes
  // every acked generation near-immediately reclaimable (and shrinks the
  // agent-activity evidence horizon with it), and a value above 7d strands
  // dead-acked items longer than the recovery is worth.
  return Math.min(Math.max(n, 60 * 60 * 1000), 7 * 24 * 60 * 60 * 1000);
}

/** Current wall-clock as an ISO string, injectable in tests via options.now. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
